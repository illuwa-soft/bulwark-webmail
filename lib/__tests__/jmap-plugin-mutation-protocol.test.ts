import { afterEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '../jmap/client';
import { dispatchApiCall } from '../plugin-sandbox/host-api';
import type { InstalledPlugin } from '../plugin-types';
import { useAuthStore } from '@/stores/auth-store';

const writer: InstalledPlugin = { id: 'protocol-fixture', name: 'Protocol', version: '1', author: 'test', description: '', type: 'hook', permissions: ['email:write'], grantedPermissions: ['email:write'], entrypoint: 'index.js', enabled: true, status: 'running', settings: {} };
type Call = [string, { update?: Record<string, object>; accountId: string }, string];

function client() {
  const value = new JMAPClient('https://jmap.example.com', 'fixture@example.com', 'test-password');
  Object.assign(value, { apiUrl: 'https://jmap.example.com/api', accountId: 'primary-account' });
  return value;
}

afterEach(() => { vi.restoreAllMocks(); useAuthStore.setState({ client: null }); });

describe('native plugin mutation protocol receipts', () => {
  it('writes standard flags as JMAP PatchObject pointers through the real client', async () => {
    const captured: Call[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { methodCalls: Call[] };
      captured.push(...body.methodCalls);
      return Response.json({ methodResponses: body.methodCalls.map((call) => ['Email/set', { updated: Object.fromEntries(Object.keys(call[1].update ?? {}).map(id => [id, null])) }, call[2]]) });
    });
    useAuthStore.setState({ client: client() });
    await dispatchApiCall(writer, 'email.update', [['mail'], { isRead: false, isFlagged: true }]);
    expect(captured[0][1]).toEqual({ accountId: 'primary-account', update: { mail: { 'keywords/$seen': null, 'keywords/$flagged': true } } });
  });

  it('does not count a whole move batch when the server confirms only one id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ methodResponses: [['Email/set', { updated: { one: null } }, '0']] }));
    await expect(client().batchMoveEmails(['one', 'two'], 'archive')).rejects.toThrow(/confirm/);
  });

  it('rejects a missing keyword-update receipt instead of returning successful void', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ methodResponses: [['Email/set', { updated: {} }, '0']] }));
    await expect(client().batchUpdateKeywords(['mail'], { 'keywords/$seen': true })).rejects.toThrow(/confirm/);
  });
});
