import { createHash } from 'node:crypto';

export type DownloadRange = { start: number; end: number };

/** Use the immutable, account-scoped Blob identity when the origin has no ETag. */
export function blobEtag(serverUrl: string, accountId: string, blobId: string, type: string): string {
  return '"bulwark-' + createHash('sha256').update(JSON.stringify([serverUrl, accountId, blobId, type])).digest('hex') + '"';
}

/** Apply entity-tag preconditions without weakening the underlying Blob authorization. */
export function downloadPrecondition(headers: Headers, etag: string): 304 | 412 | null {
  const match = headers.get('if-match');
  const none = headers.get('if-none-match');
  const matchTags: string[] = match?.match(/(?:W\/)?"[^"]*"|\*/g) || [];
  const noneTags: string[] = none?.match(/(?:W\/)?"[^"]*"|\*/g) || [];
  if (match && !matchTags.includes('*') && (etag.startsWith('W/') || !matchTags.includes(etag))) return 412;
  if (noneTags.some(tag => tag === '*' || tag.replace(/^W\//, '') === etag.replace(/^W\//, ''))) return 304;
  return null;
}

function matchesIfRange(value: string | null, etag: string, modified: string | null): boolean {
  if (!value) return true;
  if (value.startsWith('W/')) return false;
  if (value.startsWith('"')) return !etag.startsWith('W/') && value === etag;
  if (!modified) return false;
  const date = Date.parse(value);
  return Number.isFinite(date) && date === Date.parse(modified);
}

/** Parse a single byte range; invalid or multi-range syntax keeps the full response. */
export function downloadRange(headers: Headers, length: number, etag: string, modified: string | null): DownloadRange | 'unsatisfiable' | null {
  if (!matchesIfRange(headers.get('if-range'), etag, modified)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(headers.get('range')?.trim() || '');
  if (!match || (!match[1] && !match[2])) return null;
  if (length === 0) return 'unsatisfiable';
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, length - suffix), end: length - 1 };
  }
  const start = Number(match[1]);
  let end = length - 1;
  if (match[2]) end = Math.min(Number(match[2]), end);
  if (start >= length || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Slice a full origin stream with backpressure and cancel after the selected bytes. */
export function sliceDownload(source: ReadableStream<Uint8Array<ArrayBuffer>>, range: DownloadRange): ReadableStream<Uint8Array<ArrayBuffer>> {
  const reader = source.getReader();
  let offset = 0;
  let remaining = range.end - range.start + 1;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      while (remaining > 0) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error('Truncated origin download'));
          return;
        }
        const start = Math.max(0, range.start - offset);
        const end = Math.min(value.byteLength, range.end + 1 - offset);
        offset += value.byteLength;
        if (end <= start) continue;
        const chunk = value.subarray(start, end);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        if (remaining === 0) {
          controller.close();
          void reader.cancel().catch(() => undefined);
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
}
