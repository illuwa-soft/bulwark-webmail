import { useAuthStore } from '@/stores/auth-store';
import type { InstalledPlugin, Permission } from '../plugin-types';
import { pluginHasPermission } from './permissions';
import { sessionClient } from './host-api-input';

/** Captures one login and resource account; never resolves a UI viewing/aggregate client. */
export function writeScope(plugin: InstalledPlugin, permission: Permission, method: string) {
  const client = sessionClient(method);
  const identity = () => {
    let account = client.getAccountId();
    if (permission.startsWith('files:')) account = client.getFilesAccountId();
    return JSON.stringify([client.getServerUrl(), client.getUsername(), account]);
  };
  const owner = identity();
  const check = () => {
    if (useAuthStore.getState().client !== client || identity() !== owner) throw new Error(`${method}: session or account changed`);
    if (!pluginHasPermission(plugin, permission)) throw new Error(`${method}: permission was revoked`);
  };
  check();
  return { client, check };
}
