// @vitest-environment node
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('@/lib/admin/plugin-registry', () => ({ getPlugin: vi.fn() }));
vi.mock('@/lib/admin/plugin-config', () => ({ getPluginConfig: vi.fn() }));
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));
vi.mock('@/lib/admin/config-manager', () => ({ configManager: { ensureLoaded: async () => {}, getPolicy: () => ({ features: { pluginsEnabled: true } }) } }));
vi.mock('@/lib/stalwart/server-fetch', async (original) => ({ ...await original<typeof import('@/lib/stalwart/server-fetch')>(), isTrustedJmapServerUrl: async () => true }));

import { getPlugin } from '@/lib/admin/plugin-registry';
import { getPluginConfig } from '@/lib/admin/plugin-config';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { proxyRequest, resetProxyLimits } from '@/lib/plugin-secrets/proxy';
import { readFileGrant, putFileGrant } from '@/lib/plugin-secrets/file-grants';
import { GET as grantInfo, POST as grant, DELETE as revoke } from '@/app/api/plugin-file-grants/route';
import { POST as fileResource } from '@/app/api/plugin-files/route';

let nativeOrigin = '';
let vault = '';
let actor = 'alice';
let principalSuffix = '';
let pluginEnabled = true;
let permissions = ['files:read', 'http:proxy'];
const services: Record<string, { origin: string; key: string; seen: http.IncomingHttpHeaders[] }> = {};
const servers: http.Server[] = [];
const nodes = [
  { id: 'docs', parentId: null, name: 'documents', type: 'd', blobId: null, size: 0, modified: '' },
  { id: 'photos', parentId: null, name: 'photos', type: 'd', blobId: null, size: 0, modified: '' },
  { id: 'report', parentId: 'docs', name: 'report.pdf', type: 'application/pdf', blobId: 'private-blob-1', size: 3, modified: '2026-01-01T00:00:00Z' },
  { id: 'picture', parentId: 'photos', name: 'photo.jpg', type: 'image/jpeg', blobId: 'private-blob-2', size: 3, modified: '2026-01-01T00:00:00Z' },
];

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  process.env.SESSION_SECRET = 'fixture-only-host-master-secret-at-least-32-bytes';
  vault = await mkdtemp(path.join(tmpdir(), 'plugin-file-grants-'));
  process.env.PLUGIN_SECRETS_DIR = vault;
  nativeOrigin = await listen(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const username = Buffer.from(String(request.headers.authorization).replace('Basic ', ''), 'base64').toString().split(':')[0];
    if (request.url === '/jmap/session') {
      response.end(JSON.stringify({ apiUrl: nativeOrigin + '/jmap', downloadUrl: nativeOrigin + '/download/{accountId}/{blobId}/{name}', primaryAccounts: { 'urn:ietf:params:jmap:mail': `mail-${username}${principalSuffix}`, 'urn:ietf:params:jmap:filenode': `files-${username}${principalSuffix}` }, capabilities: { 'urn:ietf:params:jmap:core': { maxObjectsInGet: 2 } } }));
      return;
    }
    if (request.url?.startsWith('/download/')) { response.setHeader('Content-Type', 'application/octet-stream'); response.end(new Uint8Array([0, 1, 2])); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const [method, args, id] = JSON.parse(raw).methodCalls[0];
    let value: Record<string, unknown> = {};
    if (method === 'FileNode/query') {
      const matching = nodes.filter((node) => node.parentId === (args.filter.isTopLevel ? null : args.filter.parentId));
      value = { ids: matching.slice(args.position, args.position + 1).map((node) => node.id), total: matching.length, queryState: JSON.stringify(nodes) };
    }
    if (method === 'FileNode/get') value = { list: nodes.filter((node) => args.ids.includes(node.id)), notFound: args.ids.filter((key: string) => !nodes.some((node) => node.id === key)) };
    response.end(JSON.stringify({ methodResponses: [[method, value, id]] }));
  });
  for (const id of ['document-ocr', 'photo-index']) {
    const seen: http.IncomingHttpHeaders[] = [];
    const origin = await listen((request, response) => { seen.push(request.headers); request.resume(); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ ok: true, path: request.url })); });
    services[id] = { origin, key: `fixture-${id}-key`, seen };
  }
});

afterAll(async () => {
  for (const server of servers) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  await rm(vault, { recursive: true, force: true });
});

beforeEach(() => {
  actor = 'alice'; principalSuffix = ''; pluginEnabled = true; permissions = ['files:read', 'http:proxy'];
  nodes[2].blobId = 'private-blob-1'; nodes[2].parentId = 'docs';
  resetProxyLimits();
  for (const service of Object.values(services)) service.seen.length = 0;
  vi.mocked(getPlugin).mockImplementation(async (id) => {
    const service = services[id];
    if (!service) return null;
    return { id, enabled: pluginEnabled, permissions, credentials: { processor: { label: 'Processing service', scope: 'admin', inject: { type: 'bearer' }, secretKey: 'key', origin: service.origin, attestUser: true } } } as never;
  });
  vi.mocked(getPluginConfig).mockImplementation(async (id) => ({ key: services[id]?.key }));
  vi.mocked(getStalwartCredentials).mockImplementation(async () => ({ serverUrl: nativeOrigin, username: actor, authHeader: `Basic ${Buffer.from(`${actor}:native-password`).toString('base64')}`, trusted: true, hasSessionCookie: true, slot: 0 }));
});

function management(plugin = 'document-ocr', method = 'GET', body?: object) {
  return new NextRequest(`https://webmail.example/base/api/plugin-file-grants?plugin=${plugin}&credential=processor`, { method, headers: { Host: 'webmail.example', Origin: 'https://webmail.example', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
}
async function approve(plugin: string, paths: string[]) {
  return grant(management(plugin, 'POST', { paths, expiresIn: 3600, expectedOrigin: services[plugin].origin }));
}
async function backend(plugin: string) {
  const native = (await getStalwartCredentials(management()))!;
  const response = await proxyRequest({ pluginId: plugin, credentialId: 'processor', user: native, url: '/work?mode=test', method: 'POST', headers: new Headers({ 'x-bulwark-identity': 'forged', Authorization: 'native-or-forged' }), body: null, identity: { native, issuer: 'https://webmail.example', resourceUrl: 'https://webmail.example/base/api/plugin-files' } });
  expect(await response.json()).toMatchObject({ path: '/work?mode=test' });
  const token = String(services[plugin].seen.at(-1)?.['x-bulwark-identity']);
  const [header, payload, signature] = token.split('.');
  expect(signature).toBe(createHmac('sha256', services[plugin].key).update(`${header}.${payload}`).digest('base64url'));
  return JSON.parse(Buffer.from(payload, 'base64url').toString()) as { sub: string; plugin: string; aud: string; exp: number; iat: number; files?: { token: string; url: string } };
}
async function resource(token: string, body: object) {
  return fileResource(new NextRequest('https://webmail.example/base/api/plugin-files', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

describe('generic companion backends', () => {
  it('uses the same API for OCR and image indexing, with destination-bound pairwise identities and no native secret', async () => {
    const ocr = await backend('document-ocr');
    const photo = await backend('photo-index');
    expect(ocr.plugin).toBe('document-ocr'); expect(photo.plugin).toBe('photo-index');
    expect(ocr.aud).toBe(services['document-ocr'].origin); expect(photo.aud).toBe(services['photo-index'].origin);
    expect(ocr.sub).not.toBe(photo.sub);
    expect(ocr.exp - ocr.iat).toBe(60);
    expect(JSON.stringify([ocr, photo])).not.toMatch(/native-password|authHeader|Basic/);
    expect(services['document-ocr'].seen[0].authorization).toBe(`Bearer ${services['document-ocr'].key}`);
    expect(ocr.files).toBeUndefined();
  });

  it('delegates PDF/image read scopes with opaque tokens while keeping native access host-only', async () => {
    expect((await approve('document-ocr', ['documents'])).status).toBe(200);
    const metadata = await (await grantInfo(management())).json();
    expect(metadata.grant).toMatchObject({ granted: true, paths: ['documents'] });
    expect(JSON.stringify(metadata)).not.toMatch(/native-password|authHeader|token/);
    const ocr = await backend('document-ocr');
    expect(ocr.files?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listing = await (await resource(ocr.files!.token, { operation: 'list' })).json();
    expect(listing.files.map((file: { fileId: string }) => file.fileId)).toEqual(['report']);
    expect(JSON.stringify(listing)).not.toMatch(/picture|private-blob/);
    const read = await resource(ocr.files!.token, { operation: 'read', fileId: 'report', version: listing.files[0].version });
    expect(read.status).toBe(200); expect([...new Uint8Array(await read.arrayBuffer())]).toEqual([0, 1, 2]);
    expect((await resource(ocr.files!.token, { operation: 'read', fileId: 'picture', version: listing.files[0].version })).status).toBe(403);
    expect((await approve('photo-index', ['photos/photo.jpg'])).status).toBe(200);
    const photos = await backend('photo-index');
    expect(photos.files?.token).not.toBe(ocr.files?.token);
    const image = await (await resource(photos.files!.token, { operation: 'list' })).json();
    expect(image.files.map((file: { fileId: string }) => file.fileId)).toEqual(['picture']);
    const allStored = [];
    for (const kind of ['tokens', 'owners']) for (const name of await readdir(path.join(vault, 'file-grants', kind))) allStored.push(await readFile(path.join(vault, 'file-grants', kind, name), 'utf8'));
    expect(allStored.join('')).not.toMatch(/native-password|authHeader|private-blob/);
  });

  it('rejects stale versions, moved files, expired/replaced grants and explicit revocation', async () => {
    await approve('document-ocr', ['documents']);
    const first = (await backend('document-ocr')).files!.token;
    const listing = await (await resource(first, { operation: 'list' })).json();
    nodes[2].blobId = 'changed';
    expect((await resource(first, { operation: 'read', fileId: 'report', version: listing.files[0].version })).status).toBe(403);
    nodes[2].blobId = 'private-blob-1'; nodes[2].parentId = 'photos';
    expect((await resource(first, { operation: 'read', fileId: 'report', version: listing.files[0].version })).status).toBe(403);
    nodes[2].parentId = 'docs';
    await approve('document-ocr', ['documents/report.pdf']);
    expect((await resource(first, { operation: 'list' })).status).toBe(401);
    const second = (await backend('document-ocr')).files!.token;
    const record = (await readFileGrant(second))!;
    await putFileGrant({ ...record, expiresAt: Date.now() - 1 });
    expect((await resource(second, { operation: 'list' })).status).toBe(401);
    await approve('document-ocr', ['documents']);
    const third = (await backend('document-ocr')).files!.token;
    expect((await revoke(management('document-ocr', 'DELETE'))).status).toBe(200);
    expect((await resource(third, { operation: 'list' })).status).toBe(401);
  });

  it('isolates users and refuses capabilities after permission removal, account recreation or backend key rotation', async () => {
    await approve('document-ocr', ['documents']);
    const alice = await backend('document-ocr');
    actor = 'bob';
    expect((await backend('document-ocr')).files).toBeUndefined();
    actor = 'alice';
    principalSuffix = '-recreated';
    expect((await resource(alice.files!.token, { operation: 'list' })).status).toBe(403);
    principalSuffix = '';
    permissions = ['http:proxy'];
    expect((await resource(alice.files!.token, { operation: 'list' })).status).toBe(403);
    permissions = ['files:read', 'http:proxy'];
    const key = services['document-ocr'].key;
    services['document-ocr'].key = key + '-rotated';
    expect((await resource(alice.files!.token, { operation: 'list' })).status).toBe(403);
    services['document-ocr'].key = key;
    pluginEnabled = false;
    expect((await resource(alice.files!.token, { operation: 'list' })).status).toBe(403);
  });

  it('requires exact consent destination, bounded expiry and supported operations', async () => {
    const invalid = management('document-ocr', 'POST', { paths: ['documents'], expiresIn: 3600, expectedOrigin: 'https://changed.example' });
    expect((await grant(invalid)).status).toBe(400);
    expect((await grant(management('document-ocr', 'POST', { paths: ['documents'], expiresIn: 8 * 24 * 3600, expectedOrigin: services['document-ocr'].origin }))).status).toBe(400);
    await approve('document-ocr', ['documents']);
    const token = (await backend('document-ocr')).files!.token;
    expect((await resource(token, { operation: 'write', fileId: 'report' })).status).toBe(400);
    expect((await resource('forged', { operation: 'list' })).status).toBe(401);
  });
});
