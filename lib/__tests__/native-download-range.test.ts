import { describe, expect, it, vi } from 'vitest';
import { blobEtag, downloadPrecondition, downloadRange, sliceDownload } from '@/lib/stalwart/download-range';

describe('immutable Blob validators and Range fallback', () => {
  it('keeps validators stable and scoped to the server, account and immutable Blob', () => {
    const tag = blobEtag('https://mail.test', 'owner', 'blob-a', 'application/pdf');
    expect(tag).toBe(blobEtag('https://mail.test', 'owner', 'blob-a', 'application/pdf'));
    expect(tag).not.toBe(blobEtag('https://other.test', 'owner', 'blob-a', 'application/pdf'));
    expect(tag).not.toBe(blobEtag('https://mail.test', 'other', 'blob-a', 'application/pdf'));
    expect(tag).not.toBe(blobEtag('https://mail.test', 'owner', 'blob-b', 'application/pdf'));
  });

  it.each([
    ['bytes=2-4', { start: 2, end: 4 }], ['bytes=2-', { start: 2, end: 9 }],
    ['bytes=-3', { start: 7, end: 9 }], ['bytes=-99', { start: 0, end: 9 }],
    ['bytes=2-99999999999999999999999', { start: 2, end: 9 }],
    ['bytes=99-', 'unsatisfiable'], ['bytes=-0', 'unsatisfiable'], ['bytes=4-2', 'unsatisfiable'],
    ['bytes=0-1,4-5', null], ['bytes=-', null], ['other=0-1', null],
  ])('parses %s', (value, expected) => {
    expect(downloadRange(new Headers({ Range: value }), 10, '"v1"', null)).toEqual(expected);
  });

  it('ignores stale or weak If-Range and accepts the exact strong validator', () => {
    expect(downloadRange(new Headers({ Range: 'bytes=2-', 'If-Range': '"old"' }), 10, '"v1"', null)).toBeNull();
    expect(downloadRange(new Headers({ Range: 'bytes=2-', 'If-Range': 'W/"v1"' }), 10, '"v1"', null)).toBeNull();
    expect(downloadRange(new Headers({ Range: 'bytes=2-', 'If-Range': '"v1"' }), 10, '"v1"', null)).toEqual({ start: 2, end: 9 });
  });

  it('honors entity preconditions, including a quoted tag containing a comma', () => {
    expect(downloadPrecondition(new Headers({ 'If-Match': '"wrong"' }), '"v1"')).toBe(412);
    expect(downloadPrecondition(new Headers({ 'If-None-Match': 'W/"v1"' }), '"v1"')).toBe(304);
    expect(downloadPrecondition(new Headers({ 'If-Match': '"v1,other"' }), '"v1,other"')).toBeNull();
  });

  it('slices across chunks and stops the producer without collecting the full body', async () => {
    const cancel = vi.fn();
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(value) { controller = value; }, cancel });
    const reader = sliceDownload(source, { start: 2, end: 6 }).getReader();
    const pending = reader.read();
    controller!.enqueue(new TextEncoder().encode('0123'));
    expect(new TextDecoder().decode((await pending).value)).toBe('23');
    controller!.enqueue(new TextEncoder().encode('456789'));
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('456');
    expect((await reader.read()).done).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('fails an incomplete selected range instead of saving a truncated file', async () => {
    const source = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    await expect(new Response(sliceDownload(source, { start: 0, end: 2 })).arrayBuffer()).rejects.toThrow('Truncated');
  });
});
