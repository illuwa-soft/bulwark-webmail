# Verify plugin embedded views

Use the repository's Node 22 toolchain and lockfile. Tests use a fresh browser
context, synthetic accounts, and test-only `.test` origins. They require no
external application, mail server, or production configuration.

## Full

```sh
npm ci
npx playwright install --with-deps chromium webkit
DEV_MOCK_JMAP=true npm run build
EMBEDDED_VIEWS_WEBKIT=1 npm run test:embedded-views
```

The Full fixture starts the production build on loopback port 3173. It writes
an isolated administrator-approved test plugin and policy under the system
temporary directory. `COOKIE_SECURE=false` applies only to this HTTP mock server;
the production cookie policy is not edited. The external frame URLs still use
HTTPS and are fulfilled inside the test browser.

The 24 cases cover Chromium desktop/mobile and WebKit mobile, each in light/dark
and English/Arabic. Without `EMBEDDED_VIEWS_WEBKIT=1`, 16 Chromium cases run.
Use Playwright's matching browser binaries; an optional
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` override is for explicit diagnostics.

Assertions cover actual opaque sandbox execution, input/message exchange,
retained DOM state, normal leave rejection/approval, long titles, 44-pixel close
targets, a 390-pixel mobile width and reduced viewport height, theme and RTL,
zero popups, undeclared-origin CSP blocking, and navigation channel revocation.
Viewport reduction simulates reduced available space; it does not verify a real
device's soft keyboard or background behavior.

## Lite

Build only inside a disposable checkout: Lite prepare deletes server-only trees.
Keep the Full development checkout intact. In each disposable checkout, build
one target and retain its verified export:

```sh
npm ci
CI=true LITE_LOCALES=en,ar npm run build:lite
# In another disposable checkout, for Stalwart:
CI=true LITE_LOCALES=en,ar npm run build:lite -- --target=stalwart
```

From the Full development checkout, point the tests at the corresponding
absolute export or ZIP path:

```sh
EMBEDDED_VIEWS_MODE=lite EMBEDDED_VIEWS_WEBKIT=1 \
EMBEDDED_VIEWS_LITE_DIR=/absolute/static-checkout/out \
npm run test:embedded-views

EMBEDDED_VIEWS_MODE=lite EMBEDDED_VIEWS_WEBKIT=1 \
EMBEDDED_VIEWS_LITE_TARGET=stalwart \
EMBEDDED_VIEWS_LITE_DIR=/absolute/stalwart-checkout/bulwark-lite-stalwart.zip \
npm run test:embedded-views
```

Each target runs 12 cases (8 without WebKit). The static fixture applies the
actual export's root `_headers` rule together with its inline-script hash policy.
The Stalwart fixture serves the actual ZIP through the existing Application
emulator at `/webmail`. It reads CSP from the original entry response because
the entry replaces its DOM with the locale shell.

The tests verify that a forged policy is fetched, the login shell has no plugin
host, and the browser blocks an external frame before a request is issued.
The unit gate separately verifies forged grants/page scope cannot enable the
API. These are policy/CSP checks, not a real-account Lite plugin integration.

## Results

Results are isolated under `local-data/embedded-views/full`, `lite-static`, and
`lite-stalwart`. JSON reports, screenshots, and failure traces belong to test
artifacts. `EMBEDDED_VIEWS_PORT` changes the port;
`EMBEDDED_VIEWS_STATE_ROOT` changes the temporary fixture-state parent.
`EMBEDDED_VIEWS_BASE_URL` attaches to an explicitly prepared fixture server
instead of starting one. Do not point these mutation-capable tests at production.
