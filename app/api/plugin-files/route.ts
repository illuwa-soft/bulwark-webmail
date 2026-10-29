import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { getPlugin } from '@/lib/admin/plugin-registry';
import { resolveCredential, acquireProxySlot, readProxyBody, ProxyError } from '@/lib/plugin-secrets/proxy';
import { readFileGrant, backendFingerprint } from '@/lib/plugin-secrets/file-grants';
import { nativeIdentity, readResource } from '@/lib/plugin-secrets/native-files';
import { listResources } from '@/lib/plugin-secrets/file-listings';
import { FileResourceError } from '@/lib/plugin-secrets/file-errors';
import { MAX_PROXY_RESPONSE_BYTES } from '@/lib/plugin-secrets/proxy';

/** Hold the user slot until content finishes, fails or is cancelled. */
function contentStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, release: () => void) {
  const reader = body.getReader();
  let bytes = 0;
  let finished = false;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    release();
  };
  const abort = () => {
    finish();
    output?.error(signal.reason);
    void reader.cancel(signal.reason).catch(() => {}).finally(() => reader.releaseLock());
  };
  signal.addEventListener('abort', abort, { once: true });
  return new ReadableStream<Uint8Array>({
    start(controller) { output = controller; if (signal.aborted) abort(); },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (finished) return;
        if (next.done) { finish(); reader.releaseLock(); controller.close(); return; }
        bytes += next.value.byteLength;
        if (bytes > MAX_PROXY_RESPONSE_BYTES) throw new Error('Resource too large');
        controller.enqueue(next.value);
      } catch (error) {
        await reader.cancel().catch(() => {});
        finish();
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); reader.releaseLock(); } },
  });
}

/** Redeem only a current host capability; native account credentials never leave the host.
 * 현재 호스트 권한만 사용하며 네이티브 자격증명은 호스트 밖으로 보내지 않습니다. */
export async function POST(request: NextRequest) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!token) return NextResponse.json({ error: 'Read capability required' }, { status: 401 });
  let release: (() => void) | undefined;
  let streaming = false;
  try {
    await configManager.ensureLoaded();
    const grant = await readFileGrant(token);
    if (!grant || !configManager.getPolicy().features.pluginsEnabled) return NextResponse.json({ error: 'Read capability expired or revoked' }, { status: 401 });
    release = acquireProxySlot(grant.access, grant.pluginId);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(25000)]);
    const plugin = await getPlugin(grant.pluginId);
    const backend = await resolveCredential(grant.access, grant.pluginId, grant.credentialId);
    if (!plugin?.enabled || !plugin.permissions.includes('files:read') || !plugin.permissions.includes('http:proxy') || !backend?.attestUser || !backend.secret || grant.fingerprint !== backendFingerprint(backend.origin, backend.secret)) return NextResponse.json({ error: 'Read capability is no longer allowed' }, { status: 403 });
    if (!request.body) return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
    const raw = Buffer.from(await readProxyBody(request.body, 8192, signal)).toString('utf8');
    const body = JSON.parse(raw) as { operation?: unknown; cursor?: unknown; fileId?: unknown; version?: unknown };
    if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'JSON object required' }, { status: 400 });
    if (body.operation !== 'list' && body.operation !== 'read') return NextResponse.json({ error: 'Only list and versioned read are supported' }, { status: 400 });
    const identity = await nativeIdentity(grant.access, signal);
    if (identity.subject !== grant.nativeSubject || identity.accountId !== grant.accountId) return NextResponse.json({ error: 'Native account changed' }, { status: 403 });
    if (body.operation === 'list' && (body.cursor === undefined || typeof body.cursor === 'string')) return NextResponse.json({ ...await listResources(identity, grant, body.cursor), paths: grant.roots.map((root) => root.path) }, { headers: { 'Cache-Control': 'no-store' } });
    if (body.operation !== 'read' || typeof body.fileId !== 'string' || typeof body.version !== 'string') return NextResponse.json({ error: 'Only list and versioned read are supported' }, { status: 400 });
    const downloadSignal = AbortSignal.any([request.signal, AbortSignal.timeout(10 * 60 * 1000)]);
    const upstream = await readResource(identity, grant.roots, body.fileId, body.version, downloadSignal);
    if (!upstream.ok) { await upstream.body?.cancel(); return NextResponse.json({ error: 'Native read was refused' }, { status: 403 }); }
    const stream = upstream.body && contentStream(upstream.body, downloadSignal, release);
    streaming = !!stream;
    return new Response(stream, { headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'Cache-Control': 'no-store', ETag: `"${body.version}"` } });
  } catch (error) {
    if (error instanceof ProxyError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store', ...(error.status === 429 ? { 'Retry-After': String((error as ProxyError & { retryAfter?: number }).retryAfter ?? 1) } : {}) } });
    if (error instanceof SyntaxError) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    if (error instanceof FileResourceError) return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store', ...(error.status === 503 ? { 'Retry-After': '1' } : {}) } });
    if (request.signal.aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) return NextResponse.json({ error: 'Native read timed out', code: 'native_timeout' }, { status: 504 });
    return NextResponse.json({ error: 'Resource is unavailable or outside the granted scope' }, { status: 403 });
  } finally {
    if (!streaming) release?.();
  }
}
