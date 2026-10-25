import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { useAccountStore, type AccountEntry } from '@/stores/account-store';
import { generateAccountId } from '@/lib/account-utils';

const mode = vi.hoisted(() => ({ lite: false }));
vi.mock('@/lib/lite', async (original) => ({
  ...(await original<typeof import('@/lib/lite')>()),
  get IS_LITE() { return mode.lite; },
}));

const OriginalURL = URL;
const clicks: HTMLAnchorElement[] = [];

function account(username: string, slot: number): AccountEntry {
  return {
    id: generateAccountId(username, 'https://mail.example.test'),
    username, serverUrl: 'https://mail.example.test', cookieSlot: slot,
    label: username, authMode: 'oauth', rememberMe: true, displayName: username,
    email: username, avatarColor: '#2563eb', lastLoginAt: 1, isConnected: true,
    hasError: false, isDefault: false,
  };
}

function client() {
  const instance = new JMAPClient('https://mail.example.test', 'owner@example.test', 'test-only-password');
  Object.assign(instance, { accountId: 'own-account' });
  const fetchBlob = vi.spyOn(instance, 'fetchBlob').mockResolvedValue(new Blob(['probe']));
  const ping = vi.spyOn(instance, 'ping').mockResolvedValue();
  return { instance, fetchBlob, ping };
}

beforeEach(() => {
  mode.lite = false;
  clicks.length = 0;
  window.history.replaceState({}, '', '/en/files');
  useAccountStore.setState({ accounts: [account('owner@example.test', 3), account('other@example.test', 0)], activeAccountId: account('other@example.test', 0).id });
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = vi.fn(() => 'blob:test-only-buffered-download');
    static revokeObjectURL = vi.fn();
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { clicks.push(this); });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useAccountStore.setState({ accounts: [], activeAccountId: null });
});

describe('native browser downloads in the Full build', () => {
  it('uses the calling login slot and delegated Blob account without buffering a Blob', async () => {
    const { instance, fetchBlob, ping } = client();
    await instance.downloadBlob('shared-blob', '한글 report.pdf', 'application/pdf', 'delegated-account');
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(ping).toHaveBeenCalledOnce();
    expect(clicks).toHaveLength(1);
    const url = new URL(clicks[0].href);
    expect(url.pathname).toBe('/api/download');
    expect(url.searchParams.get('slot')).toBe('3');
    expect(url.searchParams.get('accountId')).toBe('delegated-account');
    expect(url.searchParams.get('blobId')).toBe('shared-blob');
    expect(url.searchParams.get('name')).toBe('한글 report.pdf');
    expect(url.searchParams.get('clientAccountId')).toBe(account('owner@example.test', 3).id);
    expect(url.href).not.toContain('test-only-password');
    expect(url.searchParams.has('token')).toBe(false);
    expect(url.searchParams.has('authorization')).toBe(false);
  });

  it('waits for authentication preparation before starting the browser transfer', async () => {
    const { instance, ping } = client();
    let finish!: () => void;
    ping.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const pending = instance.downloadBlob('blob', 'file.bin');
    expect(clicks).toHaveLength(0);
    finish();
    await pending;
    expect(clicks).toHaveLength(1);
  });

  it('does not start a download after authentication preparation fails', async () => {
    const { instance, ping, fetchBlob } = client();
    ping.mockRejectedValue(new Error('test-only-auth-failure'));
    await expect(instance.downloadBlob('blob', 'file.bin')).rejects.toThrow('test-only-auth-failure');
    expect(clicks).toHaveLength(0);
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it('does not hand a download to a reused cookie slot after an in-flight sign-out', async () => {
    const { instance, ping } = client();
    ping.mockImplementation(async () => {
      useAccountStore.setState({ accounts: [account('other@example.test', 3)] });
    });
    await expect(instance.downloadBlob('blob', 'file.bin')).rejects.toThrow('Download account changed');
    expect(clicks).toHaveLength(0);
  });

  it('keeps a reverse proxy mount prefix', async () => {
    window.history.replaceState({}, '', '/webmail/ko/files');
    const { instance } = client();
    await instance.downloadBlob('blob', 'file.bin');
    expect(new URL(clicks[0].href).pathname).toBe('/webmail/api/download');
  });

  it('refreshes an expired Bearer through the existing client callback before the transfer', async () => {
    const refresh = vi.fn().mockResolvedValue('test-only-fresh-token');
    const instance = JMAPClient.withBearer('https://mail.example.test', 'test-only-expired-token', 'owner@example.test', refresh);
    Object.assign(instance, { accountId: 'own-account', apiUrl: 'https://mail.example.test/jmap/' });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ methodResponses: [['Core/echo', { ping: 'pong' }, '0']] })));
    vi.stubGlobal('fetch', fetcher);
    await instance.downloadBlob('blob', 'file.bin');
    expect(refresh).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer test-only-expired-token');
    expect(new Headers(fetcher.mock.calls[1][1].headers).get('Authorization')).toBe('Bearer test-only-fresh-token');
    expect(clicks).toHaveLength(1);
  });

  it('retains direct Blob downloads in Lite without an extra auth preparation', async () => {
    mode.lite = true;
    const { instance, fetchBlob, ping } = client();
    await instance.downloadBlob('blob', 'file.bin');
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
    expect(clicks[0].href).toBe('blob:test-only-buffered-download');
  });

  it('retains direct downloads for an unregistered client', async () => {
    useAccountStore.setState({ accounts: [] });
    const { instance, fetchBlob, ping } = client();
    await instance.downloadBlob('blob', 'file.bin');
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
    expect(clicks[0].href).toBe('blob:test-only-buffered-download');
  });

  it('retains the interactive legacy Basic+TOTP path', async () => {
    const { instance, fetchBlob, ping } = client();
    instance.enableTotpReauth('test-only-password', vi.fn().mockResolvedValue('123456'));
    await instance.downloadBlob('blob', 'file.bin');
    expect(fetchBlob).toHaveBeenCalledOnce();
    expect(ping).not.toHaveBeenCalled();
    expect(clicks[0].href).toBe('blob:test-only-buffered-download');
  });
});
