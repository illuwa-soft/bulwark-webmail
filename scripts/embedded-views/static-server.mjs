import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

// The normal Lite preview has no host headers. This fixture applies the actual
// export's root _headers rule, as the shipped static hosting snippets do.
const root = resolve(process.argv[2]);
const lines = readFileSync(join(root, '_headers'), 'utf8').split('\n');
if (lines[0] !== '/*') throw new Error('Expected a root-mounted static Lite export');
const headers = {};
for (const line of lines.slice(1)) {
  if (!line.startsWith('  ')) break;
  const colon = line.indexOf(':');
  headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
}
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const fileExists = file => { try { return statSync(file).isFile(); } catch { return false; } };
createServer((request, response) => {
  let file;
  try {
    const candidate = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`);
    if (candidate === root || candidate.startsWith(root + sep)) file = [candidate, join(candidate, 'index.html'), `${candidate}.html`].find(fileExists);
  } catch { /* malformed paths are not files */ }
  if (!file) { response.writeHead(404, headers); response.end('Not found'); return; }
  response.writeHead(200, { ...headers, 'Content-Type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}).listen(Number(process.argv[3]), '127.0.0.1');
