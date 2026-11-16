// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
//
// dev_scripts/deploy-web.mjs
//
// Ships the web app (docs/arch-web-app.md §1): `sam deploy` does not.
//
//   node dev_scripts/deploy-web.mjs           audit, build, upload what changed, refresh CloudFront
//   node dev_scripts/deploy-web.mjs --check   audit, build into dist/web/, and print what would change; uploads nothing
//
// 1. `npm audit --audit-level=high` — a high or critical finding stops the deploy before
//    anything is built (§11).
// 2. Build src/ui/web/app/ with esbuild into dist/web/: the script and stylesheet named by a
//    hash of their content, index.html pointing at them. The site's configuration — the
//    Cognito pool, client and domain, the site URL — comes from the stack's outputs; none of it
//    is a secret.
// 3. Upload each file whose MD5 differs from the object's ETag (the bucket is SSE-S3, so a
//    single-part ETag is the MD5): assets first, index.html last, so a page never names a file
//    not yet there. Assets are immutable; index.html is never cached. Earlier assets are kept —
//    a page open in a browser still names them.
// 4. Refresh /index.html in CloudFront only when it changed. Every route is rewritten to
//    /index.html at the edge (WebSpaRewrite), so that one path is the whole release.
// A rerun with nothing changed prints "no changes — already current" and writes nothing.

import { execFileSync }  from 'node:child_process';
import { createHash }    from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild      from 'esbuild';

const ROOT     = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR  = join(ROOT, 'src/ui/web/app');
const OUT_DIR  = join(ROOT, 'dist/web');
const STACK    = 'evomind-infrastructure';
const REGION   = 'us-east-2';

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const IMMUTABLE     = 'public, max-age=31536000, immutable';
const NO_CACHE      = 'no-cache';

/**
 * The site's build configuration and deploy targets, from the stack's outputs.
 *
 * @param {{ OutputKey: string, OutputValue: string }[]} outputs
 */
export function siteTargets(outputs) {
  const value = key => {
    const found = outputs.find(o => o.OutputKey === key)?.OutputValue;
    if (!found) throw new Error(`stack output ${key} is missing`);
    return found;
  };
  return {
    config: {
      userPoolId: value('WebUserPoolId'),
      clientId:   value('WebUserPoolClientId'),
      authDomain: value('WebAuthDomain'),
      siteUrl:    value('WebSiteUrl'),
      region:     REGION,
    },
    bucket:         value('WebSiteBucketName'),
    distributionId: value('WebDistributionId'),
  };
}

/**
 * Build the site in memory.
 *
 * @param {object} config  siteTargets().config — reaches the app as __WEB_CONFIG__
 * @returns {Promise<{ key: string, body: Buffer, contentType: string, cacheControl: string }[]>}
 *          index.html last
 */
export async function buildSite(config) {
  const result = await esbuild.build({
    entryPoints:   { app: join(APP_DIR, 'main.jsx') },
    bundle:        true,
    format:        'esm',
    target:        'es2022',
    minify:        true,
    jsx:           'automatic',
    loader:        { '.jsx': 'jsx' },
    entryNames:    'assets/[name]-[hash]',
    outdir:        OUT_DIR,
    write:         false,
    metafile:      true,
    legalComments: 'eof',
    define:        { 'process.env.NODE_ENV': '"production"', __WEB_CONFIG__: JSON.stringify(config) },
    logLevel:      'silent',
  });

  const assets = result.outputFiles.map(f => ({ key: f.path.slice(OUT_DIR.length + 1), body: Buffer.from(f.contents) }));
  const script = assets.find(a => a.key.endsWith('.js'))?.key;
  const style  = assets.find(a => a.key.endsWith('.css'))?.key;
  if (!script || !style) throw new Error(`the build made no ${script ? 'stylesheet' : 'script'}`);

  const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8')
    .replace('{{script}}', `/${script}`)
    .replace('{{style}}', `/${style}`);

  return [
    ...assets.map(a => ({ ...a, contentType: CONTENT_TYPES[a.key.slice(a.key.lastIndexOf('.'))], cacheControl: IMMUTABLE })),
    { key: 'index.html', body: Buffer.from(html), contentType: CONTENT_TYPES['.html'], cacheControl: NO_CACHE },
  ];
}

export const md5 = body => createHash('md5').update(body).digest('hex');

/**
 * What to upload: each file whose MD5 differs from the object's ETag, in build order (index.html
 * last), and whether index.html is among them.
 *
 * @param {{ key: string, body: Buffer }[]} files
 * @param {Map<string, string>} remote  key → ETag, quotes stripped
 */
export function planUpload(files, remote) {
  const upload = files.filter(f => remote.get(f.key) !== md5(f.body));
  return { upload, unchanged: files.length - upload.length, indexChanged: upload.some(f => f.key === 'index.html') };
}

const aws = args => execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });

function remoteEtags(bucket) {
  const listed = JSON.parse(aws(['s3api', 'list-objects-v2', '--bucket', bucket]).trim() || '{}');
  return new Map((listed.Contents ?? []).map(o => [o.Key, o.ETag.replaceAll('"', '')]));
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  try {
    execFileSync('npm', ['audit', '--audit-level=high'], { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    console.error(String(e.stdout ?? e.message));
    console.error('deploy-web: npm audit found a high-severity issue — nothing deployed');
    process.exit(1);
  }
  console.log('npm audit: no high-severity findings');

  const outputs = JSON.parse(aws(['cloudformation', 'describe-stacks', '--stack-name', STACK])).Stacks[0].Outputs;
  const { config, bucket, distributionId } = siteTargets(outputs);
  const files = await buildSite(config);

  rmSync(OUT_DIR, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(OUT_DIR, f.key)), { recursive: true });
    writeFileSync(join(OUT_DIR, f.key), f.body);
  }
  console.log(`built ${files.length} files into dist/web/: ${files.map(f => f.key).join(', ')}`);

  const plan = planUpload(files, remoteEtags(bucket));
  if (plan.upload.length === 0) {
    console.log('no changes — already current');
    return;
  }
  for (const f of plan.upload) console.log(`${checkOnly ? 'would upload' : 'upload'} ${f.key} (${f.body.length} bytes)`);
  if (checkOnly) {
    console.log(`--check: ${plan.upload.length} to upload, ${plan.unchanged} unchanged${plan.indexChanged ? ', /index.html to refresh' : ''}; nothing uploaded`);
    return;
  }

  for (const f of plan.upload) {
    aws(['s3api', 'put-object', '--bucket', bucket, '--key', f.key, '--body', join(OUT_DIR, f.key),
      '--content-type', f.contentType, '--cache-control', f.cacheControl]);
  }
  if (plan.indexChanged) {
    const inv = JSON.parse(aws(['cloudfront', 'create-invalidation', '--distribution-id', distributionId, '--paths', '/index.html']));
    console.log(`CloudFront: /index.html refreshing (${inv.Invalidation.Id})`);
  }
  console.log(`deployed: ${plan.upload.length} uploaded, ${plan.unchanged} unchanged — ${config.siteUrl}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
