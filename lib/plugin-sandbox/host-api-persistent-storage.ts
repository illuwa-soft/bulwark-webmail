import { apiFetch } from '@/lib/browser-navigation';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import type { InstalledPlugin, Permission } from '@/lib/plugin-types';
import { persistentRequest, PERSISTENT_READ_PERMISSION, PERSISTENT_WRITE_PERMISSION } from '@/lib/plugin-persistent-storage';
import type { StorageOperation } from '@/lib/plugin-persistent-storage';
import { pluginHasPermission } from './permissions';

export type PersistentStorageOwner = {
  accountId: string;
  cookieSlot: number;
  client: NonNullable<ReturnType<typeof useAuthStore.getState>['client']>;
  username: string;
  serverUrl: string;
};

/** Pins a frame's account before a read-modify-write workflow can span account changes.
 * 읽기·수정·쓰기 작업 중 계정이 바뀌지 않도록 프레임의 계정을 고정합니다. */
export function capturePersistentStorageOwner(): PersistentStorageOwner {
  const account = useAccountStore.getState().getActiveAccount();
  const client = useAuthStore.getState().client;
  if (!account || !client || account.username !== client.getUsername() || account.serverUrl.replace(/\/+$/, '') !== client.getServerUrl().replace(/\/+$/, '')) throw new Error('storage.persistent.unauthenticated');
  return { accountId: account.id, cookieSlot: account.cookieSlot, client, username: client.getUsername(), serverUrl: client.getServerUrl() };
}

/** Captures the native account slot and package; plugin code supplies neither selector.
 * 플러그인 코드가 선택자를 전달하지 않도록 네이티브 계정 슬롯·패키지를 캡처합니다. */
export async function doPersistentStorage(plugin: InstalledPlugin, operation: StorageOperation, key: unknown, value: unknown, options: unknown, owner?: PersistentStorageOwner) {
  // Inline the flag: this module is also retained for frame ownership in Lite.
  // Lite에서도 프레임 소유권으로 유지되는 모듈이므로 플래그를 직접 인라인합니다.
  if (process.env.NEXT_PUBLIC_BULWARK_LITE === '1') throw new Error('storage.persistent.fullServerRequired');
  const scope = owner ?? capturePersistentStorageOwner();
  let permission: Permission = PERSISTENT_READ_PERMISSION;
  if (operation === 'set' || operation === 'remove') permission = PERSISTENT_WRITE_PERMISSION;
  const client = scope.client;
  let fingerprint = plugin.approvalHash;
  if (plugin.managed) fingerprint = plugin.bundleHash;
  if (!fingerprint) throw new Error('storage.persistent.unauthenticated');
  const check = () => {
    const active = useAccountStore.getState().getActiveAccount();
    if (useAuthStore.getState().client !== client || active?.id !== scope.accountId || active.cookieSlot !== scope.cookieSlot || client.getUsername() !== scope.username || client.getServerUrl() !== scope.serverUrl) throw new Error('storage.persistent.accountChanged');
    if (!pluginHasPermission(plugin, permission)) throw new Error('storage.persistent.forbidden');
  };
  check();
  let input: unknown = { operation };
  if (operation === 'get') input = { operation, key };
  if (operation === 'set' || operation === 'remove') {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(name => name !== 'expectedRevision')) throw new Error('storage.persistent.invalid');
    const expectedRevision = (options as Record<string, unknown>).expectedRevision;
    input = { operation, key, expectedRevision };
    if (operation === 'set') input = { operation, key, value, expectedRevision };
  }
  const body = persistentRequest(input);
  check();
  const response = await apiFetch('/api/plugin-storage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-JMAP-Cookie-Slot': String(scope.cookieSlot),
      'X-JMAP-Username': encodeURIComponent(scope.username),
      'X-JMAP-Server': encodeURIComponent(scope.serverUrl.replace(/\/+$/, '')),
      'X-Bulwark-Plugin-Id': plugin.id,
      'X-Bulwark-Plugin-Fingerprint': fingerprint,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  check();
  if (!response.ok) throw new Error(`storage.persistent.${result.error?.code ?? 'unavailable'}`);
  return result.result;
}
