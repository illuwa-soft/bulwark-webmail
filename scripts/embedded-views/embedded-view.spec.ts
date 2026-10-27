import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { installFrames, observeCsp } from './frames';

const diagnostics = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  diagnostics.set(page, messages);
  page.on('console', message => { if (messages.length < 100 && (['warning', 'error'].includes(message.type()) || message.text().startsWith('[example-view]'))) messages.push(message.text()); });
  page.on('pageerror', error => { if (messages.length < 100) messages.push(error.message); });
});
test.afterEach(async ({ page }, info) => {
  await info.attach('browser-diagnostics', { body: (diagnostics.get(page) ?? []).join('\n'), contentType: 'text/plain' });
  if (info.status !== info.expectedStatus) {
    const frames = await Promise.all(page.frames().map(async frame => ({ url: frame.url(), state: await frame.evaluate(() => ({ data: { ...document.body?.dataset }, status: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent) })).catch(() => null) })));
    await info.attach('frame-state', { body: JSON.stringify(frames), contentType: 'application/json' });
  }
});

async function enter(page: Page, info: TestInfo) {
  await page.addInitScript(theme => { if (window === window.top) localStorage.setItem('theme-storage', JSON.stringify({ state: { theme }, version: 0 })); }, String(info.project.metadata.theme));
  await installFrames(page);
  await observeCsp(page);
  await page.goto('/en/login');
  await page.getByRole('button', { name: /^(sign in|تسجيل الدخول)$/i }).first().click();
  await page.waitForURL(/\/mail/, { timeout: 60_000 });
  const response = await page.goto(`/${info.project.metadata.locale}/apps/example-view/workspace`);
  expect(response?.headers()['content-security-policy']).toContain('https://canvas.test');
  expect(response?.headers()['content-security-policy']).toContain('https://form.test');
  const plugin = page.frameLocator('iframe[title="plugin-example-view-slot"]');
  await plugin.getByLabel('Retained input').waitFor();
  expect(await page.locator('iframe[title="plugin-example-view-slot"]').getAttribute('sandbox')).toBe('allow-scripts allow-forms');
  const direction = info.project.metadata.locale === 'ar' ? 'rtl' : 'ltr';
  await expect(page.locator('html')).toHaveAttribute('dir', direction);
  await expect(plugin.locator('html')).toHaveAttribute('dir', direction);
  if (info.project.metadata.theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
  else await expect(page.locator('html')).not.toHaveClass(/dark/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return plugin;
}

test('opaque plugins use approved frames without provider-specific host behavior at every viewport', async ({ page }, info) => {
  const plugin = await enter(page, info);
  let popups = 0;
  page.on('popup', popup => { popups++; void popup.close(); });
  await plugin.getByLabel('Retained input').fill('Retained across views');
  for (const kind of ['canvas', 'form']) {
    await plugin.getByRole('button', { name: `Open ${kind}`, exact: true }).click();
    const frameElement = page.locator('[data-embedded-view] iframe');
    const frame = page.frameLocator('[data-embedded-view] iframe');
    await frame.locator('body[data-bound="true"]').waitFor();
    expect(await frameElement.getAttribute('allow')).toBeNull();
    const bounds = await frameElement.boundingBox();
    expect(bounds?.height).toBeGreaterThan(240);
    expect(bounds?.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    const close = page.locator('[data-embedded-view] header button');
    expect((await close.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expect(close).toBeInViewport();
    await expect(frame.locator('body')).toHaveCSS('background-color', info.project.metadata.theme === 'dark' ? 'rgb(23, 32, 51)' : 'rgb(255, 255, 255)');
    if (info.project.metadata.mobile) await frame.getByLabel('Example input').tap();
    await frame.getByLabel('Example input').fill(`Input from ${kind}`);
    await expect(frame.getByRole('status')).toHaveText(`Echo: Input from ${kind}`);
    if (info.project.metadata.mobile) {
      await page.setViewportSize({ width: 390, height: 540 });
      await expect(close).toBeInViewport();
      expect((await frameElement.boundingBox())?.height).toBeGreaterThan(240);
      await page.setViewportSize({ width: 390, height: 844 });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('html').getAttribute('dir')).toBe(info.project.metadata.locale === 'ar' ? 'rtl' : 'ltr');
    await page.screenshot({ path: info.outputPath(`${kind}.png`) });
    await close.click();
    await expect(page.locator('[data-embedded-view] [role="alert"]')).toBeVisible();
    await frame.getByRole('button', { name: 'Allow leaving', exact: true }).click();
    await expect(frame.locator('body')).toHaveAttribute('data-approved', 'true');
    await close.click();
    await expect(page.locator('[data-embedded-view]')).toHaveCount(0);
    await expect(plugin.getByRole('status')).toHaveText('View closed');
    await expect(plugin.getByLabel('Retained input')).toHaveValue('Retained across views');
  }
  expect(popups).toBe(0);
});

test('the real CSP blocks undeclared origins and navigation invalidates the frame channel', async ({ page }, info) => {
  const plugin = await enter(page, info);
  let undeclaredRequests = 0;
  await page.route('https://undeclared.test/**', route => { undeclaredRequests++; return route.fulfill({ body: '<p>unexpected</p>' }); });
  await page.evaluate(() => { const frame = document.createElement('iframe'); frame.src = 'https://undeclared.test/'; document.body.append(frame); });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __frameViolations: string[] }).__frameViolations.some(value => value.startsWith('https://undeclared.test')))).toBe(true);
  expect(undeclaredRequests).toBe(0);
  await plugin.getByRole('button', { name: 'Open canvas', exact: true }).click();
  const frame = page.frameLocator('[data-embedded-view] iframe');
  await frame.locator('body[data-bound="true"]').waitFor();
  await frame.getByRole('button', { name: 'Navigate frame', exact: true }).click();
  await expect(page.locator('[data-embedded-view]')).toHaveCount(0);
  await expect(plugin.getByRole('status')).toHaveText('View closed');
});
