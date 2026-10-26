import type { InstalledPlugin } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';
import { readString, sessionClient } from './host-api-input';

const COMMANDS = {
  'mail-move': 'email.move', 'mail-update': 'email.update', 'mail-trash': 'email.trash', 'mail-send': 'email.send', 'mail-draft': 'drafts.create',
  'mail-get': 'email.getPrimary', 'mailboxes-list': 'mailboxes.list',
  'contact-create': 'contact.create', 'contact-update': 'contact.update', 'contact-remove': 'contact.delete', 'contact-get': 'contact.get',
  'addressbooks-list': 'addressbook.list',
  'calendar-create': 'calendar.createEvent', 'calendar-update': 'calendar.updateEvent', 'calendar-remove': 'calendar.deleteEvent', 'calendar-get': 'calendar.getEvent', 'calendars-list': 'calendar.listCalendars',
  'file-create-text': 'files.createText', 'file-create-directory': 'files.createDirectory', 'file-update': 'files.update', 'file-remove': 'files.remove', 'file-get': 'files.get',
} as const;

/** A stable account stamp, not a credential and never a way to choose another login. */
export async function currentMutationScope(plugin: InstalledPlugin): Promise<string> {
  const client = sessionClient('mutations.scope');
  const identity = () => JSON.stringify([1, plugin.id, client.getServerUrl(), client.getUsername(), client.getAccountId(), client.getContactsAccountId(), client.getCalendarsAccountId(), client.getFilesAccountId()]);
  const owner = identity();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner));
  if (useAuthStore.getState().client !== client || identity() !== owner) throw new Error('mutations.scope: account changed');
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Closed semantic catalog. The normal dispatcher still applies each command's real permission gate. */
export async function applyScopedMutation(plugin: InstalledPlugin, scopeArg: unknown, commandArg: unknown, argsArg: unknown, invoke: (method: string, args: unknown[]) => Promise<unknown>) {
  const scope = readString(scopeArg, 'mutations.apply', 'scope', 64, { min: 64 });
  const command = readString(commandArg, 'mutations.apply', 'command', 40, { min: 1 });
  if (!Object.hasOwn(COMMANDS, command) || !Array.isArray(argsArg) || argsArg.length > 3) throw new Error('mutations.apply: unsupported command');
  if (scope !== await currentMutationScope(plugin)) throw new Error('mutations.apply: account changed; capture a new account scope');
  // The key was checked against the closed catalog, not interpreted as an arbitrary API/JMAP method.
  return invoke(COMMANDS[command as keyof typeof COMMANDS], argsArg);
}
