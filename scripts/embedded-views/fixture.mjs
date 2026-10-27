import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

/** An isolated, administrator-installed, untrusted test plugin; no real account data. */
export function prepareFixture() {
  const artifacts = resolve('local-data/embedded-views');
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(process.env.EMBEDDED_VIEWS_STATE_ROOT || tmpdir(), 'bulwark-embedded-views-'));
  const config = join(directory, 'config');
  const plugins = join(config, 'plugins');
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(config, 'policy.json'), JSON.stringify({ features: { pluginsEnabled: true } }));
  const manifest = JSON.parse(readFileSync('scripts/embedded-views/fixtures/example-view/manifest.json', 'utf8'));
  const code = readFileSync('scripts/embedded-views/fixtures/example-view/index.js', 'utf8');
  const metadata = { ...manifest, enabled: true, forceEnabled: true, installedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', bundleHash: createHash('sha256').update(code).digest('hex') };
  writeFileSync(join(plugins, `${manifest.id}.js`), code);
  writeFileSync(join(plugins, 'registry.json'), JSON.stringify({ plugins: [metadata] }));
  return { config, state: join(directory, 'state'), artifacts };
}
