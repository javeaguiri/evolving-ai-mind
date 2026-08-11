// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/shared/scheduler-client.mjs
// Amazon EventBridge Scheduler — recurring and one-off unattended workflow runs.
//
// This is the ONLY place @aws-sdk/client-scheduler is imported. Isolated here for the same
// reason sqs-callback.mjs isolates the SQS client: PROC endpoint modules are cloud-agnostic
// by architectural rule (architecture.md §3.1) and must not import an AWS SDK.
//
// WHY THE TARGET IS A QUEUE AND NOT A LAMBDA
//
// A schedule can only deliver a STATIC payload, but starting a workflow needs a
// PGC_WorkflowRun row that does not exist until the moment it fires. So the schedule sends a
// SCHEDULED_RUN message to the existing WorkflowQueue, and PROC creates the run. That is
// architecture.md §3.2's Category 1 exactly — a fire-and-forget entry message carrying no
// workflowRunId, because the run does not exist yet — so this adds no new execution path.
// The Step Processor cannot tell a scheduled run from a Slack-triggered one, which is the
// property that makes scheduling cheap.
//
// Called by: minds-eye.mjs (schedule_workflow, cancel_schedule, list_schedules)

import {
  SchedulerClient,
  CreateScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  ListSchedulesCommand,
} from '@aws-sdk/client-scheduler';

const scheduler = new SchedulerClient({});

// One group per instance keeps ListSchedules scoped to this brain's schedules rather than
// every schedule in the account. Created by template.yaml, never at runtime.
const GROUP = process.env.SCHEDULER_GROUP_NAME;

// EventBridge Scheduler accepts [0-9a-zA-Z-_.] and up to 64 characters. snake_case passes
// unchanged; anything else is rejected here rather than by the API, so the caller gets a
// message naming the rule instead of a ValidationException.
const NAME_PATTERN = /^[0-9a-zA-Z-_.]{1,64}$/;

/**
 * Validate a schedule name against what EventBridge Scheduler will accept.
 * Exported for unit testing — the API rejects a bad name, but only after a network call.
 *
 * @param {string} name
 * @returns {string|null} An error message, or null when the name is valid
 */
export function validateScheduleName(name) {
  if (!name) return 'scheduleName is required';
  if (!NAME_PATTERN.test(name)) {
    return `scheduleName "${name}" is invalid — use letters, digits, hyphen, underscore or dot, max 64 characters`;
  }
  return null;
}

/**
 * Validate a schedule expression. EventBridge Scheduler takes three forms and rejecting the
 * wrong shape locally saves a round trip and gives a better message than ValidationException.
 *
 * @param {string} expression  cron(...), rate(...) or at(...)
 * @returns {string|null} An error message, or null when the expression is well-formed
 */
export function validateScheduleExpression(expression) {
  if (!expression) return 'schedule is required';
  if (!/^(cron\(.+\)|rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)|at\(.+\))$/.test(expression)) {
    return `schedule "${expression}" is not a valid EventBridge expression — use cron(0 7 * * ? *), rate(30 minutes) or at(2026-08-12T07:00:00)`;
  }
  return null;
}

/**
 * Build the SCHEDULED_RUN message a firing schedule delivers to WorkflowQueue.
 * Pure, and exported so a test can assert the contract PROC's handler depends on without
 * touching AWS — the two ends of this message are in different tiers and nothing else pins them.
 *
 * @param {string} workflowName
 * @param {object} input          Workflow input, passed through verbatim on every run
 * @param {string} scheduleName
 * @returns {object} The message body
 */
export function buildScheduledRunMessage(workflowName, input, scheduleName) {
  return { type: 'SCHEDULED_RUN', workflowName, input: input ?? {}, scheduleName };
}

/**
 * Create or update a schedule. Upserts deliberately: a caller asking to schedule a workflow
 * under a name that already exists means "make it so", and the alternative is a
 * ConflictException the caller can only resolve by calling a second API.
 *
 * @param {object}  spec
 * @param {string}  spec.scheduleName
 * @param {string}  spec.workflowName
 * @param {string}  spec.schedule       cron(...) / rate(...) / at(...)
 * @param {object}  spec.input          Passed to every run
 * @param {boolean} spec.enabled
 * @param {string}  spec.timezone       IANA name, e.g. "Europe/Madrid"
 * @param {string}  spec.description
 * @returns {Promise<object>} { created|updated: true, scheduleName, ... } or { error }
 */
export async function upsertSchedule(spec) {
  const { scheduleName, workflowName, schedule, input = {}, enabled = true,
          timezone = 'UTC', description } = spec;

  const nameError = validateScheduleName(scheduleName);
  if (nameError) return { error: nameError };
  const exprError = validateScheduleExpression(schedule);
  if (exprError) return { error: exprError };
  if (!workflowName) return { error: 'workflowName is required' };

  const params = {
    Name:                       scheduleName,
    GroupName:                  GROUP,
    ScheduleExpression:         schedule,
    ScheduleExpressionTimezone: timezone,
    State:                      enabled ? 'ENABLED' : 'DISABLED',
    Description:                description ?? `Runs ${workflowName}`,
    // Fire at the scheduled time rather than inside a window. A home check at 07:00 that
    // may arrive any time in the next 15 minutes is a different product.
    FlexibleTimeWindow: { Mode: 'OFF' },
    Target: {
      Arn:     process.env.SQS_WORKFLOW_ARN,
      RoleArn: process.env.SCHEDULER_ROLE_ARN,
      Input:   JSON.stringify(buildScheduledRunMessage(workflowName, input, scheduleName)),
      // A schedule that fires while the system is down should not silently vanish; two
      // retries then the DLQ, matching how WorkflowQueue already treats a failed message.
      RetryPolicy: { MaximumRetryAttempts: 2 },
    },
  };

  try {
    await scheduler.send(new CreateScheduleCommand(params));
    console.info('scheduler: schedule created', { scheduleName, workflowName, schedule });
    return { created: true, scheduleName, workflowName, schedule, timezone, enabled };
  } catch (error) {
    if (error.name !== 'ConflictException') {
      console.error('scheduler: create failed', { scheduleName, error: error.message });
      return { error: `createSchedule failed: ${error.message}` };
    }
    try {
      await scheduler.send(new UpdateScheduleCommand(params));
      console.info('scheduler: schedule updated', { scheduleName, workflowName, schedule });
      return { updated: true, scheduleName, workflowName, schedule, timezone, enabled };
    } catch (updateError) {
      console.error('scheduler: update failed', { scheduleName, error: updateError.message });
      return { error: `updateSchedule failed: ${updateError.message}` };
    }
  }
}

/**
 * Delete a schedule. Does not touch the workflow it targets.
 *
 * @param {string} scheduleName
 * @returns {Promise<object>} { deleted: true, scheduleName } or { error }
 */
export async function deleteSchedule(scheduleName) {
  const nameError = validateScheduleName(scheduleName);
  if (nameError) return { error: nameError };

  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: scheduleName, GroupName: GROUP }));
    console.info('scheduler: schedule deleted', { scheduleName });
    return { deleted: true, scheduleName };
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') {
      return { error: `No schedule named "${scheduleName}" exists` };
    }
    console.error('scheduler: delete failed', { scheduleName, error: error.message });
    return { error: `deleteSchedule failed: ${error.message}` };
  }
}

/**
 * List schedules in this instance's group, optionally filtered to one workflow.
 *
 * ListSchedules returns summaries with no Target, so the workflow a schedule runs is not in
 * the list response. Each is fetched individually — acceptable because a household instance
 * has a handful of schedules, and a list that cannot say what it runs is not worth returning.
 *
 * @param {string} [workflowName]  Filter to schedules targeting this workflow
 * @returns {Promise<object>} { count, schedules: [...] } or { error }
 */
export async function listSchedules(workflowName) {
  try {
    const list = await scheduler.send(new ListSchedulesCommand({ GroupName: GROUP, MaxResults: 100 }));
    const summaries = list.Schedules ?? [];

    const detailed = await Promise.all(summaries.map(async (s) => {
      const full = await scheduler.send(new GetScheduleCommand({ Name: s.Name, GroupName: GROUP }));
      let target = {};
      try { target = JSON.parse(full.Target?.Input ?? '{}'); } catch { /* not our message */ }
      return {
        scheduleName:  full.Name,
        workflowName:  target.workflowName ?? null,
        input:         target.input ?? {},
        schedule:      full.ScheduleExpression,
        timezone:      full.ScheduleExpressionTimezone,
        enabled:       full.State === 'ENABLED',
        description:   full.Description ?? null,
      };
    }));

    const schedules = workflowName
      ? detailed.filter(s => s.workflowName === workflowName)
      : detailed;

    return { count: schedules.length, schedules };
  } catch (error) {
    console.error('scheduler: list failed', { error: error.message });
    return { error: `listSchedules failed: ${error.message}` };
  }
}
