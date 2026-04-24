// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.

// dev_scripts/extract-run-data.mjs
// Extracts ALL values matching a dot-path from a JSON file.
// The path is relative -- the document is searched recursively for every node
// where the path applies. Intermediate arrays are fanned out automatically;
// the [] bracket notation is accepted but not required.
//
// Usage:
//   node dev_scripts/extract-run-data.mjs <file> <dot.path> [--raw]
//
// Arguments:
//   file      Path to a JSON file (e.g. research.json)
//   dot.path  Dot-separated key path (e.g. preference_questions.question)
//             Array notation accepted: preference_questions[].question (equivalent)
//   --raw     Output without JSON formatting (for piping)
//
// Output:
//   Single match   -- the value as formatted JSON
//   Multiple matches -- JSON array of all matched values
//   No match       -- error to stderr, exit code 1
//
// Examples:
//   node dev_scripts/extract-run-data.mjs research.json preference_questions.question
//   node dev_scripts/extract-run-data.mjs research.json preference_questions[].question
//   node dev_scripts/extract-run-data.mjs research.json right_brain_research
//   node dev_scripts/extract-run-data.mjs research.json confidence --raw

import { readFileSync } from 'fs';

const rawFlag = process.argv.includes('--raw');
const args = process.argv.slice(2).filter(a => a !== '--raw');

if (args.length < 2) {
  console.error('Usage: node dev_scripts/extract-run-data.mjs <file> <dot.path> [--raw]');
  process.exit(1);
}

const [filename, jsonPath] = args;

// Strip [] bracket notation -- arrays are fanned automatically.
const segments = jsonPath.replace(/\[\]/g, '').split('.').filter(Boolean);

if (segments.length === 0) {
  console.error('extract-run-data: empty path after parsing');
  process.exit(1);
}

let data;
try {
  data = JSON.parse(readFileSync(filename, 'utf8'));
} catch (e) {
  console.error(`extract-run-data: cannot read "${filename}": ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// walkRemainder: given a node and the TAIL segments (everything after the
// starting point has already been resolved), walk the rest of the path and
// collect all terminal values. Fans out transparently through arrays.
// ---------------------------------------------------------------------------
function walkRemainder(node, tailSegments) {
  if (tailSegments.length === 0) return [node];
  if (Array.isArray(node)) {
    const out = [];
    for (const item of node) out.push(...walkRemainder(item, tailSegments));
    return out;
  }
  if (node === null || typeof node !== 'object') return [];
  const [head, ...rest] = tailSegments;
  if (!(head in node)) return [];
  return walkRemainder(node[head], rest);
}

// ---------------------------------------------------------------------------
// findAll: recursively locate every object node where segments[0] exists as a
// direct key, then walk the remainder from that point. Each unique starting
// point is visited exactly once -- no duplicates.
// ---------------------------------------------------------------------------
function findAll(root, segments) {
  const results = [];
  const [head, ...tail] = segments;

  function search(node) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) search(item);
      return;
    }
    // This object node is a candidate starting point if it owns segments[0].
    if (head in node) {
      results.push(...walkRemainder(node[head], tail));
    }
    // Always recurse into children to find relative matches deeper in the tree.
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') search(child);
    }
  }

  search(root);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const results = findAll(data, segments);

if (results.length === 0) {
  console.error(`extract-run-data: path "${jsonPath}" not found in "${filename}"`);
  process.exit(1);
}

const output = results.length === 1 ? results[0] : results;

if (rawFlag) {
  process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output));
} else {
  console.log(JSON.stringify(output, null, 2));
}
