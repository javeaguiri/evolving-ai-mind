// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/scheduler-client.test.mjs
//
// EventBridge Scheduler client — the pure parts, and the message contract.
//
// The SCHEDULED_RUN message is the load-bearing thing here: it is written by
// scheduler-client.mjs (shared tier), stored inside an AWS resource for months, and read by
// scheduled-run.mjs (PROC tier). Nothing else pins the two ends together, and a schedule
// created today is a message parsed by whatever the code looks like when it fires. So the
// shape is asserted from both directions.
//
// Validation is tested because the alternative is discovering a bad name or expression as a
// ValidationException after a network round trip, which is a worse error and a slower one.
//
// Running: node --test tests/unit/scheduler-client.test.mjs

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  validateScheduleName,
  validateScheduleExpression,
  buildScheduledRunMessage,
} from '../../src/shared/scheduler-client.mjs';

describe('schedule name validation', () => {
  it('accepts the snake_case names the tool contract asks for', () => {
    for (const n of ['home_check_hourly', 'morning-scene', 'nightly.report', 'a']) {
      assert.equal(validateScheduleName(n), null, `${n} should be valid`);
    }
  });

  it('rejects what EventBridge would reject, before the network call', () => {
    for (const n of ['has space', 'has/slash', 'has:colon', 'x'.repeat(65)]) {
      assert.match(validateScheduleName(n) ?? '', /invalid/, `${n} should be rejected`);
    }
  });

  it('treats a missing name as a required-field error, not an invalid one', () => {
    assert.match(validateScheduleName(''), /required/);
    assert.match(validateScheduleName(undefined), /required/);
  });
});

describe('schedule expression validation', () => {
  it('accepts all three EventBridge forms', () => {
    for (const e of ['cron(0 7 * * ? *)', 'rate(30 minutes)', 'rate(1 day)', 'at(2026-08-12T07:00:00)']) {
      assert.equal(validateScheduleExpression(e), null, `${e} should be valid`);
    }
  });

  it('rejects a bare cron string, which is the likely mistake', () => {
    // "0 7 * * *" is what someone writes from crontab habit; EventBridge needs the wrapper.
    assert.match(validateScheduleExpression('0 7 * * *') ?? '', /not a valid EventBridge expression/);
  });

  it('rejects rate() with a unit EventBridge does not take', () => {
    assert.match(validateScheduleExpression('rate(30 seconds)') ?? '', /not a valid/);
    assert.match(validateScheduleExpression('rate(2 weeks)')    ?? '', /not a valid/);
  });

  it('names the valid forms in the error, so the next attempt can succeed', () => {
    const msg = validateScheduleExpression('every morning');
    assert.match(msg, /cron\(/);
    assert.match(msg, /rate\(/);
    assert.match(msg, /at\(/);
  });
});

describe('the SCHEDULED_RUN message — written here, read by PROC', () => {
  it('carries the type PROC dispatches on', () => {
    const m = buildScheduledRunMessage('home_check', { room: 'kitchen' }, 'hourly_check');
    assert.equal(m.type, 'SCHEDULED_RUN');
  });

  it('carries workflowName, input and scheduleName, which is all PROC reads', () => {
    const m = buildScheduledRunMessage('home_check', { room: 'kitchen' }, 'hourly_check');
    assert.deepEqual(m, {
      type: 'SCHEDULED_RUN', workflowName: 'home_check',
      input: { room: 'kitchen' }, scheduleName: 'hourly_check',
    });
  });

  it('never emits a workflowRunId — the run does not exist until it fires', () => {
    // This is what makes it a Category 1 entry message rather than a WORKFLOW_STEP.
    const m = buildScheduledRunMessage('w', {}, 's');
    assert.ok(!('workflowRunId' in m));
  });

  it('defaults absent input to an empty object rather than undefined', () => {
    // JSON.stringify would drop undefined, and the message is stored in AWS for months.
    assert.deepEqual(buildScheduledRunMessage('w', undefined, 's').input, {});
  });

  it('is dispatched by PROC on exactly this type string', () => {
    // The two ends live in different tiers; this is the only thing pinning them together.
    const handler = readFileSync('src/proc/handler.mjs', 'utf8');
    assert.match(handler, /message\.type === 'SCHEDULED_RUN'/);
  });

  it('is turned into a run with no callback, because nobody is waiting', () => {
    const runner = readFileSync('src/proc/scheduled-run.mjs', 'utf8');
    assert.match(runner, /callback:\s*null/);
    assert.match(runner, /triggered_by:\s*'schedule'/);
  });
});

describe('tier boundaries', () => {
  it('keeps the AWS SDK out of PROC', () => {
    // architecture.md §3.1 — PROC is cloud-agnostic. The scheduler SDK belongs in shared/,
    // exactly as the SQS client does.
    for (const f of ['src/proc/minds-eye.mjs', 'src/proc/scheduled-run.mjs']) {
      assert.doesNotMatch(readFileSync(f, 'utf8'), /@aws-sdk/, `${f} must not import an AWS SDK`);
    }
  });

  it('targets the queue by ARN, not by URL', () => {
    // A Scheduler target needs an ARN; the SQS client needs a URL. They are not
    // interchangeable and the failure is a ValidationException at create time.
    const src = readFileSync('src/shared/scheduler-client.mjs', 'utf8');
    assert.match(src, /SQS_WORKFLOW_ARN/);
  });
});
