import { test, expect } from '@playwright/test';
import { armCsp, observeCsp } from './frames';

test('Lite keeps the plugin host unavailable and enforces its original external-frame CSP', async ({ page }, info) => {
  await observeCsp(page);
  await page.addInitScript(theme => { if (window === window.top) localStorage.setItem('theme-storage', JSON.stringify({ state: { theme }, version: 0 })); }, String(info.project.metadata.theme));
  // A forged deployer policy must not turn server-backed plugin infrastructure on.
  let policyRequests = 0;
  await page.route('**/policy.json*', route => { policyRequests++; return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: { pluginsEnabled: true, pluginsUploadEnabled: true }, forceEnabledPlugins: ['example-view'] }) }); });
  let externalRequests = 0;
  await page.route('https://canvas.test/**', route => { externalRequests++; return route.fulfill({ body: '<p>unexpected</p>' }); });
  const response = await page.goto(`./${info.project.metadata.locale}/login`);
  await expect.poll(() => policyRequests).toBeGreaterThan(0);
  // Stalwart's entry writes a locale shell over its DOM. Its enforced policy
  // comes from the original entry response, even after that meta is replaced.
  const entry = await response!.text();
  const csp = response?.headers()['content-security-policy'] ?? entry.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/i)?.[1];
  expect(csp).toContain("frame-src 'self' blob:");
  expect(csp).not.toContain("'unsafe-eval'");
  expect(await page.locator('[data-embedded-view]').count()).toBe(0);
  expect(await page.locator('iframe[title^="plugin-"]').count()).toBe(0);
  await armCsp(page);
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = 'https://canvas.test/workspace/'; document.body.append(frame); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __frameViolations: string[] }).__frameViolations.some(value => value.startsWith('https://canvas.test')))).toBe(true);
  expect(externalRequests).toBe(0);
  await page.screenshot({ path: info.outputPath('lite-policy.png') });
});
