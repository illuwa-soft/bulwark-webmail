export const MAX_FILE_GRANT_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Keep the bounded default; only an explicit null requests access until revocation.
 * 제한된 기본 기간은 유지하며 명시적인 null만 철회할 때까지의 접근을 요청합니다. */
export function fileGrantExpiresAt(duration: unknown, now = Date.now()): number | null {
  if (duration === null) return null;
  if (duration === undefined) return now + MAX_FILE_GRANT_TTL_SECONDS * 1000;
  if (typeof duration !== 'number' || !Number.isSafeInteger(duration) || duration < 60 || duration > MAX_FILE_GRANT_TTL_SECONDS) throw new Error('Expiry must be one minute to seven days, or null for access until revoked');
  return now + duration * 1000;
}
