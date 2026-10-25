import { NextRequest, NextResponse } from 'next/server';
import { generateAccountId, MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { fetchJmapSession } from '@/lib/stalwart/jmap-api';
import { fetchJmapServer } from '@/lib/stalwart/server-fetch';
import { logger } from '@/lib/logger';
import { blobEtag, downloadPrecondition, downloadRange, sliceDownload, type DownloadRange } from '@/lib/stalwart/download-range';

export const dynamic = 'force-dynamic';

const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const REQUEST_HEADERS = ['range', 'if-range', 'if-match', 'if-none-match', 'if-modified-since', 'if-unmodified-since'];

function copyHeaders(names: string[], source: Headers, target: Headers) {
  for (const key of names) {
    const value = source.get(key);
    if (value) target.set(key, value);
  }
}

/** Encode a download filename without control characters or header injection. */
function disposition(name: string): string {
  const clean = Array.from(name.replace(/[\p{Cc}"/\\]/gu, '_')).slice(0, 255).join('') || 'download';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

async function download(request: NextRequest, method: 'GET' | 'HEAD') {
  const query = request.nextUrl.searchParams;
  const slot = query.get('slot') || '';
  const accountId = query.get('accountId') || '';
  const blobId = query.get('blobId') || '';
  const name = query.get('name') || 'download';
  const type = query.get('type') || 'application/octet-stream';
  const clientAccountId = query.get('clientAccountId') || '';
  const serverUrl = query.get('serverUrl') || '';

  if (!/^\d{1,2}$/.test(slot) || Number(slot) >= MAX_ACCOUNT_SLOTS || !accountId || !blobId || !clientAccountId || !serverUrl ||
      accountId.length > 255 || blobId.length > 4096 || name.length > 1024 || type.length > 255 || clientAccountId.length > 1024 || serverUrl.length > 2048) {
    return NextResponse.json({ error: 'Invalid download request' }, { status: 400 });
  }

  try {
    const creds = await getStalwartCredentials(request);
    if (!creds) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    if (creds.slot !== Number(slot) || generateAccountId(creds.username, creds.serverUrl) !== clientAccountId ||
        new URL(creds.serverUrl).href.replace(/\/+$/, '') !== new URL(serverUrl).href.replace(/\/+$/, '')) {
      return NextResponse.json({ error: 'Download account mismatch' }, { status: 403 });
    }

    const session = await fetchJmapSession(creds.serverUrl, creds.authHeader, { trusted: creds.trusted });
    if (!session?.downloadUrl) return NextResponse.json({ error: 'Download unavailable' }, { status: 502 });

    const values: Record<string, string> = { accountId, blobId, name, type };
    const expanded = session.downloadUrl.replace(/\{(accountId|blobId|name|type)\}/g, (_, key: string) => encodeURIComponent(values[key]));
    const advertised = new URL(expanded, creds.serverUrl + '/');
    if (advertised.username || advertised.password || advertised.hash || !['https:', 'http:'].includes(advertised.protocol)) {
      return NextResponse.json({ error: 'Invalid download endpoint' }, { status: 502 });
    }
    const target = new URL(new URL(creds.serverUrl).origin);
    target.pathname = advertised.pathname;
    target.search = advertised.search;
    const headers = new Headers({ Authorization: creds.authHeader, 'Accept-Encoding': 'identity' });
    let forwardedNames = REQUEST_HEADERS;
    if (method === 'HEAD') forwardedNames = REQUEST_HEADERS.filter(key => key !== 'range' && key !== 'if-range');
    copyHeaders(forwardedNames, request.headers, headers);

    const upstream = await fetchJmapServer(target.href, { method, headers, signal: request.signal }, creds.trusted);
    const returned = new Headers({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    copyHeaders(RESPONSE_HEADERS, upstream.headers, returned);

    if (upstream.status === 304 || upstream.status === 416) {
      void upstream.body?.cancel().catch(() => undefined);
      return new NextResponse(null, { status: upstream.status, headers: returned });
    }
    if (upstream.status !== 200 && upstream.status !== 206) {
      void upstream.body?.cancel().catch(() => undefined);
      const status = upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502;
      return NextResponse.json({ error: 'Download refused by mail server' }, { status });
    }
    const encoding = upstream.headers.get('content-encoding');
    if (encoding && encoding !== 'identity') {
      void upstream.body?.cancel().catch(() => undefined);
      return NextResponse.json({ error: 'Unexpected download encoding' }, { status: 502 });
    }

    const etag = returned.get('ETag') || blobEtag(creds.serverUrl, accountId, blobId, type);
    returned.set('ETag', etag);
    const precondition = downloadPrecondition(request.headers, etag);
    if (precondition) {
      void upstream.body?.cancel().catch(() => undefined);
      returned.delete('Content-Length');
      return new NextResponse(null, { status: precondition, headers: returned });
    }
    const sizeHeader = upstream.headers.get('Content-Length');
    const length = Number(sizeHeader);
    const knownLength = sizeHeader !== null && /^\d+$/.test(sizeHeader) && Number.isSafeInteger(length);
    if (knownLength) returned.set('Accept-Ranges', 'bytes');
    let body = upstream.body;
    let status = upstream.status;
    let range: DownloadRange | 'unsatisfiable' | null = null;
    if (method === 'GET' && upstream.status === 200 && knownLength)
      range = downloadRange(request.headers, length, etag, returned.get('Last-Modified'));
    if (range === 'unsatisfiable') {
      void upstream.body?.cancel().catch(() => undefined);
      returned.set('Content-Range', 'bytes */' + length);
      returned.delete('Content-Length');
      return new NextResponse(null, { status: 416, headers: returned });
    }
    if (range && body) {
      returned.set('Content-Range', `bytes ${range.start}-${range.end}/${length}`);
      returned.set('Content-Length', String(range.end - range.start + 1));
      body = sliceDownload(body, range);
      status = 206;
    }
    returned.set('Content-Disposition', disposition(name));
    if (!returned.has('Content-Type')) returned.set('Content-Type', 'application/octet-stream');
    if (method === 'HEAD') body = null;
    return new NextResponse(body, { status, headers: returned });
  } catch {
    logger.error('Native download could not be completed');
    return NextResponse.json({ error: 'Download unavailable' }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return download(request, 'GET');
}

export async function HEAD(request: NextRequest) {
  return download(request, 'HEAD');
}
