// Copyright (c) 2026 Javea Guiri. All rights reserved.
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0).
// See LICENSE file in the project root for full license terms.
// src/serv/row-writes.mjs
//
// What SERV's writes share: the embeddings a vector column with embed_source is kept by (every
// table write), and the versioned save — rows locked and checked against the version they were
// read at, written, and logged to PGC_ChangeLog in one transaction — behind saveRows
// (table.mjs) and saveEntity (entity.mjs). Called inside a route's transaction; opens nothing.

import { randomUUID } from 'node:crypto';
import { respond }    from '../shared/lambda-utils.mjs';
import { embedText }  from '../shared/embed-client.mjs';

// ---------------------------------------------------------------------------
// normalizeEmbedText — clean a single field value for embedding
// ---------------------------------------------------------------------------

/**
 * Convert a row field value to a normalised text fragment for embedding.
 * Underscores are replaced with spaces so snake_case identifiers (domain names,
 * alias keys) are tokenised correctly by the embedding model.
 *
 * @param {*} v  Raw field value from row
 * @returns {string}
 */
function normalizeEmbedText(v) {
  if (v === null || v === undefined) return '';
  let text;
  if (Array.isArray(v)) {
    text = v.map(item => String(item ?? '')).join(' ');
  } else if (typeof v === 'object') {
    // jsonb objects not caught by Array.isArray — unlikely in embed_source
    // but handled defensively by extracting string values only.
    text = Object.values(v).filter(x => typeof x === 'string').join(' ');
  } else {
    text = String(v);
  }
  return text.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// resolveEmbedding — build focused embed text from array source fields only
// ---------------------------------------------------------------------------

/**
 * Build a single normalised text string from array-type embed_source fields
 * (e.g. aliases) and embed it as one unit via embedText().
 *
 * Only array fields are used. Scalar fields (domain name, description) are
 * excluded because:
 *   - domain is already represented in the aliases
 *   - description is generic system text ("Manage your data") that pulls the
 *     centroid away from the user-vocabulary terms in the aliases
 *
 * If no array fields are found, falls back to all fields concatenated.
 * This keeps the document tightly focused on what users would type.
 *
 * @param {{ name: string, embed_source: string[] }} vectorCol
 * @param {object} row  Complete row data (merged current + updates for updateRows)
 * @param {string} traceId
 * @returns {Promise<number[]>}
 */
export async function resolveEmbedding(vectorCol, row, traceId) {
  // Prefer array fields (aliases) — they are the user-vocabulary source of truth.
  const arrayTexts = [];
  const scalarTexts = [];

  for (const key of vectorCol.embed_source) {
    const v = row[key];
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      arrayTexts.push(normalizeEmbedText(v));
    } else {
      scalarTexts.push(normalizeEmbedText(v));
    }
  }

  const parts = arrayTexts.length > 0 ? arrayTexts : scalarTexts;
  const text  = parts.join(' ').replace(/\s+/g, ' ').trim();

  if (!text) return null;
  return embedText(text, traceId);
}

/**
 * Return vector columns that have embed_source defined in their schema definition.
 * These are automatically populated by SERV on insert/update.
 *
 * @param {object[]} schemaColumns  Columns array from PGC_Schema
 * @returns {object[]}
 */
export function getEmbedColumns(schemaColumns) {
  return schemaColumns.filter(
    c => c.type?.startsWith('vector') && Array.isArray(c.embed_source) && c.embed_source.length > 0
  );
}

// ---------------------------------------------------------------------------
// Versioned writes — shared by saveRows (table.mjs) and saveEntity (entity.mjs)
//
// A row to change or remove is locked and its version compared before anything is written;
// one that moved fails the whole save. With a changeLog, every row written is logged to
// PGC_ChangeLog in the same transaction, through the same connection — PGC and PGD are one
// database (arch-data.md §4.3.7).
// ---------------------------------------------------------------------------

// A version is updated_at as PostgreSQL text, to the microsecond (`updated_at::text`).
export const VERSION_TEXT   = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;
export const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at']);

export const isRecord = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Whether a string is a version as `updated_at::text` gives it. */
export const isVersion = v => typeof v === 'string' && VERSION_TEXT.test(v);

/**
 * One table's RowWrites — `update`, `insert`, `delete` — checked for shape: an error string, or
 * null. `at` prefixes each message (`children.PGD_X.` for a document's child table).
 * Pure — exported for test.
 */
export function checkRowWriteLists(writes, at = '') {
  const { update = [], insert = [], delete: remove = [] } = writes;
  for (const [key, list] of [['update', update], ['insert', insert], ['delete', remove]]) {
    if (!Array.isArray(list)) return `${at}${key} must be an array`;
  }
  const versioned = (r, where) => {
    if (!isRecord(r) || !Number.isInteger(r.id)) return `${where}.id must be an integer`;
    if (!isVersion(r.version)) return `${where}.version must be the version the row was read at (updated_at as text)`;
    return null;
  };
  for (const [i, r] of update.entries()) {
    const e = versioned(r, `${at}update[${i}]`);
    if (e) return e;
    if (!isRecord(r.changes) || Object.keys(r.changes).length === 0) {
      return `${at}update[${i}].changes must be an object with at least one column`;
    }
  }
  for (const [i, r] of insert.entries()) {
    if (!isRecord(r) || Object.keys(r).length === 0) return `${at}insert[${i}] must be an object with at least one column`;
  }
  for (const [i, r] of remove.entries()) {
    const e = versioned(r, `${at}delete[${i}]`);
    if (e) return e;
  }
  const ids   = [...update, ...remove].map(r => r.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice !== undefined) return `${at}row ${twice} appears more than once`;
  return null;
}

/** Rows a RowWrites carries, whatever their kind. */
export const writeCount = w => (w.update?.length ?? 0) + (w.insert?.length ?? 0) + (w.delete?.length ?? 0);

/**
 * A write's changeLog, when it has one: an error string, or null.
 * Pure — exported for test.
 */
export function checkChangeLog(changeLog) {
  if (changeLog === undefined) return null;
  if (!isRecord(changeLog)) return 'changeLog must be an object';
  if (changeLog.via !== 'web') return 'changeLog.via must be "web"';
  if (typeof changeLog.domain !== 'string' || !changeLog.domain) return 'changeLog.domain is required';
  if (changeLog.actor != null && typeof changeLog.actor !== 'string') return 'changeLog.actor must be a string or null';
  if (changeLog.runId != null && !Number.isInteger(changeLog.runId)) return 'changeLog.runId must be an integer or null';
  return null;
}

/**
 * The rows a RowWrites sets values on, as [where, row] pairs — each update's changes and each
 * insert — for checkWriteColumns.
 */
export function writtenRows(writes, at = '') {
  return [
    ...(writes.update ?? []).map((r, i) => [`${at}update[${i}].changes`, r.changes]),
    ...(writes.insert ?? []).map((r, i) => [`${at}insert[${i}]`, r]),
  ];
}

/**
 * The columns a save writes, against the table's schema: an error string, or null. A table
 * without updated_at has no versions; system and vector columns are never written directly.
 * Pure — exported for test.
 *
 * @param {string} tableName
 * @param {[string, object][]} rows  [where, row] pairs, as writtenRows gives them
 * @param {object[]} schemaColumns
 */
export function checkWriteColumns(tableName, rows, schemaColumns) {
  const types = new Map(schemaColumns.map(c => [c.name, c.type]));
  if (!types.has('updated_at')) return `"${tableName}" has no updated_at column — it accepts no versioned writes`;
  for (const [at, row] of rows) {
    for (const col of Object.keys(row)) {
      if (!types.has(col)) return `${at}: column "${col}" not found in schema for "${tableName}"`;
      if (SYSTEM_COLUMNS.has(col) || types.get(col)?.startsWith('vector')) {
        return `${at}: column "${col}" is maintained by the system`;
      }
    }
  }
  return null;
}

/**
 * The kinds of write a RowWrites carries that PGC_TableMap does not allow on its table: the
 * first refused kind (`UPDATE`, `INSERT`, `DELETE`), or null.
 */
export function refusedKind(writes, gate) {
  for (const [kind, rows, allowed] of [['UPDATE', writes.update, gate.allow_update], ['INSERT', writes.insert, gate.allow_insert], ['DELETE', writes.delete, gate.allow_delete]]) {
    if (rows?.length > 0 && !allowed) return kind;
  }
  return null;
}

/**
 * The rows that moved since they were read — gone, or at another version.
 * Pure — exported for test.
 *
 * @param {string} tableName
 * @param {{ id: number, version: string }[]} claimed  the rows to change or remove, as read
 * @param {Map<number, { version: string }>} current  the same rows now, locked
 */
export function findVersionConflicts(tableName, claimed, current) {
  return claimed.flatMap(({ id, version }) => {
    const now = current.get(id);
    if (!now)                    return [{ table: tableName, id, reason: 'deleted' }];
    if (now.version !== version) return [{ table: tableName, id, reason: 'changed' }];
    return [];
  });
}

/**
 * A change log row's `changes`: each field's old and new value — an insert new only, a delete
 * old only, an update the columns it set whose value differs. Rows are as `to_jsonb` gives
 * them, so a timestamp keeps its microseconds. `skip` holds updated_at and vector columns.
 * Pure — exported for test.
 */
export function fieldChanges(operation, oldRow, newRow, skip, columns) {
  const changes = {};
  if (operation === 'insert') {
    for (const [col, v] of Object.entries(newRow)) if (!skip.has(col)) changes[col] = { new: v };
  } else if (operation === 'delete') {
    for (const [col, v] of Object.entries(oldRow)) if (!skip.has(col)) changes[col] = { old: v };
  } else {
    for (const col of columns) {
      if (skip.has(col)) continue;
      const before = oldRow[col] ?? null;
      const after  = newRow[col] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) changes[col] = { old: before, new: after };
    }
  }
  return changes;
}

/** A value as pg takes it for a column: objects, and strings bound for jsonb, as JSON text. */
export function toParam(v, colType) {
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && colType === 'jsonb') return JSON.stringify(v);
  return v;
}

/**
 * Lock rows by id inside the caller's transaction: id → { row (as to_jsonb), version }.
 * A row that is gone is absent from the map.
 */
export async function lockRows(dbClient, tableName, ids) {
  const current = new Map();
  if (ids.length === 0) return current;
  const locked = await dbClient.query(
    `SELECT to_jsonb(t) AS "row", t."updated_at"::text AS "version"
       FROM "${tableName}" AS t WHERE t."id" = ANY($1) FOR UPDATE`,
    [ids]
  );
  for (const { row, version } of locked.rows) current.set(row.id, { row, version });
  return current;
}

/**
 * Write one table's RowWrites inside the caller's transaction, after its rows were locked and
 * their versions checked. Each written row comes back whole with its new `_version`; each
 * becomes a change log entry. `setOnInsert` is merged into every new row (a child's parent key).
 *
 * @returns {Promise<{ updated: object[], inserted: object[], deleted: number[], log: object[] }>}
 */
export async function writeRows(dbClient, { tableName, schemaColumns, writes, current, setOnInsert = {}, correlationId }) {
  const { update = [], insert = [], delete: remove = [] } = writes;
  const colTypeMap = Object.fromEntries(schemaColumns.map(c => [c.name, c.type]));
  const embedCols  = getEmbedColumns(schemaColumns);
  const skip       = new Set(['updated_at', ...schemaColumns.filter(c => c.type?.startsWith('vector')).map(c => c.name)]);
  const returning  = `RETURNING t.*, t."updated_at"::text AS "_version", to_jsonb(t) AS "_json"`;

  const withEmbeddings = async (row, changed) => {
    const effective = { ...changed };
    for (const vc of embedCols) {
      if (!vc.embed_source.some(k => k in changed)) continue;
      const vec = await resolveEmbedding(vc, { ...row, ...changed }, correlationId);
      if (vec !== null) effective[vc.name] = vec;
    }
    return effective;
  };

  const updated  = [];
  const inserted = [];
  const log      = [];

  for (const { id, changes } of update) {
    const old       = current.get(id).row;
    const effective = await withEmbeddings(old, changes);
    const cols      = Object.keys(effective);
    const result    = await dbClient.query(
      `UPDATE "${tableName}" AS t SET ${cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ')}
        WHERE t."id" = $${cols.length + 1} ${returning}`,
      [...cols.map(c => toParam(effective[c], colTypeMap[c])), id]
    );
    const { _json, ...row } = result.rows[0];
    updated.push(row);
    log.push({ tableName, id, operation: 'update', changes: fieldChanges('update', old, _json, skip, Object.keys(changes)) });
  }

  for (const raw of insert) {
    const effective = await withEmbeddings({}, { ...raw, ...setOnInsert });
    const cols      = Object.keys(effective);
    const result    = await dbClient.query(
      `INSERT INTO "${tableName}" AS t (${cols.map(c => `"${c}"`).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ${returning}`,
      cols.map(c => toParam(effective[c], colTypeMap[c]))
    );
    const { _json, ...row } = result.rows[0];
    inserted.push(row);
    log.push({ tableName, id: row.id, operation: 'insert', changes: fieldChanges('insert', null, _json, skip) });
  }

  if (remove.length > 0) {
    await dbClient.query(`DELETE FROM "${tableName}" WHERE "id" = ANY($1)`, [remove.map(r => r.id)]);
    for (const { id } of remove) {
      log.push({ tableName, id, operation: 'delete', changes: fieldChanges('delete', current.get(id).row, null, skip) });
    }
  }

  return { updated, inserted, deleted: remove.map(r => r.id), log };
}

/**
 * Log a save's entries to PGC_ChangeLog in the caller's transaction, one batch. An entry whose
 * update changed no value is not a change and is left out. Returns the batch id, or undefined
 * when there was no changeLog or nothing to log.
 */
export async function writeChangeLog(dbClient, changeLog, entries) {
  const logged = entries.filter(e => Object.keys(e.changes).length > 0);
  if (!changeLog || logged.length === 0) return undefined;
  const batchId = randomUUID();
  const values  = [];
  const tuples  = logged.map(e => {
    values.push(batchId, changeLog.actor ?? null, changeLog.via, changeLog.runId ?? null, changeLog.domain,
                e.tableName, String(e.id), e.operation, JSON.stringify(e.changes));
    const at = values.length - 9;
    return `(${Array.from({ length: 9 }, (_, i) => `$${at + i + 1}`).join(', ')})`;
  });
  await dbClient.query(
    `INSERT INTO "PGC_ChangeLog"
       (batch_id, actor, via, run_id, domain, table_name, record_id, operation, changes)
     VALUES ${tuples.join(', ')}`,
    values
  );
  return batchId;
}

/** A 409 naming the rows that moved. */
export function versionConflict(conflicts, correlationId) {
  return respond(409, { success: false, error: 'version_conflict', conflicts, correlationId }, correlationId);
}
