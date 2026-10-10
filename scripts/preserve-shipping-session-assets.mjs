// One-release compatibility bridge for tabs opened on the certified shipping UI.
// Never restore old HTML, worker code, configuration or data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PROJECT_ROOT } from './project-targets.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=JSON.parse(readFileSync(resolve(PROJECT_ROOT,'output/audit/shipping-principal-certified/shipping-served-build.json'),'utf8'));
assert.equal(original.buildSha256,'759a260cbabfe004c9c45d842bbd1b641586e7a531707a57b05b75373d259639','Only the previously certified build may be retained');
const assets=original.files.filter(file=>/^assets\/[^/]+-[A-Za-z0-9_-]+\.(js|css)$/.test(file.path));
assert.equal(assets.length,original.verifiedResourceCount-1,'Every prior executable resource must be retained');
const archive=resolve(PROJECT_ROOT,'output/audit/shipping-session-assets');
const dist=resolve(PROJECT_ROOT,'dist');
const mode=process.argv[2];
assert.ok(['capture','restore'].includes(mode),'Use capture before build or restore after build');
mkdirSync(archive,{recursive:true,mode:0o700});
const restored=[];
for(const file of assets) {
  const source=resolve(mode==='capture'?dist:archive,file.path);
  const destination=resolve(mode==='capture'?archive:dist,file.path);
  assert.equal(digest(readFileSync(source)),file.hash,'Prior resource bytes must match the certificate: '+file.path);
  if(existsSync(destination))assert.equal(digest(readFileSync(destination)),file.hash,'Refuse a resource collision: '+file.path);
  else {mkdirSync(dirname(destination),{recursive:true});copyFileSync(source,destination);restored.push(file.path);}
}
writeFileSync(resolve(archive,mode+'.json'),JSON.stringify({mode,priorBuildSha256:original.buildSha256,
  checked:assets.length,copied:restored.length,files:restored},null,2),{mode:0o600});
console.log(JSON.stringify({mode,checked:assets.length,copied:restored.length,oldHtmlRestored:false}));
