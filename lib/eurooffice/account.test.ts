import { afterEach, expect, it, vi } from 'vitest';
import { JMAPClient } from '@/lib/jmap/client';
import { officeAccount, sameOfficeAccount } from './account';

afterEach(() => vi.restoreAllMocks());

it('uses the authenticated canonical identity instead of a constructor alias', () => {
  const client = JMAPClient.withBearer('https://native.example.test', 'fixture-only-token', 'short-alias');
  vi.spyOn(client, 'getSessionUsername').mockReturnValue('canonical@example.test');
  expect(officeAccount(client, 'account-a', 1)).toEqual({ id: 'account-a', slot: 1, subject: 'canonical@example.test', origin: 'https://native.example.test' });
  const scope = officeAccount(client, 'account-a', 1)!;
  expect(sameOfficeAccount(scope, client, 'account-b')).toBe(false);
  vi.spyOn(client, 'getSessionUsername').mockReturnValue('other@example.test');
  expect(sameOfficeAccount(scope, client, 'account-a')).toBe(false);
});

it('fails closed before Native session identity is available', () => {
  const client = JMAPClient.withBearer('https://native.example.test', 'fixture-only-token', 'unverified-label');
  expect(officeAccount(client, 'account-a', 0)).toBeNull();
  expect(officeAccount(null, 'account-a', 0)).toBeNull();
});
