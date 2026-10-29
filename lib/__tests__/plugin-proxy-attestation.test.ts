// @vitest-environment node
import { expect, it } from 'vitest';
import { checkCredentials } from '@/lib/plugin-secrets/credentials';

it('retains an explicit signed-identity opt-in and rejects malformed declarations', () => {
  const base = { label: 'Processor', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: 'https://processor.example' };
  expect(checkCredentials({ processor: { ...base, attestUser: true } }, { key: { type: 'secret' } }).credentials?.processor).toHaveProperty('attestUser', true);
  expect(checkCredentials({ processor: { ...base, attestUser: 'yes' } }, { key: { type: 'secret' } }).errors.length).toBeGreaterThan(0);
  expect(checkCredentials({ processor: { ...base, scope: 'user', attestUser: true } }, undefined).errors.length).toBeGreaterThan(0);
});
