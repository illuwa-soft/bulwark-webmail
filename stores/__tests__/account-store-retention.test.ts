import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAccountStore } from '../account-store';

const signedInAt = new Date('2026-10-26T12:00:00Z');
const expiresAt = new Date('2126-10-26T12:00:00Z').getTime();

/** Seed a real persisted registry without a live session. / 실제 세션 없이 저장된 계정 목록을 준비합니다. */
function seedRegistry(extra: Record<string, unknown> = {}) {
  localStorage.setItem('account-registry', JSON.stringify({
    version: 0,
    state: {
      accounts: [{
        id: 'gmail', username: 'user@gmail.com', serverUrl: 'https://gmail.example.com',
        label: 'Personal Gmail', displayName: 'Personal Gmail', email: 'user@gmail.com',
        avatarColor: '#123456', cookieSlot: 1, authMode: 'basic', rememberMe: true,
        lastLoginAt: signedInAt.getTime(), isConnected: false, hasError: false, isDefault: true,
        ...extra,
      }],
      activeAccountId: 'gmail', defaultAccountId: 'gmail',
    },
  }));
}

describe('account list retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(signedInAt);
    useAccountStore.setState({ accounts: [], activeAccountId: null, defaultAccountId: null });
    localStorage.clear();
  });

  afterEach(() => vi.useRealTimers());

  it('migrates an existing entry to a 100-calendar-year metadata lifetime', async () => {
    seedRegistry();
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts[0]).toMatchObject({
      label: 'Personal Gmail', cookieSlot: 1, listRetainedUntil: expiresAt,
    });
  });

  it('keeps a signed-out account after a year of inactivity and another reload', async () => {
    seedRegistry({ awaitingSignIn: true, rememberMe: false, listRetainedUntil: expiresAt });
    vi.setSystemTime(new Date('2027-10-26T12:00:00Z'));
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts).toHaveLength(1);
    expect(useAccountStore.getState().accounts[0]).toMatchObject({ awaitingSignIn: true, isConnected: false });
  });

  it('expires metadata at its 100-year deadline and repairs the active/default selections', async () => {
    seedRegistry({ listRetainedUntil: expiresAt });
    vi.setSystemTime(new Date(expiresAt));
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts).toEqual([]);
    expect(useAccountStore.getState().activeAccountId).toBeNull();
    expect(useAccountStore.getState().defaultAccountId).toBeNull();
  });

  it('does not resurrect an explicitly removed account on reload', async () => {
    seedRegistry();
    await useAccountStore.persist.rehydrate();
    useAccountStore.getState().removeAccount('gmail');
    await useAccountStore.persist.rehydrate();
    expect(useAccountStore.getState().accounts).toEqual([]);
  });

  it('renews retention after successful sign-in but not after an authentication failure', async () => {
    seedRegistry({ listRetainedUntil: expiresAt });
    await useAccountStore.persist.rehydrate();
    vi.setSystemTime(new Date('2027-10-26T12:00:00Z'));
    useAccountStore.getState().requireSignIn('gmail');
    expect(useAccountStore.getState().accounts[0].listRetainedUntil).toBe(expiresAt);
    useAccountStore.getState().updateAccount('gmail', { lastLoginAt: Date.now(), awaitingSignIn: false });
    expect(useAccountStore.getState().accounts[0].listRetainedUntil).toBe(new Date('2127-10-26T12:00:00Z').getTime());
  });
});
