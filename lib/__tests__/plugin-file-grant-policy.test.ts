import { describe, expect, it } from 'vitest';
import { fileGrantExpiresAt, MAX_FILE_GRANT_TTL_SECONDS } from '@/lib/plugin-file-grant-policy';

describe('explicit background read lifetime', () => {
  it('retains the seven-day default and makes only an explicit null non-expiring', () => {
    expect(fileGrantExpiresAt(undefined, 1000)).toBe(1000 + MAX_FILE_GRANT_TTL_SECONDS * 1000);
    expect(fileGrantExpiresAt(60, 1000)).toBe(61000);
    expect(fileGrantExpiresAt(null, 1000)).toBeNull();
  });

  it.each([0, -1, 59, 1.5, 8 * 24 * 3600, Infinity, NaN, 'permanent', false, {}])('rejects malformed or out-of-bounds finite lifetimes: %s', (value) => {
    expect(() => fileGrantExpiresAt(value)).toThrow();
  });
});
