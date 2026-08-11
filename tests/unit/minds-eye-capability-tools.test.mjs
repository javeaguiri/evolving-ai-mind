// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/minds-eye-capability-tools.test.mjs
//
// The capability and scheduling tools — declared in the catalog, deliberately not wired up.
//
// The property under test is honesty, not behaviour. A stub that returned {ok:true} would
// have Novia tell a user their lights are on, and the entire value of a stubbed catalog is
// that she can describe a mechanism truthfully, including that it does not exist yet. So
// every stub must be incapable of reporting success, and must say so in terms that survive
// being relayed to a person who is evaluating whether to trust the system.
//
// Running: node --test tests/unit/minds-eye-capability-tools.test.mjs

import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DISPATCHABLE_TOOLS, selectToolDefinitions } from '../../src/proc/minds-eye.mjs';

const seed = JSON.parse(readFileSync('src/serv/templates/pgc/seeds/seed_PGC_SystemContext.json', 'utf8'));
const row  = seed.find(r => r.key === 'minds_eye_tool_schemas');
const byName = new Map(selectToolDefinitions(row.content).tools.map(t => [t.name, t]));

const CAPABILITY_TOOLS = ['list_capabilities', 'register_capability', 'call_capability'];
const SCHEDULE_TOOLS   = ['list_schedules', 'schedule_workflow', 'cancel_schedule'];
const STUBBED          = ['register_capability', 'call_capability',
                          'list_schedules', 'schedule_workflow', 'cancel_schedule'];

const mindsEyeSrc = readFileSync('src/proc/minds-eye.mjs', 'utf8');

describe('capability and scheduling tools — catalog', () => {
  it('declares all six, and the loop can dispatch every one', () => {
    for (const name of [...CAPABILITY_TOOLS, ...SCHEDULE_TOOLS]) {
      assert.ok(byName.has(name), `${name} must be described in the seed`);
      assert.ok(DISPATCHABLE_TOOLS.has(name), `${name} must be dispatchable — a schema with no code behind it is worse than no tool`);
    }
  });

  it('says NOT YET IMPLEMENTED in the description of every stubbed tool', () => {
    // The description is the only thing the model sees before deciding to call. A stub that
    // reads like a working tool gets proposed as one.
    for (const name of STUBBED) {
      assert.match(byName.get(name).description, /NOT YET IMPLEMENTED/,
        `${name} must announce that it is not built`);
    }
  });

  it('does NOT claim list_capabilities is stubbed, because it really reads the registry', () => {
    assert.doesNotMatch(byName.get('list_capabilities').description, /NOT YET IMPLEMENTED/);
  });

  it('warns that an empty schedule list is absence of a service, not absence of schedules', () => {
    // The failure this prevents: "you have no schedules configured" — reassuring, and false.
    assert.match(byName.get('list_schedules').description, /not that the user has no schedules/);
  });

  it('keeps the credential out of the registry', () => {
    assert.match(byName.get('register_capability').parameters.properties.authRef.description,
      /Never the credential itself/);
  });

  it('points recurring needs at a workflow rather than repeated direct calls', () => {
    // Otherwise the proposal for "check the house every hour" is "call it every hour".
    assert.match(byName.get('call_capability').description, /workflow that calls the capability/);
  });

  it('says the workflow half is real even though the trigger is not', () => {
    // This is the sentence that keeps a demo honest in the useful direction: most of the
    // mechanism genuinely exists, and only the unattended trigger is missing.
    assert.match(byName.get('schedule_workflow').description, /runnable on demand today/);
  });
});

describe('capability and scheduling tools — wiring', () => {
  it('gates every tool that acts on the world, or commits to acting unattended', () => {
    // Gated while stubbed, so that unstubbing them is not also a security change someone
    // has to remember to make.
    const gatedBlock = mindsEyeSrc.slice(
      mindsEyeSrc.indexOf('const GATED_WRITE_TOOLS'),
      mindsEyeSrc.indexOf('const TRIGGER_TOOLS'),
    );
    for (const name of ['register_capability', 'call_capability', 'schedule_workflow', 'cancel_schedule']) {
      assert.match(gatedBlock, new RegExp(`'${name}'`), `${name} must be a gated write`);
    }
  });

  it('routes the two read tools through the read path', () => {
    const readBlock = mindsEyeSrc.slice(
      mindsEyeSrc.indexOf('const READ_TOOLS'),
      mindsEyeSrc.indexOf('const INLINE_WRITE_TOOLS'),
    );
    for (const name of ['list_capabilities', 'list_schedules']) {
      assert.match(readBlock, new RegExp(`'${name}'`), `${name} must be a read tool`);
    }
  });

  it('never registers a capability tool as an inline write', () => {
    // An inline write executes with no confirmation. Nothing here may take that path.
    const inlineBlock = mindsEyeSrc.slice(
      mindsEyeSrc.indexOf('const INLINE_WRITE_TOOLS'),
      mindsEyeSrc.indexOf('const GATED_WRITE_TOOLS'),
    );
    for (const name of [...CAPABILITY_TOOLS, ...SCHEDULE_TOOLS]) {
      assert.doesNotMatch(inlineBlock, new RegExp(`'${name}'`));
    }
  });

  it('tells the user on the gate card itself that nothing will happen', () => {
    // Approving one of these approves a description. A card that reads like every other
    // confirmation would imply the opposite.
    for (const marker of ['nothing will be written', 'nothing will be called',
                          'nothing will be scheduled', 'no schedule exists']) {
      assert.ok(mindsEyeSrc.includes(marker), `gate text must include "${marker}"`);
    }
  });
});

describe('the stub contract', () => {
  it('reports not_implemented and never a success flag', () => {
    const helper = mindsEyeSrc.slice(
      mindsEyeSrc.indexOf('function notImplemented'),
      mindsEyeSrc.indexOf('function notImplemented') + 300,
    );
    assert.match(helper, /status: 'not_implemented'/);
    assert.doesNotMatch(helper, /ok: true|success: true/);
  });

  it('carries the request a real implementation would have issued', () => {
    // Without would_have the model can only say "that is not built", which describes
    // nothing. With it, the explanation is concrete.
    assert.match(mindsEyeSrc.slice(mindsEyeSrc.indexOf('function notImplemented')),
      /would_have: wouldHave/);
  });
});
