import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';

/** Resolve the actual native identity within its trusted discovery origin.
 * 신뢰된 탐색 출처 안에서 실제 네이티브 계정 식별자를 확인합니다. */
async function nativeSession(serverUrl: string, authorization: string) {
  const origin = new URL(serverUrl).origin;
  let url = new URL('/.well-known/jmap', origin);
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url, { headers: { Authorization: authorization }, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error('native_discovery_failed');
    url = new URL(location, url);
    if (url.origin !== origin || url.username || url.password) throw new Error('native_origin_changed');
  }
  throw new Error('native_redirect_limit');
}

/** Relay only Puppy operations and seal native access for browser-independent scans.
 * Puppy 작업만 중계하고 브라우저 독립 감지를 위한 네이티브 접근을 암호화합니다. */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginRequest(request);
  if (rejected) return rejected;
  const credentials = await getStalwartCredentials(request);
  if (!credentials?.trusted) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const plugin = await getPlugin('puppy-inbox');
  if (!plugin?.enabled || !plugin.permissions?.includes('http:post') || !plugin.permissions?.includes('files:read')) return NextResponse.json({ error: 'plugin_disabled_or_permission_missing' }, { status: 403 });
  const config = await getPluginConfig('puppy-inbox');
  if (typeof config.origin !== 'string' || typeof config.TOKEN !== 'string' || !config.TOKEN || !URL.canParse(config.origin)) return NextResponse.json({ error: 'transcription_not_configured' }, { status: 503 });
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return NextResponse.json({ error: 'invalid_origin' }, { status: 503 });
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 65536) return NextResponse.json({ error: 'too_large' }, { status: 413 });
  let input: { path: string; body: unknown };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || !('path' in value) || typeof value.path !== 'string' || !('body' in value)) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    input = { path: value.path, body: value.body };
  } catch { return NextResponse.json({ error: 'invalid_request' }, { status: 400 }); }
  if (!/^\/api\/(sources|status|transcribe|transcript)$/.test(input.path)) return NextResponse.json({ error: 'invalid_route' }, { status: 400 });
  try {
    const session = await nativeSession(credentials.serverUrl, credentials.authHeader);
    if (!session.ok) return NextResponse.json({ error: 'native_auth_failed' }, { status: 401 });
    const identity: unknown = await session.json();
    if (!identity || typeof identity !== 'object' || !('username' in identity) || typeof identity.username !== 'string' || !identity.username) return NextResponse.json({ error: 'native_identity_missing' }, { status: 401 });
    if (!('primaryAccounts' in identity)) return NextResponse.json({ error: 'native_file_account_missing' }, { status: 401 });
    const primary = identity.primaryAccounts;
    if (!primary || typeof primary !== 'object' || Array.isArray(primary)) return NextResponse.json({ error: 'native_file_account_missing' }, { status: 401 });
    let fileAccount: unknown;
    if ('urn:ietf:params:jmap:filenode' in primary) fileAccount = primary['urn:ietf:params:jmap:filenode'];
    if (!fileAccount && 'urn:ietf:params:jmap:mail' in primary) fileAccount = primary['urn:ietf:params:jmap:mail'];
    if (typeof fileAccount !== 'string' || !fileAccount) return NextResponse.json({ error: 'native_file_account_missing' }, { status: 401 });
    const actor = Buffer.from(JSON.stringify([new URL(credentials.serverUrl).origin, identity.username, fileAccount])).toString('base64url');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(config.TOKEN).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(credentials.authHeader, 'utf8'), cipher.final()]);
    const access = Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url');
    const timestamp = String(Date.now());
    const body = JSON.stringify(input.body);
    const signature = createHmac('sha256', config.TOKEN).update([timestamp, actor, access, 'POST', input.path, body].join('\n')).digest('base64');
    const response = await fetch(new URL(input.path, origin), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Puppy-Actor': actor, 'X-Puppy-Access': access, 'X-Puppy-Timestamp': timestamp, 'X-Puppy-Signature': signature }, body, redirect: 'error', signal: AbortSignal.timeout(90000) });
    const text = await response.text();
    if (Buffer.byteLength(text) > 1024 * 1024) return NextResponse.json({ error: 'response_too_large' }, { status: 502 });
    return NextResponse.json({ status: response.status, body: text });
  } catch { return NextResponse.json({ error: 'transcription_connection_failed' }, { status: 502 }); }
}
