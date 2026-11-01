'use client';
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountStore } from '@/stores/account-store';
import { officeInformation, officeQueries } from '@/lib/eurooffice/client';
import { officeAccount } from '@/lib/eurooffice/account';

/** Keep each account/slot in its own server-state query, never in plugin-global browser storage.
 * 플러그인 공통 저장소 대신 계정·슬롯별 서버 상태 Query를 사용합니다. */
export function useEuroOffice() {
  const accountId = useAuthStore((state) => state.activeAccountId);
  const authenticated = useAuthStore((state) => state.isAuthenticated);
  const client = useAuthStore((state) => state.client);
  const account = useAccountStore((state) => state.accounts.find((entry) => entry.id === accountId));
  const slot = account?.cookieSlot;
  const context = officeAccount(client, accountId, slot);
  const ready = authenticated && context !== null;
  const queryKey = ['eurooffice', accountId, slot, context?.subject, context?.origin] as const;
  const query = useQuery({
    queryKey,
    enabled: typeof window !== 'undefined' && ready && !!accountId && slot !== undefined,
    queryFn: ({ signal }) => {
      if (!context) throw new Error('Authenticated Native account required');
      return officeInformation(context, undefined, undefined, signal);
    }
  }, officeQueries);
  return { accountId, slot, context, ready, queryKey, query };
}
