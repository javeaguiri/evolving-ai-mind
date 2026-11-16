// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/deploy-web.test.mjs
//
// Sprint 17 scope 1 (docs/arch-web-app.md §1, §11): dev_scripts/deploy-web.mjs — the site's
// build and upload plan. The build runs for real, in memory; nothing touches AWS. A rerun with
// nothing changed must plan nothing (Sprint 16 retro: an upsert proves its rerun).

import { describe, it, before } from 'node:test';
import assert                   from 'node:assert/strict';

import { siteTargets, buildSite, planUpload, md5 } from '../../dev_scripts/deploy-web.mjs';

const OUTPUTS = [
  { OutputKey: 'WebUserPoolId',       OutputValue: 'us-east-2_pool' },
  { OutputKey: 'WebUserPoolClientId', OutputValue: 'client123' },
  { OutputKey: 'WebAuthDomain',       OutputValue: 'https://example.auth.us-east-2.amazoncognito.com' },
  { OutputKey: 'WebSiteUrl',          OutputValue: 'https://site.example' },
  { OutputKey: 'WebSiteBucketName',   OutputValue: 'site-bucket' },
  { OutputKey: 'WebDistributionId',   OutputValue: 'EDIST' },
  { OutputKey: 'Unrelated',           OutputValue: 'x' },
];

describe('siteTargets — from the stack outputs', () => {
  it('reads the config, the bucket and the distribution', () => {
    assert.deepEqual(siteTargets(OUTPUTS), {
      config: { userPoolId: 'us-east-2_pool', clientId: 'client123', authDomain: 'https://example.auth.us-east-2.amazoncognito.com', siteUrl: 'https://site.example', region: 'us-east-2' },
      bucket: 'site-bucket', distributionId: 'EDIST',
    });
  });

  it('names an output that is missing', () => {
    assert.throws(() => siteTargets(OUTPUTS.filter(o => o.OutputKey !== 'WebDistributionId')), /WebDistributionId/);
  });
});

describe('buildSite — hashed assets, index.html last', () => {
  let files;
  let again;
  before(async () => {
    const { config } = siteTargets(OUTPUTS);
    files = await buildSite(config);
    again = await buildSite(config);
  });

  it('makes one script, one stylesheet, then index.html', () => {
    assert.equal(files.length, 3);
    assert.match(files[0].key + files[1].key, /assets\/app-[A-Z0-9]+\.(js|css)assets\/app-[A-Z0-9]+\.(js|css)/);
    assert.equal(files[2].key, 'index.html');
  });

  it('index.html names the hashed files, and runs nothing inline (CSP)', () => {
    const html   = files[2].body.toString();
    const script = files.find(f => f.key.endsWith('.js')).key;
    const style  = files.find(f => f.key.endsWith('.css')).key;
    assert.ok(html.includes(`<script type="module" src="/${script}"></script>`));
    assert.ok(html.includes(`<link rel="stylesheet" href="/${style}">`));
    assert.doesNotMatch(html, /\{\{|<script>|<style>|\son[a-z]+="/);
  });

  it('assets are immutable, index.html never cached, each with its type', () => {
    for (const f of files) {
      if (f.key === 'index.html') assert.deepEqual([f.contentType, f.cacheControl], ['text/html; charset=utf-8', 'no-cache']);
      else assert.equal(f.cacheControl, 'public, max-age=31536000, immutable');
    }
    assert.equal(files.find(f => f.key.endsWith('.js')).contentType, 'text/javascript; charset=utf-8');
    assert.equal(files.find(f => f.key.endsWith('.css')).contentType, 'text/css; charset=utf-8');
  });

  it('bundles the catalog and no internal key', () => {
    const js = files.find(f => f.key.endsWith('.js')).body.toString();
    assert.ok(js.includes('Home Brain'));
    assert.doesNotMatch(js, /INTERNAL_API_KEY|x-api-key/i);
  });

  it('builds byte for byte the same twice — the ground of a no-op rerun', () => {
    assert.deepEqual(again.map(f => [f.key, md5(f.body)]), files.map(f => [f.key, md5(f.body)]));
  });

  it('a rerun against what the first run uploaded plans nothing', () => {
    const uploaded = new Map(files.map(f => [f.key, md5(f.body)]));
    assert.deepEqual(planUpload(again, uploaded), { upload: [], unchanged: 3, indexChanged: false });
  });
});

describe('planUpload — only what changed, index.html last', () => {
  const file = (key, text) => ({ key, body: Buffer.from(text) });
  const site = [file('assets/app-NEW.js', 'js'), file('assets/app-A.css', 'css'), file('index.html', 'html')];

  it('an empty bucket takes everything, index.html last', () => {
    const plan = planUpload(site, new Map());
    assert.deepEqual(plan.upload.map(f => f.key), ['assets/app-NEW.js', 'assets/app-A.css', 'index.html']);
    assert.equal(plan.indexChanged, true);
  });

  it('a changed script uploads it and the index that names it, nothing else', () => {
    const remote = new Map([['assets/app-OLD.js', md5('old')], ['assets/app-A.css', md5('css')], ['index.html', md5('old html')]]);
    const plan   = planUpload(site, remote);
    assert.deepEqual(plan.upload.map(f => f.key), ['assets/app-NEW.js', 'index.html']);
    assert.equal(plan.unchanged, 1);
  });

  it('an object changed in the bucket is put back', () => {
    const remote = new Map(site.map(f => [f.key, md5(f.body)]));
    remote.set('assets/app-A.css', md5('tampered'));
    assert.deepEqual(planUpload(site, remote), { upload: [site[1]], unchanged: 2, indexChanged: false });
  });
});
