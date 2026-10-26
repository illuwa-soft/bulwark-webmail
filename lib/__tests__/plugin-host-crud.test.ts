import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import type { InstalledPlugin } from '../plugin-types';
import type { IJMAPClient } from '../jmap/client-interface';
import type { FileNode, Identity, Mailbox } from '../jmap/types';
import { useAuthStore } from '@/stores/auth-store';
import { useEmailStore } from '@/stores/email-store';
import { emailHooks } from '../plugin-hooks';
import { resetPluginRateLimits } from '../plugin-sandbox/host-api-input';

const writer: InstalledPlugin = { id: 'crud-fixture', name: 'CRUD', version: '1', author: 'test', description: '', type: 'hook', permissions: ['email:read', 'email:write', 'email:send', 'files:write'], grantedPermissions: ['email:read', 'email:write', 'email:send', 'files:write'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {} };
const folder = (id: string, role?: string) => ({ id, name: id, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0 } as Mailbox);
const node = (id = 'file'): FileNode => ({ id, name: 'note.txt', parentId: null, blobId: 'blob', type: 'text/plain', size: 3, created: '2026-10-26T00:00:00Z', modified: '2026-10-26T00:00:00Z' });

function fakeClient() {
  return {
    getAccountId: () => 'primary', getFilesAccountId: () => 'files', getContactsAccountId: () => 'contacts', getCalendarsAccountId: () => 'calendars', getServerUrl: () => 'https://mail.example.test', getUsername: () => 'fixture',
    getMailboxes: vi.fn(async () => [folder('inbox', 'inbox'), folder('archive', 'archive'), folder('trash', 'trash')]),
    batchMoveEmails: vi.fn(async () => {}),
    batchUpdateKeywords: vi.fn(async () => {}),
    getIdentities: vi.fn(async () => [{ id: 'self', name: 'Self', email: 'self@example.test' } as Identity]),
    sendEmail: vi.fn(async () => ({ scheduled: false, emailId: 'sent', emailSubmissionId: 'submission', filingError: 'copy refused', rejectedRecipients: [{ email: 'refused@example.test', smtpReply: '550 refused' }] })),
    getFileNodes: vi.fn(async () => [node()]),
    uploadBlob: vi.fn(async () => ({ blobId: 'uploaded', type: 'text/plain', size: 3, accountId: 'files' })),
    createFileNode: vi.fn(async () => node('created')),
    createFileDirectory: vi.fn(async () => ({ ...node('directory'), blobId: null, type: 'd' })),
    updateFileNode: vi.fn(async () => {}),
    destroyFileNodes: vi.fn(async () => ({ destroyed: ['file'], notDestroyed: [] as string[] })),
    queryReadPage: vi.fn(async () => ({ items: [], total: 0, position: 0, queryState: 'stable', accountId: 'files' }))
  };
}

let client: ReturnType<typeof fakeClient>;
const call = (method: string, ...args: unknown[]) => dispatchApiCall(writer, method, args);

beforeEach(() => {
  client = fakeClient();
  const native: Partial<IJMAPClient> = client;
  useAuthStore.setState({ client: native as IJMAPClient });
  resetPluginRateLimits();
});
afterEach(() => { useAuthStore.setState({ client: null }); useEmailStore.setState({ emails: [], mailboxes: [], selectedMailbox: '', viewingAccountId: null }); vi.restoreAllMocks(); });

describe('primary-account mutation SDK', () => {
  it('binds a delayed IPC command to its original login, never to the newly active one', async () => {
    const scope = await call('mutations.scope');
    const other = fakeClient();
    other.getUsername = () => 'other-user';
    const native: Partial<IJMAPClient> = other;
    useAuthStore.setState({ client: native as IJMAPClient });
    await expect(call('mutations.apply', scope, 'mail-move', [['mail'], 'archive'])).rejects.toThrow('account changed');
    expect(other.batchMoveEmails).not.toHaveBeenCalled();
    expect(client.batchMoveEmails).not.toHaveBeenCalled();
  });

  it('keeps the scoped command catalog closed and applies the normal resource permission gate', async () => {
    const scope = await call('mutations.scope');
    await expect(call('mutations.apply', scope, 'jmap.sendRaw', [])).rejects.toThrow('unsupported command');
    await call('mutations.apply', scope, 'mail-update', [['mail'], { isRead: false, isFlagged: true }]);
    expect(client.batchUpdateKeywords).toHaveBeenCalledWith(['mail'], { 'keywords/$seen': null, 'keywords/$flagged': true }, 'primary');
    await expect(dispatchApiCall({ ...writer, permissions: [], grantedPermissions: [] }, 'mutations.apply', [scope, 'mail-trash', [['mail']]])).rejects.toThrow('email:write');
  });
  it('moves unloaded IDs through the primary client despite a unified or other-account view', async () => {
    useEmailStore.setState({ emails: [], mailboxes: [], selectedMailbox: 'unified:inbox', viewingAccountId: 'other-login' });
    await call('email.move', ['unloaded-1', 'unloaded-2'], 'archive');
    expect(client.batchMoveEmails).toHaveBeenCalledWith(['unloaded-1', 'unloaded-2'], 'archive', 'primary');
  });

  it('moves to the real primary Trash rather than permanently deleting', async () => {
    await call('email.trash', ['unloaded']);
    expect(client.batchMoveEmails).toHaveBeenCalledWith(['unloaded'], 'trash', 'primary');
  });

  it('requires the distinct send permission and respects a fail-closed send guard', async () => {
    await expect(dispatchApiCall({ ...writer, permissions: ['email:write'], grantedPermissions: ['email:write'] }, 'email.send', [{ to: ['a@example.test'], subject: 'Subject', body: 'Body' }])).rejects.toThrow('email:send');
    vi.spyOn(emailHooks.onBeforeEmailSend, 'interceptOutcome').mockResolvedValue('failed');
    await expect(call('email.send', { to: ['a@example.test'], subject: 'Subject', body: 'Body' })).rejects.toThrow(/stopped|guard/);
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it('never falls back to plain send after a crypto takeover', async () => {
    vi.spyOn(emailHooks.onComposeSend, 'takeOver').mockResolvedValue('handled');
    expect(await call('email.send', { to: ['a@example.test'], body: 'Body' })).toMatchObject({ status: 'handled' });
    expect(client.sendEmail).not.toHaveBeenCalled();
  });

  it('preserves submission receipts, filing warnings and rejected recipients', async () => {
    const result = await call('email.send', { to: ['a@example.test'], subject: 'Subject', body: 'Body' });
    expect(result).toMatchObject({ status: 'submitted', submissionId: 'submission', filingFailed: true, rejectedRecipients: ['refused@example.test'] });
    expect(client.sendEmail).toHaveBeenCalledOnce();
  });

  it('creates bounded text, rejects another FileNode account and validates size before upload', async () => {
    await call('files.createText', { name: 'note.txt', text: 'abc' });
    expect(client.createFileNode).toHaveBeenCalledWith('note.txt', 'uploaded', 'text/plain', 3, null);
    await expect(call('files.update', 'another-account:file', { name: 'new.txt' })).rejects.toThrow(/primary|account/);
    await expect(call('files.createText', { name: 'huge.txt', text: '가'.repeat(65536) })).rejects.toThrow(/large|65536|64/);
    expect(client.uploadBlob).toHaveBeenCalledOnce();
  });

  it('stops before node creation if the login changes during upload', async () => {
    client.uploadBlob.mockImplementation(async () => {
      const native: Partial<IJMAPClient> = fakeClient();
      useAuthStore.setState({ client: native as IJMAPClient });
      return { blobId: 'uploaded', type: 'text/plain', size: 3, accountId: 'files' };
    });
    await expect(call('files.createText', { name: 'note.txt', text: 'abc' })).rejects.toThrow(/session|account/);
    expect(client.createFileNode).not.toHaveBeenCalled();
  });

  it('does not report a refused delete as success or delete a non-empty directory', async () => {
    client.destroyFileNodes.mockResolvedValue({ destroyed: [], notDestroyed: ['file'] });
    await expect(call('files.remove', 'file')).rejects.toThrow(/confirm|refused/);
    client.getFileNodes.mockResolvedValue([{ ...node(), type: 'd', blobId: null }]);
    client.queryReadPage.mockResolvedValue({ items: [], total: 1, position: 0, queryState: 'stable', accountId: 'files' });
    await expect(call('files.remove', 'file')).rejects.toThrow(/empty|children/);
    expect(client.destroyFileNodes).toHaveBeenCalledTimes(2);
    expect(client.destroyFileNodes).toHaveBeenLastCalledWith(['file'], { recursive: false });
  });
});
