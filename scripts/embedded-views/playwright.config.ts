import { defineConfig } from '@playwright/test';
import { resolve, join } from 'node:path';
import { prepareFixture } from './fixture.mjs';

const port = Number(process.env.EMBEDDED_VIEWS_PORT || 3173);
const lite = process.env.EMBEDDED_VIEWS_MODE === 'lite';
const liteTarget = process.env.EMBEDDED_VIEWS_LITE_TARGET || 'static';
if (!['static', 'stalwart'].includes(liteTarget)) throw new Error('Unknown Lite target');
const litePrefix = lite && liteTarget === 'stalwart' ? '/webmail' : '';
const baseURL = process.env.EMBEDDED_VIEWS_BASE_URL || `http://127.0.0.1:${port}${litePrefix}/`;
const liteDirectory = process.env.EMBEDDED_VIEWS_LITE_DIR;
if (lite && !liteDirectory && !process.env.EMBEDDED_VIEWS_BASE_URL) throw new Error('Set EMBEDDED_VIEWS_LITE_DIR to a verified disposable Lite export');
const fixture = lite ? null : prepareFixture();
const artifacts = resolve('local-data/embedded-views', lite ? `lite-${liteTarget}` : 'full');
const projects = [];
for (const mobile of [false, true]) for (const theme of ['light', 'dark'] as const) for (const locale of ['en', 'ar']) {
  projects.push({
    name: `${mobile ? 'mobile' : 'desktop'}-${theme}-${locale}`,
    use: { browserName: 'chromium' as const, launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, baseURL, colorScheme: theme, locale: locale === 'ar' ? 'ar' : 'en-US', viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, hasTouch: mobile, isMobile: mobile },
    metadata: { mobile, theme, locale },
  });
}
if (process.env.EMBEDDED_VIEWS_WEBKIT === '1') for (const theme of ['light', 'dark'] as const) for (const locale of ['en', 'ar']) {
  projects.push({
    name: `webkit-mobile-${theme}-${locale}`,
    use: { browserName: 'webkit' as const, launchOptions: {}, baseURL, colorScheme: theme, locale: locale === 'ar' ? 'ar' : 'en-US', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
    metadata: { mobile: true, theme, locale },
  });
}

export default defineConfig({
  testDir: '.',
  testMatch: lite ? /lite-policy\.spec\.ts$/ : /embedded-view\.spec\.ts$/,
  timeout: 90_000,
  retries: 0,
  workers: 1,
  outputDir: join(artifacts, 'results'),
  reporter: [['list'], ['json', { outputFile: join(artifacts, 'report.json') }]],
  use: {
    actionTimeout: 30_000,
    trace: 'retain-on-failure', screenshot: 'only-on-failure',
  },
  projects,
  webServer: process.env.EMBEDDED_VIEWS_BASE_URL ? undefined : lite ? {
    command: `node ${litePrefix ? 'scripts/lite/serve.mjs' : 'scripts/embedded-views/static-server.mjs'} ${JSON.stringify(liteDirectory)} ${port}${litePrefix ? ` --stalwart=${litePrefix}` : ''}`,
    cwd: process.cwd(), url: baseURL, reuseExistingServer: false, timeout: 120_000,
  } : {
    command: `node node_modules/next/dist/bin/next start -H 127.0.0.1 -p ${port}`,
    cwd: process.cwd(),
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DEV_MOCK_JMAP: 'true', JMAP_SERVER_URL: new URL('api/dev-jmap', baseURL).href,
      SESSION_SECRET: 'embedded-view-fixture-secret-0123456789abcdef',
      // The isolated mock server is HTTP; WebKit correctly rejects Secure cookies there.
      COOKIE_SECURE: 'false',
      ADMIN_CONFIG_DIR: fixture!.config, ADMIN_STATE_DIR: fixture!.state,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
