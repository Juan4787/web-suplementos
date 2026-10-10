// Verify the exact published HTML and every JavaScript/CSS resource in dist.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROJECT_ROOT, WORKER_ORIGIN } from './project-targets.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const directory = resolve(PROJECT_ROOT, 'dist');
const list = (root, prefix = '') => readdirSync(root, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? list(resolve(root, entry.name), prefix + entry.name + '/') : [prefix + entry.name]);
const paths = list(directory).sort();
assert.ok(paths.includes('index.html'));
const files = paths.map(path => ({ path, hash: digest(readFileSync(resolve(directory, path))) }));
const selected = files.filter(file => file.path === 'index.html' || /\.(js|css)$/.test(file.path));
assert.ok(selected.some(file => /SalesPage-.*\.js$/.test(file.path)), 'Sales page must be part of the release');
const checks = [];
for (const file of selected) {
  const url = WORKER_ORIGIN + '/' + file.path.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  assert.equal(response.status, 200, 'Published resource must load: ' + file.path);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())), file.hash, 'Published bytes differ: ' + file.path);
  if (file.path === 'index.html') assert.match(response.headers.get('cache-control') ?? '', /no-cache|no-store/);
  checks.push(file.path);
}
const evidence = { environment: 'production-served-build', at: new Date().toISOString(), origin: WORKER_ORIGIN,
  buildSha256: digest(Buffer.from(files.map(file => file.path + '\t' + file.hash + '\n').join(''))),
  files, verifiedResourceCount: checks.length, verifiedResources: checks };
mkdirSync(resolve(PROJECT_ROOT, 'output/audit'), { recursive: true });
writeFileSync(resolve(PROJECT_ROOT, 'output/audit/shipping-served-build.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ environment: evidence.environment, buildSha256: evidence.buildSha256,
  verifiedResources: checks.length, failures: 0 }));
