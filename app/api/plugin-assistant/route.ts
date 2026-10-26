import { createHmac } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

type RelayInput = { path: string; method: string; body?: unknown };

/** Follow bounded discovery redirects only within the verified native origin.
 * 검증한 네이티브 출처 안에서만 제한된 탐색 리다이렉트를 따릅니다. */
async function nativeSession(serverUrl: string, authHeader: string): Promise<Response> {
  const origin = new URL(serverUrl).origin;
  const signal = AbortSignal.timeout(15000);
  let current = new URL(`${serverUrl}/.well-known/jmap`);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(current.toString(), { headers: { Authorization: authHeader }, redirect: 'manual', signal });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('native_discovery_location_missing');
    const next = new URL(location, current);
    if (next.origin !== origin || next.username || next.password) throw new Error('native_discovery_origin_changed');
    current = next;
  }
  throw new Error('native_discovery_redirect_limit');
}

/** Validate the relay envelope without trusting JSON casts or client identity fields.
 * JSON 형 변환이나 클라이언트 계정 필드를 신뢰하지 않고 중계 입력을 검증합니다. */
function readRelayInput(raw: string): RelayInput | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (!('path' in value) || typeof value.path !== 'string') return null;
    if (!('method' in value) || typeof value.method !== 'string') return null;
    const input: RelayInput = { path: value.path, method: value.method };
    if ('body' in value) input.body = value.body;
    if (input.method === 'GET' && input.body !== undefined) return null;
    return input;
  } catch {
    return null;
  }
}

/** Attest the native account and relay bounded assistant calls without its password.
 * 네이티브 계정을 증명하고 비밀번호 없이 제한된 어시스턴트 호출을 중계합니다. */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginRequest(request);
  if (rejected) return rejected;
  const credentials = await getStalwartCredentials(request);
  if (!credentials?.trusted) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const plugin = await getPlugin('bulwart-assistant');
  if (!plugin?.enabled) return NextResponse.json({ error: 'plugin_disabled' }, { status: 403 });
  const config = await getPluginConfig('bulwart-assistant');
  if (typeof config.origin !== 'string' || typeof config.TOKEN !== 'string' || !config.TOKEN || !URL.canParse(config.origin)) return NextResponse.json({ error: 'assistant_not_configured' }, { status: 503 });
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return NextResponse.json({ error: 'invalid_origin' }, { status: 503 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  const input = readRelayInput(raw);
  if (!input || !['GET', 'POST', 'PUT', 'DELETE'].includes(input.method) || !/^\/api\/(settings|models(?:\/test)?|mcps(?:\/test)?|connections\/(?:model|mcp)\/[a-z0-9-]+|reviews(?:\/[a-z0-9.-]+(?:\/cancel)?)?|runs\/[a-z0-9.-]+\/abort)$/.test(input.path)) return NextResponse.json({ error: 'invalid_route' }, { status: 400 });
  try {
    const session = await nativeSession(credentials.serverUrl, credentials.authHeader);
    if (!session.ok) return NextResponse.json({ error: 'native_auth_failed' }, { status: 401 });
    const identity = await session.json() as { username?: string };
    if (typeof identity.username !== 'string' || !identity.username) return NextResponse.json({ error: 'native_identity_missing' }, { status: 401 });
    const actor = Buffer.from(JSON.stringify([credentials.serverUrl, identity.username]), 'utf8').toString('base64url');
    const timestamp = String(Date.now());
    let body = '';
    if (input.body !== undefined) body = JSON.stringify(input.body);
    const signature = createHmac('sha256', config.TOKEN).update([timestamp, actor, input.method, input.path, body].join('\n')).digest('base64');
    const response = await fetch(new URL(input.path, origin.origin), { method: input.method, headers: { 'Content-Type': 'application/json', 'X-Assistant-Actor': actor, 'X-Assistant-Timestamp': timestamp, 'X-Assistant-Signature': signature }, body: body || undefined, redirect: 'error', signal: AbortSignal.timeout(90000) });
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 1024 * 1024) return NextResponse.json({ error: 'response_too_large' }, { status: 502 });
    return NextResponse.json({ status: response.status, body: text });
  } catch {
    return NextResponse.json({ error: 'assistant_connection_failed' }, { status: 502 });
  }
}
