import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:https';
import { createServer as portServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';

const hostRoot = process.cwd();
for (const route of ['settings', 'view/[slot]/[owner]/[[...path]]']) {
  const trace = JSON.parse(await readFile(join(hostRoot, '.next/server/app/api/eurooffice', route, 'route.js.nft.json'), 'utf8'));
  assert(trace.files.every((path) => !path.includes('/.octocode/')), 'Next production tracing must exclude private connector-check artifacts');
}
const productRoot = resolve(process.env.EUROOFFICE_PRODUCT_ROOT ?? '../euro-office-stalwart-gateway');
const out = resolve('.octocode/tmp/office-connector');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const key = join(run, 'fixture-key.pem');
const cert = join(run, 'fixture-cert.pem');
// These are isolated test-only keys, not deployment credentials. Node trusts only this owned peer via NODE_EXTRA_CA_CERTS.
const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-addext', 'basicConstraints=critical,CA:TRUE'], { stdio: 'ignore', timeout: 30_000 });
assert.equal(certificate.status, 0, 'The local OpenSSL fixture certificate must be generated');
await chmod(key, 0o600);
const sessionSecret = 'connector-check-only-session-key-never-used-in-production';

/** Mint only controlled session-context cookies; the real Next cookie reader decrypts them and the real Worker verifies Native. */
function cookie(username, serverUrl, credential) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(sessionSecret).digest(), iv);
  cipher.setAAD(Buffer.from('session-context'));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify({ username, serverUrl, authHeader: `Bearer ${credential}`, p: 'session-context' })), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

let fixture, next, browser, page;
let officeOrigin;
const failures = [];
const requests = [];
const office = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (request, response) => {
  try {
    const parts = [];
    for await (const part of request) parts.push(part);
    const bytes = Buffer.concat(parts);
    const options = { method: request.method, headers: request.headers };
    if (bytes.length) options.body = bytes;
    const reply = await fixture.fetch(request.url, options);
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    response.end(Buffer.from(await reply.arrayBuffer()));
  } catch { failures.push('Worker HTTP fixture failure'); response.writeHead(500); response.end(); }
});

try {
  await new Promise((done) => office.listen(0, '127.0.0.1', done));
  officeOrigin = `https://127.0.0.1:${office.address().port}`;
  const listener = portServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  const port = listener.address().port;
  await new Promise((done) => listener.close(done));
  const hostOrigin = `http://127.0.0.1:${port}`;
  const { startGatewayFixture } = await import(pathToFileURL(join(productRoot, 'tests/fixtures/gateway.mjs')));
  const { fixtureSecret } = await import(pathToFileURL(join(productRoot, 'tests/fixtures/native-server.mjs')));
  process.chdir(productRoot);
  fixture = await startGatewayFixture({ publicBaseUrl: officeOrigin, embedOrigins: hostOrigin, fileName: 'private-a.md', fileType: 'text/markdown', content: '# Account A private\n' });
  const admin = join(run, 'admin');
  await mkdir(admin);
  await writeFile(join(admin, 'config.json'), JSON.stringify({ setupComplete: true }));
  await writeFile(join(admin, 'policy.json'), JSON.stringify({ features: { pluginsEnabled: true } }));
  next = spawn(process.execPath, [join(hostRoot, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: hostRoot,
    env: { ...process.env, JMAP_SERVER_URL: fixture.native.base, EUROOFFICE_GATEWAY_URL: officeOrigin, SESSION_SECRET: sessionSecret, ADMIN_CONFIG_DIR: admin, ADMIN_STATE_DIR: join(run, 'state'), NODE_EXTRA_CA_CERTS: cert, BULWARK_TELEMETRY: 'off', BULWARK_UPDATE_CHECK: 'off', ADMIN_PASSWORD: 'connector-fixture-only-not-used', COOKIE_SECURE: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  next.stdout.on('data', (chunk) => { log = (log + chunk).slice(-12_000); });
  next.stderr.on('data', (chunk) => { log = (log + chunk).slice(-12_000); });
  let available = false;
  for (let index = 0; index < 120; index++) {
    try { available = (await fetch(`${hostOrigin}/api/health`)).ok; } catch { /* Wait for the owned Next server. */ }
    if (available) break;
    assert(next.exitCode === null, 'Next production server exited before readiness');
    await delay(500);
  }
  assert(available, 'Next production server must become ready');
  const tokenA = cookie('member@example.test', fixture.native.base, 'user-a');
  const tokenB = cookie('other@example.test', fixture.native.base, 'user-b');
  const cookies = `jmap_stalwart_ctx=${tokenA}; jmap_stalwart_ctx_1=${tokenB}; office_workspace_session=stale-account-a`;
  const subjects = ['member@example.test', 'other@example.test'];
  const settings = (slot, input, overrides = {}) => fetch(`${hostOrigin}/api/eurooffice/settings`, {
    method: input ? 'POST' : 'GET', headers: { Cookie: cookies, 'X-JMAP-Cookie-Slot': String(slot), 'X-Office-Expected-Subject': encodeURIComponent(subjects[slot]), 'X-Office-Expected-Origin': fixture.native.base, Origin: hostOrigin, 'Content-Type': 'application/json', ...overrides },
    body: input ? JSON.stringify(input) : undefined, redirect: 'error'
  });
  assert.equal((await fetch(`${hostOrigin}/api/eurooffice/settings`, { headers: { Cookie: cookies } })).status, 400);
  const wrongSubject = await settings(1, undefined, { 'X-Office-Expected-Subject': subjects[0] });
  assert.equal(wrongSubject.status, 409, await wrongSubject.text());
  assert.equal((await settings(0, { action: 'enable', accessConsent: 'mail-server-unlimited-app-password' }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await settings(0, { action: 'connection.save', connection: { serverUrl: fixture.native.base + '/office', jwtHeader: 'AuthorizationJwt', jwtSecret: fixtureSecret } })).status, 200);
  const accounts = [];
  for (const slot of [0, 1]) {
    const response = await settings(slot, { action: 'enable', accessConsent: 'mail-server-unlimited-app-password' });
    assert.equal(response.status, 200);
    accounts.push(await response.json());
  }
  assert.notEqual(accounts[0].ownerId, accounts[1].ownerId);
  assert.equal(accounts[1].connection.hasSecret, true);
  assert.equal(accounts[1].connection.canManage, false);
  await fixture.command({ action: 'files.create', name: 'B-private', kind: 'docx', parentId: null }, 'user-b');
  const view = (slot, owner = accounts[slot].ownerId) => `${hostOrigin}/api/eurooffice/view/${slot}/${owner}`;
  const proxy = (slot, path, options = {}) => fetch(view(slot) + path, { ...options, headers: { Cookie: cookies, Origin: hostOrigin, 'X-Office-Workspace': accounts[slot].workspaceId, ...options.headers } });
  const resource = await (await proxy(0, '/api/v1/eurooffice/workspace/file/file-a')).json();
  const range = await proxy(0, `/api/v1/eurooffice/workspace/content/file-a?workspaceId=${accounts[0].workspaceId}&version=${encodeURIComponent(resource.etag)}`, { headers: { Range: 'bytes=2-8' } });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'Account');
  assert.equal(range.headers.has('set-cookie'), false);
  assert.equal((await fetch(view(1, accounts[0].ownerId), { headers: { Cookie: cookies } })).status, 409);
  assert.equal((await proxy(1, '/api/v1/eurooffice/workspace/file/file-a')).status, 404);
  browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: 'jmap_stalwart_ctx', value: tokenA, url: hostOrigin, httpOnly: true }, { name: 'jmap_stalwart_ctx_1', value: tokenB, url: hostOrigin, httpOnly: true }, { name: 'office_workspace_session', value: 'stale-account-a', url: hostOrigin, httpOnly: true }]);
  page = await context.newPage();
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('response', (response) => requests.push({ path: new URL(response.url()).pathname, status: response.status() }));
  await page.route(hostOrigin + '/__office_fixture', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><iframe title="Office" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox" style="border:0;width:100%;height:95vh" src="${view(0)}"></iframe>` }));
  await page.goto(hostOrigin + '/__office_fixture');
  const app = page.frameLocator('iframe[title="Office"]');
  await app.getByRole('treeitem', { name: 'private-a.md', exact: true }).click();
  await expect(app.locator('.monaco-editor .view-lines')).toContainText('Account A private', { timeout: 20_000 });
  await page.screenshot({ path: join(out, 'native-cookie-proxy.png') });
  await page.evaluate((url) => { globalThis.document.querySelector('iframe').src = url; }, view(1));
  await expect(app.getByRole('treeitem', { name: 'B-private.docx', exact: true })).toBeVisible();
  await expect(app.getByRole('treeitem', { name: 'private-a.md', exact: true })).toHaveCount(0);
  assert.equal((await settings(1, { action: 'disable' })).status, 200);
  assert.equal((await proxy(1, '/api/v1/eurooffice/workspace/file/file-a')).status, 403);
  assert.equal((await (await settings(0)).json()).enabled, true);
  assert.deepEqual(failures, []);
  const receipt = { realNextProductionRoutes: true, realCookieDecryption: true, realWorkerAndD1: true, nativeAndParentShell: 'controlled fixtures', scopedMonacoBrowser: true, commonAdministratorSettings: true, independentAccounts: true, wrongSubjectDenied: true, forgedOwnerDenied: true, crossAccountFileDenied: true, range206: true, staleOfficeCookieIgnored: true, perAccountRevocation: true, errors: failures };
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => {});
  await writeFile(join(out, 'failure.json'), JSON.stringify({ message: error.message, errors: failures, requests: requests.slice(-80) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (next && next.exitCode === null) {
    const stopped = new Promise((done) => next.once('exit', done));
    next.kill('SIGTERM');
    const kill = setTimeout(() => next.kill('SIGKILL'), 10_000);
    await stopped;
    clearTimeout(kill);
  }
  office.closeAllConnections();
  await new Promise((done) => office.close(done));
  await fixture?.close();
}
