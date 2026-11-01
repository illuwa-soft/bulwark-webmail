'use client';
import type { MouseEvent } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { leaveOfficeViews, officeViewsActive } from './lifecycle';

/** Keep every host layout on the same exact-frame close and current-account boundary.
 * 모든 호스트 배치에서 정확한 프레임 종료·현재 계정 경계를 함께 사용합니다. */
export function confirmOfficeNavigation(event: MouseEvent, navigate: () => void) {
  if (!officeViewsActive() || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return false;
  event.preventDefault();
  const account = useAuthStore.getState().activeAccountId;
  void leaveOfficeViews('navigation').then((confirmed) => {
    if (confirmed && account === useAuthStore.getState().activeAccountId) navigate();
  });
  return true;
}
