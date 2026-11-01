import { NextRequest } from 'next/server';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { configManager } from '@/lib/admin/config-manager';

class ConnectorError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

function failure(error: unknown) {
  if (error instanceof ConnectorError)
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { 'Cache-Control': 'no-store' } });
  return Response.json({ error: { code: 'office_unavailable', message: 'EuroOffice 연결을 확인하지 못했습니다.' } }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
}

/** Use an operator-selected gateway, never an iframe URL or a browser-provided upstream.
 * iframe 주소·브라우저 입력 대신 운영자가 지정한 게이트웨이만 사용합니다. */
async function gatewayOrigin() {
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled)
    throw new ConnectorError('office_disabled', 403, '관리자가 추가기능을 비활성화했습니다.');
  const value = process.env.EUROOFFICE_GATEWAY_URL;
  if (!value) throw new ConnectorError('office_not_configured', 404, '설치 관리자가 EuroOffice 게이트웨이 주소를 등록해야 합니다.');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new ConnectorError('office_configuration', 503, 'EuroOffice 게이트웨이는 HTTPS 출처로 설정해야 합니다.');
  return url.origin;
}

/** An absent or malformed selector must never enumerate another account's cookies.
 * 선택자가 없거나 잘못됐을 때 다른 계정의 쿠키를 순회하지 않습니다. */
function cookieSlot(value: string | null) {
  if (!value || !/^(0|[1-9]\d*)$/.test(value) || Number(value) >= MAX_ACCOUNT_SLOTS)
    throw new ConnectorError('account_required', 400, '현재 웹메일 계정 슬롯이 필요합니다.');
  return Number(value);
}

async function selectedCredential(request: NextRequest, slot: number) {
  const headers = new Headers(request.headers);
  headers.set('X-JMAP-Cookie-Slot', String(slot));
  const credentials = await getStalwartCredentials(new NextRequest(request.url, { headers }));
  if (!credentials) throw new ConnectorError('unauthenticated', 401, '현재 웹메일 계정으로 다시 로그인해 주세요.');
  if (!credentials.trusted) throw new ConnectorError('native_server_required', 403, '설치에 등록된 Native 파일 서버 계정이 필요합니다.');
  return credentials;
}

/** Preserve only application/range headers; mail credentials and account scope are server-owned.
 * 앱·범위 헤더만 유지하고 메일 자격증명·계정 범위는 서버에서 결정합니다. */
function forwardedHeaders(request: NextRequest) {
  const headers = new Headers();
  for (const name of ['Content-Type', 'Range', 'If-Range', 'X-Office-Workspace', 'X-Office-Filename', 'X-Office-Parent', 'X-Office-Request', 'X-Office-Content-Sha256']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/** Bound connection setup while letting streaming bodies follow the browser's cancellation.
 * 연결 시작은 제한하고 스트리밍 본문은 브라우저 취소를 따르게 합니다. */
async function send(request: NextRequest, target: URL, headers: Headers) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 120_000);
  try {
    const options = { method: request.method, headers, body: request.body, redirect: 'manual' as const, cache: 'no-store' as const, signal: AbortSignal.any([request.signal, controller.signal]), duplex: 'half' as const };
    const response = await fetch(target, options);
    if (response.status >= 300 && response.status < 400)
      throw new ConnectorError('office_redirect_refused', 502, '인증 요청의 리다이렉트를 따르지 않습니다.');
    const output = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    for (const name of ['Content-Type', 'Content-Length', 'Content-Range', 'Content-Disposition', 'Accept-Ranges', 'ETag', 'Content-Security-Policy']) {
      const value = response.headers.get(name);
      if (value !== null) output.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers: output });
  } finally { clearTimeout(deadline); }
}

function clientOrigin(request: NextRequest) {
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host;
  const protocol = request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '');
  return new URL(`${protocol}://${host}`).origin;
}

/** Forward the current Native identity on every call; no Office cookie is accepted or relayed.
 * 모든 호출에서 현재 Native 주체를 전달하며 Office 쿠키는 수용·중계하지 않습니다. */
export async function officeSettings(request: NextRequest): Promise<Response> {
  try {
    const crossOrigin = rejectCrossOriginRequest(request);
    if (crossOrigin) return crossOrigin;
    const slot = cookieSlot(request.headers.get('X-JMAP-Cookie-Slot'));
    const credentials = await selectedCredential(request, slot);
    const origin = await gatewayOrigin();
    const headers = forwardedHeaders(request);
    const subject = request.headers.get('X-Office-Expected-Subject');
    if (!subject || subject.length > 8192) throw new ConnectorError('account_required', 400, '현재 JMAP 세션의 인증 주체가 필요합니다.');
    if (request.headers.get('X-Office-Expected-Origin') !== new URL(credentials.serverUrl).origin)
      throw new ConnectorError('account_changed', 409, '현재 JMAP 세션과 호스트 쿠키의 Native 출처가 다릅니다.');
    headers.set('X-Office-Expected-Subject', subject);
    headers.set('Authorization', credentials.authHeader);
    headers.set('X-Office-Native-Origin', new URL(credentials.serverUrl).origin);
    headers.set('Origin', origin);
    const expected = request.headers.get('X-Office-Account');
    if (expected) headers.set('X-Office-Account', expected);
    return await send(request, new URL('/api/v1/eurooffice/host', origin), headers);
  } catch (error) { return failure(error); }
}

function admittedPath(path: string[], method: string) {
  if (path.some((part) => !part || part === '.' || part === '..' || /[\\/\0%]/.test(part))) return false;
  const value = '/' + path.join('/');
  if (!path.length) return method === 'GET';
  if (/^\/api\/v1\/eurooffice\/assets\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?$/.test(value)) return method === 'GET';
  if (/^\/api\/v1\/eurooffice\/workspace\/(rpc|upload)$/.test(value)) return method === 'POST';
  if (/^\/api\/v1\/eurooffice\/workspace\/(file|content|download)\/[^/]+$/.test(value)) return method === 'GET' || method === 'HEAD';
  if (/^\/api\/v1\/eurooffice\/workspace\/text\/[^/]+$/.test(value)) return method === 'GET' || method === 'PUT';
  return /^\/api\/v1\/eurooffice\/workspace\/text\/[^/]+\/reconcile$/.test(value) && method === 'POST';
}

/** Serve a same-origin, account-bound app without making the standalone app depend on a private SDK.
 * 단독 앱을 사설 SDK에 묶지 않고 동일 출처·계정 결합 앱을 제공합니다. */
export async function officeProxy(request: NextRequest, scope: { slot: string; owner: string; path: string[] }): Promise<Response> {
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(scope.owner) || !admittedPath(scope.path, request.method))
      throw new ConnectorError('office_path_refused', 403, '허용된 EuroOffice 앱 경로가 아닙니다.');
    const crossOrigin = rejectCrossOriginRequest(request);
    if (crossOrigin) return crossOrigin;
    const slot = cookieSlot(scope.slot);
    const credentials = await selectedCredential(request, slot);
    const origin = await gatewayOrigin();
    const headers = forwardedHeaders(request);
    headers.set('Authorization', credentials.authHeader);
    headers.set('X-Office-Account', scope.owner);
    headers.set('X-Office-Native-Origin', new URL(credentials.serverUrl).origin);
    headers.set('Origin', origin);
    headers.set('X-Office-Proxy-Base', `${clientOrigin(request)}${request.nextUrl.basePath}/api/eurooffice/view/${slot}/${scope.owner}`);
    let path = '/' + scope.path.map(encodeURIComponent).join('/');
    if (!scope.path.length) path = '/embedded';
    const target = new URL(path, origin);
    target.search = request.nextUrl.search;
    return await send(request, target, headers);
  } catch (error) { return failure(error); }
}
