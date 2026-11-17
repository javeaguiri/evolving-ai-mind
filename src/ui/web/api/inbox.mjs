// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/ui/web/api/inbox.mjs
//
// GET /api/v1/ui/web/inbox's one change to PROC's page (docs/openapi.yaml webReadInbox): a
// WORKFLOW_ERROR's raw `message` is replaced by its `summary`, the same summary Slack posts
// (shared/workflow-error.mjs). The raw message stays in CloudWatch and the run. Pure.

import { summariseWorkflowError } from '../../shared/workflow-error.mjs';

/**
 * @param {{ messages: object[] }} page  PROC's inbox page
 * @returns {object}                     The same page, each WORKFLOW_ERROR summarised
 */
export function summariseInbox(page) {
  return {
    ...page,
    messages: page.messages.map(m => {
      if (m.messageType !== 'WORKFLOW_ERROR') return m;
      const { message, ...payload } = m.payload ?? {};
      return { ...m, payload: { ...payload, summary: summariseWorkflowError(message) } };
    }),
  };
}
