import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { resolveCredential } from '@/lib/plugin-secrets/proxy';
import { readFileGrant, backendFingerprint } from '@/lib/plugin-secrets/file-grants';
import { nativeIdentity, listResources, readResource } from '@/lib/plugin-secrets/native-files';
import { MAX_PROXY_RESPONSE_BYTES } from '@/lib/plugin-secrets/proxy';

/** Redeem only a current host capability; native account credentials never leave the host.
 * 현재 호스트 권한만 사용하며 네이티브 자격증명은 호스트 밖으로 보내지 않습니다. */
export async function POST(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return NextResponse.json({ error: 'Read capability required' }, { status: 401 });
  try {
    await configManager.ensureLoaded();
    const grant = await readFileGrant(token);
    if (!grant || !configManager.getPolicy().features.pluginsEnabled) return NextResponse.json({ error: 'Read capability expired or revoked' }, { status: 401 });
    const plugin = await getPlugin(grant.pluginId);
    const backend = await resolveCredential(grant.access, grant.pluginId, grant.credentialId);
    if (!plugin?.enabled || !plugin.permissions.includes('files:read') || !plugin.permissions.includes('http:proxy') || !backend?.attestUser || !backend.secret || grant.fingerprint !== backendFingerprint(backend.origin, backend.secret)) return NextResponse.json({ error: 'Read capability is no longer allowed' }, { status: 403 });
    const identity = await nativeIdentity(grant.access);
    if (identity.subject !== grant.nativeSubject || identity.accountId !== grant.accountId) return NextResponse.json({ error: 'Native account changed' }, { status: 403 });
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 8192) return NextResponse.json({ error: 'Request is too large' }, { status: 413 });
    const body = JSON.parse(raw) as { operation?: unknown; cursor?: unknown; fileId?: unknown; version?: unknown };
    if (body.operation === 'list' && (body.cursor === undefined || typeof body.cursor === 'string')) return NextResponse.json({ ...await listResources(identity, grant.roots, body.cursor), paths: grant.roots.map((root) => root.path) }, { headers: { 'Cache-Control': 'no-store' } });
    if (body.operation !== 'read' || typeof body.fileId !== 'string' || typeof body.version !== 'string') return NextResponse.json({ error: 'Only list and versioned read are supported' }, { status: 400 });
    const upstream = await readResource(identity, grant.roots, body.fileId, body.version, request.signal);
    if (!upstream.ok) { await upstream.body?.cancel(); return NextResponse.json({ error: 'Native read was refused' }, { status: 403 }); }
    let bytes = 0;
    const stream = upstream.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > MAX_PROXY_RESPONSE_BYTES) { controller.error(new Error('Resource too large')); return; }
      controller.enqueue(chunk);
    } }));
    return new Response(stream, { headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store', ETag: `"${body.version}"` } });
  } catch { return NextResponse.json({ error: 'Resource is unavailable or outside the granted scope' }, { status: 403 }); }
}
