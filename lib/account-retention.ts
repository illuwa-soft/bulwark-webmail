/** Metadata lifetime only; authentication cookies keep their own expiry. / 계정 목록만 보존하며 인증 쿠키의 만료와 분리합니다. */
export const ACCOUNT_LIST_RETENTION_YEARS = 100;

/** Retain an account for 100 calendar years from its last sign-in. / 마지막 로그인부터 100년간 계정 항목을 보존합니다. */
export function accountListRetainedUntil(lastLoginAt: number): number {
  let start = lastLoginAt;
  if (!Number.isFinite(start) || start <= 0) start = Date.now();
  const deadline = new Date(start);
  deadline.setUTCFullYear(deadline.getUTCFullYear() + ACCOUNT_LIST_RETENTION_YEARS);
  return deadline.getTime();
}
