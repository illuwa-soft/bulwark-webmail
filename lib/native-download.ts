import { useAccountStore } from '@/stores/account-store';
import { generateAccountId, MAX_ACCOUNT_SLOTS } from '@/lib/account-utils';
import { withBasePath } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';

type NativeDownload = {
  serverUrl: string;
  username: string;
  accountId: string;
  blobId: string;
  name?: string;
  type?: string;
};

/** Hand a Full download to the browser using the calling login's cookie slot. */
export async function startNativeDownload(file: NativeDownload, prepare: () => Promise<void>): Promise<boolean> {
  if (IS_LITE || typeof document === 'undefined' || file.serverUrl.startsWith('/')) return false;

  const clientAccountId = generateAccountId(file.username, file.serverUrl);
  const account = useAccountStore.getState().getAccountById(clientAccountId);
  if (!account || !Number.isInteger(account.cookieSlot) || account.cookieSlot < 0 || account.cookieSlot >= MAX_ACCOUNT_SLOTS) return false;
  const slot = account.cookieSlot;

  // Reuse the client's auth refresh before leaving the authenticated-fetch path.
  await prepare();
  const current = useAccountStore.getState().getAccountById(clientAccountId);
  if (!current || current.cookieSlot !== slot) throw new Error('Download account changed');

  const params = new URLSearchParams({
    slot: String(slot),
    clientAccountId,
    serverUrl: file.serverUrl,
    accountId: file.accountId,
    blobId: file.blobId,
    name: file.name || 'download',
    type: file.type || 'application/octet-stream',
  });
  const anchor = document.createElement('a');
  anchor.href = withBasePath('/api/download?' + params);
  anchor.download = file.name || 'download';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
