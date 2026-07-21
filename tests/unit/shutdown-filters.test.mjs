// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/shutdown-filters.test.mjs
//
// Sprint 8 A10 — a replay break has no user-reachable exit unless /shutdown can reach it.
// The rule (arch-replay §7a): a blanket sweep must NEVER touch awaiting_llm_break (it would
// destroy a developer's break), but a targeted /shutdown <runId> MUST, because it is the only
// exit. The whole behaviour is the id-conditional status list.

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';

import { buildActiveRunFilters } from '../../src/proc/shutdown.mjs';

const statusesOf = (filters) => filters.find(f => f.column === 'status').value;

describe('buildActiveRunFilters', () => {
  it('a blanket sweep (no id) never touches a replay break', () => {
    const statuses = statusesOf(buildActiveRunFilters(undefined));
    assert.deepEqual(statuses, ['running', 'awaiting_human_gate']);
    assert.ok(!statuses.includes('awaiting_llm_break'), 'a sweep must not destroy a dev break');
  });

  it('a targeted shutdown includes the break — its only user-reachable exit', () => {
    const filters  = buildActiveRunFilters(722);
    const statuses = statusesOf(filters);
    assert.ok(statuses.includes('awaiting_llm_break'), 'a named id must reach the break');
    assert.deepEqual(filters.find(f => f.column === 'id'), { column: 'id', op: 'eq', value: 722 });
  });

  it('the break is reachable only WITH the id filter — never swept', () => {
    // The two conditions move together: awaiting_llm_break appears iff an id also narrows the set.
    const targeted = buildActiveRunFilters(1);
    assert.ok(statusesOf(targeted).includes('awaiting_llm_break'));
    assert.ok(targeted.some(f => f.column === 'id'), 'break status is never present without an id filter');
  });
});
