'use client';

import { useCallback, useRef } from 'react';
import { useRouter } from '@/i18n/navigation';
import { toRouterPath } from '@/lib/browser-navigation';

/** Let the auth observer and submit handler share one return navigation per login page.
 * 인증 상태 관찰과 제출 완료가 로그인 페이지당 하나의 복귀 이동을 공유합니다. */
export function useLoginReturn() {
  const router = useRouter();
  const redirected = useRef(false);
  return useCallback(() => {
    if (redirected.current) return;
    redirected.current = true;
    let target = '/';
    try {
      const saved = sessionStorage.getItem('redirect_after_login');
      if (saved) {
        sessionStorage.removeItem('redirect_after_login');
        target = saved;
      }
    } catch { /* Storage can be unavailable; keep the mailbox fallback. */ }
    router.push(toRouterPath(target));
  }, [router]);
}
