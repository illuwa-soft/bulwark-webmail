import { apiFetch } from '@/lib/browser-navigation';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import type { InstalledPlugin, Permission } from '@/lib/plugin-types';
import { persistentRequest, PERSISTENT_READ_PERMISSION, PERSISTENT_WRITE_PERMISSION } from '@/lib/plugin-persistent-storage';
import type { StorageOperation } from '@/lib/plugin-persistent-storage';
import { pluginHasPermission } from './permissions';

/** Captures the native account slot and package; plugin code supplies neither selector.
 * 플러그인 코드가 선택자를 전달하지 않도록 네이티브 계정 슬롯·패키지를 캡처합니다. */
export async function doPersistentStorage(plugin: InstalledPlugin, operation: StorageOperation, key: unknown, value: unknown, options: unknown) {
  let permission: Permission = PERSISTENT_READ_PERMISSION;
  if (operation === 'set' || operation === 'remove') permission = PERSISTENT_WRITE_PERMISSION;
  const account = useAccountStore.getState().getActiveAccount();
  const client = useAuthStore.getState().client;
  let fingerprint = plugin.approvalHash;
  if (plugin.managed) fingerprint = plugin.bundleHash;
  if (!account || !client || !fingerprint || account.username !== client.getUsername() || account.serverUrl.replace(/\/+$/, '') !== client.getServerUrl().replace(/\/+$/, '')) throw new Error('storage.persistent.unauthenticated');
  const identity = JSON.stringify([client.getUsername(), client.getServerUrl()]);
  const check = () => {
    if (useAuthStore.getState().client !== client || useAccountStore.getState().activeAccountId !== account.id || JSON.stringify([client.getUsername(), client.getServerUrl()]) !== identity) throw new Error('storage.persistent.accountChanged');
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
      'X-JMAP-Cookie-Slot': String(account.cookieSlot),
      'X-JMAP-Username': client.getUsername(),
      'X-JMAP-Server': client.getServerUrl().replace(/\/+$/, ''),
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
