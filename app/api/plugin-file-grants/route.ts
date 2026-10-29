import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';
import { CREDENTIAL_ID_RE } from '@/lib/plugin-secrets/credentials';
import { nativeIdentity, resolveRoots } from '@/lib/plugin-secrets/native-files';
import { proxySubject } from '@/lib/plugin-secrets/identity';
import { backendFingerprint, currentFileGrant, putFileGrant, revokeFileGrant, NO_FILE_GRANT } from '@/lib/plugin-secrets/file-grants';
import { fileGrantExpiresAt } from '@/lib/plugin-file-grant-policy';

/** Resolve the current native account and an explicitly attested, installed backend.
 * 현재 네이티브 계정과 계정 증명을 선언한 설치 백엔드를 확인합니다. */
async function context(request: NextRequest) {
  await configManager.ensureLoaded();
  if (!configManager.getPolicy().features.pluginsEnabled) throw new Error('Plugins are disabled');
  const access = await getStalwartCredentials(request);
  const pluginId = request.nextUrl.searchParams.get('plugin') ?? '';
  const credentialId = request.nextUrl.searchParams.get('credential') ?? '';
  if (!access || !/^[a-z0-9][a-z0-9-]*$/.test(pluginId) || !CREDENTIAL_ID_RE.test(credentialId)) throw new Error('Invalid account or credential');
  const plugin = await getPlugin(pluginId);
  if (!plugin?.enabled || !plugin.permissions.includes('files:read') || !plugin.permissions.includes('http:proxy')) throw new Error('File read and proxy permissions are required');
  const backend = await resolveCredential(access, pluginId, credentialId);
  if (!backend?.attestUser || backend.scope !== 'admin' || !backend.secret) throw new Error('An attested backend is required');
  const identity = await nativeIdentity(access);
  const subject = proxySubject(identity.subject, pluginId, backend.origin);
  return { access, pluginId, credentialId, backend, identity, subject };
}

/** Return only consent metadata to the host page, never capability or native secrets.
 * 호스트 페이지에 승인 메타데이터만 반환하며 권한 토큰·네이티브 비밀값은 숨깁니다. */
export async function GET(request: NextRequest) {
  try {
    const input = await context(request);
    const grant = await currentFileGrant(input.subject, input.pluginId, input.credentialId);
    let summary = NO_FILE_GRANT;
    if (grant?.fingerprint === backendFingerprint(input.backend.origin, input.backend.secret!)) summary = { granted: true, paths: grant.roots.map((root) => root.path), expiresAt: grant.expiresAt };
    return NextResponse.json({ origin: input.backend.origin, grant: summary }, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'File delegation is unavailable' }, { status: 403 }); }
}

/** Mint read-only access to the exact files/folders confirmed by the host dialog.
 * 호스트 대화상자에서 확인한 정확한 파일·폴더의 읽기 권한을 발급합니다. */
export async function POST(request: NextRequest) {
  const rejected = rejectCrossOriginRequest(request);
  if (rejected) return rejected;
  try {
    const input = await context(request);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 256 * 1024) return NextResponse.json({ error: 'Scope is too large' }, { status: 413 });
    const body = JSON.parse(raw) as { paths?: unknown; expiresIn?: unknown; expectedOrigin?: unknown };
    if (!Array.isArray(body.paths) || body.paths.length < 1 || body.paths.length > 100 || body.paths.some((value) => typeof value !== 'string') || body.expectedOrigin !== input.backend.origin) return NextResponse.json({ error: 'Invalid or changed scope' }, { status: 400 });
    const expiresAt = fileGrantExpiresAt(body.expiresIn);
    const roots = await resolveRoots(input.identity, [...new Set(body.paths as string[])]);
    const summary = await putFileGrant({ subject: input.subject, nativeSubject: input.identity.subject, pluginId: input.pluginId, credentialId: input.credentialId, backend: input.backend.origin, fingerprint: backendFingerprint(input.backend.origin, input.backend.secret!), access: { serverUrl: input.access.serverUrl, username: input.access.username, authHeader: input.access.authHeader }, accountId: input.identity.accountId, roots, expiresAt });
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } });
  } catch { return NextResponse.json({ error: 'Unable to grant this file scope' }, { status: 400 }); }
}

/** Revoke future background reads independently of the consumer's database or job engine.
 * 소비자의 DB·작업 엔진과 독립적으로 이후 백그라운드 읽기를 철회합니다. */
export async function DELETE(request: NextRequest) {
  const rejected = rejectCrossOriginRequest(request);
  if (rejected) return rejected;
  try {
    const access = await getStalwartCredentials(request);
    if (!access) return NextResponse.json({ error: 'Host login required' }, { status: 401 });
    const pluginId = request.nextUrl.searchParams.get('plugin') ?? '';
    const credentialId = request.nextUrl.searchParams.get('credential') ?? '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(pluginId) || !CREDENTIAL_ID_RE.test(credentialId)) return NextResponse.json({ error: 'Invalid credential' }, { status: 400 });
    await revokeFileGrant(access, pluginId, credentialId);
    return NextResponse.json(NO_FILE_GRANT);
  } catch { return NextResponse.json({ error: 'Unable to revoke file access' }, { status: 403 }); }
}
