import { createHash, createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { nativeIdentity, type NativeAccess } from './native-files';
import { currentFileGrant, backendFingerprint } from './file-grants';

export type ProxyIdentityContext = { native: NativeAccess; issuer: string; resourceUrl: string };

/** Preserve public origin/base-path behind the same-origin gate and reverse proxy.
 * 동일 출처 검증 뒤 역방향 프록시의 공개 출처·기본 경로를 보존합니다. */
export function proxyIdentityContext(request: NextRequest, native: NativeAccess): ProxyIdentityContext {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? request.nextUrl.host).split(',')[0].trim();
  const protocol = (request.headers.get('x-forwarded-proto') ?? request.nextUrl.protocol.replace(':', '')).split(',')[0].trim();
  const issuer = new URL(request.headers.get('origin') || `${protocol}://${host}`).origin;
  return { native, issuer, resourceUrl: `${issuer}${request.nextUrl.basePath ?? ''}/api/plugin-files` };
}

/** Use pairwise subjects so different plugins/services do not share a correlatable account ID.
 * 서로 다른 플러그인·서비스가 같은 계정 ID를 공유하지 않게 쌍별 식별자를 만듭니다. */
export function proxySubject(nativeSubject: string, pluginId: string, backend: string) {
  return createHash('sha256').update(JSON.stringify([nativeSubject, pluginId, backend])).digest('hex');
}

/** Sign only identity and an optional host-scoped read capability, never a native credential.
 * 네이티브 자격증명 없이 계정 증명과 선택적인 호스트 읽기 권한만 서명합니다. */
export async function signProxyIdentity(context: ProxyIdentityContext, pluginId: string, credentialId: string, origin: string, secret: string) {
  const native = await nativeIdentity(context.native);
  const sub = proxySubject(native.subject, pluginId, origin);
  const grant = await currentFileGrant(sub, pluginId, credentialId);
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = { iss: context.issuer, aud: origin, sub, plugin: pluginId, credential: credentialId, iat: now, exp: now + 60 };
  if (grant && grant.fingerprint === backendFingerprint(origin, secret)) claims.files = { url: context.resourceUrl, token: grant.token, expiresAt: grant.expiresAt };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
