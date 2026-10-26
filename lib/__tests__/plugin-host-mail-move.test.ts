import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledPlugin } from '../plugin-types';
import type { JMAPClient } from '../jmap/client';
import type { Email, Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';
import { clearAllHooks, emailHooks } from '../plugin-hooks';
import { emailKeyFor } from '../thread-utils';

vi.mock('@/stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { dispatchApiCall } from '../plugin-sandbox/host-api';

function plugin(perms: string[]): InstalledPlugin {
  return {
    id: 'mover', name: 'Mover', version: '1.0.0', author: 'test', description: '',
    type: 'hook', permissions: perms, grantedPermissions: perms, entrypoint: 'index.js',
    enabled: true, status: 'running', settings: {},
  };
}
const WRITER = plugin(['email:write']);
const call = (p: InstalledPlugin, method: string, ...args: unknown[]) => dispatchApiCall(p, method, args);

const inbox = { id: 'inbox', name: 'Inbox', role: 'inbox' } as Mailbox;
const archive = { id: 'arch', name: 'Archive', role: 'archive' } as Mailbox;
const shared = { id: 'acc2:box', name: 'Team', isShared: true, accountId: 'acc2' } as unknown as Mailbox;
const initialAuth = useAuthStore.getState();
const initialMail = useEmailStore.getState();
const email = (id: string, source: Partial<Email> = {}) => ({ id, mailboxIds: { inbox: true }, keywords: {}, ...source } as Email);
function makeClient() {
  return {
    getAccountId: () => 'primary',
    getServerUrl: () => 'https://mail.example.test',
    getUsername: () => 'fixture',
    getMailboxes: vi.fn(async () => [inbox, archive, shared]),
    getAllMailboxes: vi.fn(async () => [inbox, archive, shared]),
    batchMoveEmails: vi.fn(async () => {}),
  };
}
let client: ReturnType<typeof makeClient>;

beforeEach(() => {
  clearAllHooks();
  resetPluginRateLimits();
  client = makeClient();
  const native = client as unknown as JMAPClient;
  useAuthStore.setState({ client: native, activeAccountId: 'login-a', getClientForAccount: (id) => id === 'login-a' ? native : undefined });
  useEmailStore.setState({ emails: [], mailboxes: [inbox, archive, shared], selectedMailbox: 'inbox', viewingAccountId: null, selectedEmail: null, selectedEmailKeys: new Set() });
});
afterEach(() => {
  clearAllHooks();
  useAuthStore.setState(initialAuth, true);
  useEmailStore.setState(initialMail, true);
});

describe('api.email.move and archive', () => {
  it('moves primary IDs once, fires the native hooks and updates the loaded list and selection', async () => {
    const rows = [email('m1'), email('m2'), email('m3'), email('kept')];
    useEmailStore.setState({ emails: rows, selectedEmail: rows[0], selectedEmailKeys: new Set(rows.map(emailKeyFor)) });
    const before = vi.fn(() => true);
    const after = vi.fn();
    const archived = vi.fn();
    emailHooks.onBeforeEmailMove.register('fixture', before);
    emailHooks.onAfterEmailMove.register('fixture', after);
    emailHooks.onEmailArchive.register('fixture', archived);
    await call(WRITER, 'email.move', ['m1', 'm2', 'm1'], 'arch');
    await call(WRITER, 'email.archive', ['m3']);

    expect(client.batchMoveEmails).toHaveBeenNthCalledWith(1, ['m1', 'm2'], 'arch', 'primary');
    expect(client.batchMoveEmails).toHaveBeenNthCalledWith(2, ['m3'], 'arch', 'primary');
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
    expect(archived).toHaveBeenCalledTimes(2);
    expect(useEmailStore.getState().emails.map(e => e.id)).toEqual(['kept']);
    expect(useEmailStore.getState().selectedEmail).toBeNull();
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual(['kept']);
  });

  it('does not remove another login or shared-account row with the same server ID', async () => {
    const own = email('m1', { sourceClientAccountId: 'login-a', sourceAccountId: 'primary' });
    const sharedRow = email('m1', { sourceClientAccountId: 'login-a', sourceAccountId: 'team' });
    const other = email('m1', { sourceClientAccountId: 'login-b', sourceAccountId: 'primary' });
    useEmailStore.setState({ emails: [own, sharedRow, other], selectedEmail: other, selectedEmailKeys: new Set([own, sharedRow, other].map(emailKeyFor)) });
    await call(WRITER, 'email.archive', ['m1']);
    expect(useEmailStore.getState().emails).toEqual([sharedRow, other]);
    expect(useEmailStore.getState().selectedEmail).toEqual(other);
    expect([...useEmailStore.getState().selectedEmailKeys]).toEqual([emailKeyFor(sharedRow), emailKeyFor(other)]);
  });

  it('does not update the list or emit success when a hook or server rejects the move', async () => {
    const own = email('m1');
    useEmailStore.setState({ emails: [own], selectedEmail: own });
    const after = vi.fn();
    emailHooks.onAfterEmailMove.register('fixture', after);
    const off = emailHooks.onBeforeEmailMove.register('fixture', () => false);
    await expect(call(WRITER, 'email.archive', ['m1'])).rejects.toThrow(/stopped/);
    expect(client.batchMoveEmails).not.toHaveBeenCalled();
    off.dispose();
    client.batchMoveEmails.mockRejectedValueOnce(new Error('not confirmed'));
    await expect(call(WRITER, 'email.archive', ['m1'])).rejects.toThrow('not confirmed');
    expect(useEmailStore.getState().emails).toEqual([own]);
    expect(useEmailStore.getState().selectedEmail).toEqual(own);
    expect(after).not.toHaveBeenCalled();
  });

  it('refuses unknown or shared folders, empty and huge lists, and plugins without email:write', async () => {
    await expect(call(WRITER, 'email.move', ['m1'], 'nope')).rejects.toThrow(/no folder/);
    await expect(call(WRITER, 'email.move', ['m1'], 'acc2:box')).rejects.toThrow(/no folder/);
    await expect(call(WRITER, 'email.move', [], 'inbox')).rejects.toThrow(/non-empty/);
    await expect(call(WRITER, 'email.move', Array.from({ length: 101 }, (_, i) => `m${i}`), 'inbox')).rejects.toThrow(/at most 100/);
    await expect(call(plugin(['email:read']), 'email.archive', ['m1'])).rejects.toThrow(/lacks permission "email:write"/);
    expect(client.batchMoveEmails).not.toHaveBeenCalled();
  });

  it('says when there is no Archive folder', async () => {
    client.getMailboxes.mockResolvedValue([inbox]);
    await expect(call(WRITER, 'email.archive', ['m1'])).rejects.toThrow(/no Archive folder/);
  });

  it('limits how often a plugin moves mail', async () => {
    for (let i = 0; i < 20; i++) await call(WRITER, 'email.move', ['m1'], 'inbox');
    await expect(call(WRITER, 'email.move', ['m1'], 'inbox')).rejects.toThrow(/too many moves/);
  });
});
