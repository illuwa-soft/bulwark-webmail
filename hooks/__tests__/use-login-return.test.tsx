import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/i18n/navigation', () => ({ useRouter: () => navigation }));
import { useLoginReturn } from '../use-login-return';

beforeEach(() => { sessionStorage.clear(); navigation.push.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('does not let the submit completion overwrite the auth observer return with the inbox', () => {
  sessionStorage.setItem('redirect_after_login', '/apps/euro-office');
  const { result, rerender } = renderHook(() => useLoginReturn());
  act(() => { result.current(); });
  expect(sessionStorage.getItem('redirect_after_login')).toBeNull();
  rerender();
  act(() => { result.current(); });
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/apps/euro-office');
});

it('uses the same return path when submit completion happens before the auth observer', () => {
  sessionStorage.setItem('redirect_after_login', '/en/apps/euro-office?view=files#folder');
  const { result } = renderHook(() => useLoginReturn());
  act(() => { result.current(); result.current(); });
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/en/apps/euro-office?view=files#folder');
});

it('keeps one mailbox fallback when there is no saved return or storage is unavailable', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  const { result } = renderHook(() => useLoginReturn());
  act(() => { result.current(); result.current(); });
  expect(navigation.push).toHaveBeenCalledExactlyOnceWith('/');
});
