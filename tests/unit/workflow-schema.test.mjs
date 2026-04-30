// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// tests/unit/workflow-schema.test.mjs
//
// Validates every workflow in seed_PGC_Workflow.json against workflow-schema.json.
// Tests are generated dynamically — adding a workflow to the seed automatically adds a test.
//
// Run: node --test tests/unit/workflow-schema.test.mjs

import { describe, it } from 'node:test';
import assert           from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv              from 'ajv';

const schema = JSON.parse(readFileSync(
  new URL('../../docs/workflow-schema.json', import.meta.url)
));

const seed = JSON.parse(readFileSync(
  new URL('../../src/serv/templates/pgc/seeds/seed_PGC_Workflow.json', import.meta.url)
));

const validate = new Ajv({ allErrors: true }).compile(schema);

for (const workflow of seed) {
  describe(`workflow: ${workflow.name}`, () => {
    it('conforms to workflow-schema.json', () => {
      const valid = validate(workflow);
      if (!valid) {
        const detail = validate.errors
          .map(e => `  ${e.instancePath || '(root)'} ${e.message}`)
          .join('\n');
        assert.fail(`schema validation failed:\n${detail}`);
      }
    });
  });
}
