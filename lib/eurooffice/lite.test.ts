import { afterAll, expect, it, vi } from 'vitest';

vi.stubEnv('NEXT_PUBLIC_BULWARK_LITE', '1');
const { officeInformation, officeViewUrl } = await import('./client');
afterAll(() => vi.unstubAllEnvs());

it('refuses the cookie-backed connector in Lite before making any server request', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({}));
  try {
    await expect(officeInformation({ id: 'fixture', slot: 0, subject: 'member@example.test', origin: 'https://native.example.test' })).rejects.toThrow('full app');
    expect(officeViewUrl(0, 'a'.repeat(43))).toBe('');
    expect(fetcher).not.toHaveBeenCalled();
  } finally { fetcher.mockRestore(); }
});
