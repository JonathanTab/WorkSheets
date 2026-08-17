/**
 * ops/docOps.js — Whole-document orientation and batched mutation.
 *
 * Two problems specific to calling this system from an agent:
 *
 *   1. Orientation cost. Discovering a document's shape used to take
 *      files → sheets → tables-per-sheet → schema-per-table, an N+1 walk before
 *      any real work. describeDocument() answers all of it in one call.
 *
 *   2. Round-trip cost. Laying out a report is dozens of small writes; one HTTP
 *      call each is slow and leaves partial state behind on failure.
 *      applyBatch() runs them in a single transaction and rolls back as a unit.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import * as Y from 'yjs';
import { YJS_ORIGIN } from '../yjsOrigins.js';
import {
    root, sheetsMap, resolveSheet, schemaStatus, prepareForWrite, OpError,
} from './context.js';
import * as cellOps from './cellOps.js';
import * as formatOps from './formatOps.js';
import * as sheetOps from './sheetOps.js';
import * as tableOps from './tableOps.js';

// ─── Describe ──────────────────────────────────────────────────────────────

/**
 * One-call summary of a document's structure and contents.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {{ sample?: number }} [opts]  Rows of preview data per sheet (default 5, 0 to skip)
 */
export function describeDocument(ydoc, opts = {}) {
    if (!sheetsMap(ydoc)) throw new OpError('NOT_A_SPREADSHEET', 'Document has no spreadsheet structure');
    const sampleRows = opts.sample ?? 5;

    const sheets = sheetOps.listSheets(ydoc).map(({ id, name, index }) => {
        const { sheet } = resolveSheet(ydoc, id);
        const used = cellOps.getUsedRange(ydoc, id);

        const entry = {
            id, name, index,
            dimensions: {
                rowCount: sheet.get('rowCount') ?? 0,
                colCount: sheet.get('colCount') ?? 0,
            },
            usedRange: used.range,
            nonEmptyCells: used.nonEmpty,
            frozen: formatOps.getFrozenPanes(ydoc, id),
            merges: formatOps.listMerges(ydoc, id),
            conditionalFormats: formatOps.listConditionalFormats(ydoc, id).length,
        };

        // A small values preview is usually enough for an agent to infer the
        // layout (where headers are, which columns hold what) without a
        // separate read call.
        if (sampleRows > 0 && used.range) {
            const [topLeft] = used.range.split(':');
            const endRef = used.range.includes(':') ? used.range.split(':')[1] : topLeft;
            const previewEnd = clampPreview(topLeft, endRef, sampleRows);
            try {
                entry.preview = cellOps.getRange(ydoc, id, `${topLeft}:${previewEnd}`).values;
            } catch { /* preview is best-effort */ }
        }
        return entry;
    });

    const tables = tableOps.listTables(ydoc).map(t => {
        try {
            const schema = tableOps.getTableSchema(ydoc, t.id);
            return { ...t, columns: schema.columns };
        } catch {
            return { ...t, columns: [] };
        }
    });

    const namedRanges = [];
    root(ydoc).get('namedRanges')?.forEach((nr, name) => {
        namedRanges.push({ name, sheetId: nr.get?.('sheetId') ?? null });
    });

    return {
        schema: schemaStatus(ydoc),
        sheetCount: sheets.length,
        sheets,
        tables,
        namedRanges,
    };
}

/** Limit a preview range to N rows, keeping the column span. */
function clampPreview(topLeft, bottomRight, maxRows) {
    const m1 = topLeft.match(/^([A-Z]+)(\d+)$/);
    const m2 = bottomRight.match(/^([A-Z]+)(\d+)$/);
    if (!m1 || !m2) return bottomRight;
    const lastRow = Math.min(parseInt(m2[2], 10), parseInt(m1[2], 10) + maxRows - 1);
    return `${m2[1]}${lastRow}`;
}

// ─── Batch ─────────────────────────────────────────────────────────────────

/**
 * Operations callable from a batch. Kept as an explicit allow-list so a batch
 * can never reach something that wasn't designed for it.
 * @type {Record<string, (ydoc: import('yjs').Doc, op: object) => any>}
 */
const BATCH_OPS = {
    setCell:      (d, o) => cellOps.setCell(d, o.sheet, o.ref, o.value, o.props ?? {}),
    setRange:     (d, o) => cellOps.setRange(d, o.sheet, o.ref ?? o.anchor, o.values, o.props ?? {}),
    clearRange:   (d, o) => cellOps.clearRange(d, o.sheet, o.range, o.options ?? {}),
    formatRange:  (d, o) => cellOps.formatRange(d, o.sheet, o.range, o.style),

    setColumnWidths: (d, o) => formatOps.setColumnWidths(d, o.sheet, o.widths),
    setRowHeights:   (d, o) => formatOps.setRowHeights(d, o.sheet, o.heights),
    setFrozenPanes:  (d, o) => formatOps.setFrozenPanes(d, o.sheet, o.panes ?? o),
    mergeCells:      (d, o) => formatOps.mergeCells(d, o.sheet, o.range),
    unmergeCells:    (d, o) => formatOps.unmergeCells(d, o.sheet, o.range),
    setBorders:      (d, o) => formatOps.setBorders(d, o.sheet, o.range, o.borders ?? o.spec),
    addConditionalFormat: (d, o) => formatOps.addConditionalFormat(d, o.sheet, o.rule ?? o),

    insertRows:    (d, o) => sheetOps.insertRows(d, o.sheet, o.at, o.count ?? 1),
    deleteRows:    (d, o) => sheetOps.deleteRows(d, o.sheet, o.at, o.count ?? 1),
    insertColumns: (d, o) => sheetOps.insertColumns(d, o.sheet, o.at, o.count ?? 1),
    deleteColumns: (d, o) => sheetOps.deleteColumns(d, o.sheet, o.at, o.count ?? 1),
    createSheet:   (d, o) => sheetOps.createSheet(d, o.name, o.options ?? {}),
    renameSheet:   (d, o) => sheetOps.renameSheet(d, o.sheet, o.name),

    createTable:  (d, o) => tableOps.createTable(d, o.table ?? o),
    addColumn:    (d, o) => tableOps.addColumn(d, o.table, o.column),
    insertRow:    (d, o) => tableOps.insertRow(d, o.table, o.row ?? o.values),
    appendRows:   (d, o) => tableOps.appendRows(d, o.table, o.rows),
    updateRow:    (d, o) => tableOps.updateRow(d, o.table, o.index, o.values),
    upsertRow:    (d, o) => tableOps.upsertRow(d, o.table, o.where, o.values),
    deleteRow:    (d, o) => tableOps.deleteRow(d, o.table, o.index),
};

/** Names an agent can use in a batch payload. */
export const BATCH_OP_NAMES = Object.keys(BATCH_OPS);

/**
 * Apply a list of operations, rolling back completely if any of them fails.
 *
 * Each op runs in its OWN transaction rather than one big shared one. That is
 * deliberate: YKeyValue rebuilds its lookup map from a Y.Array observer, and
 * Yjs defers observers to transaction cleanup, so an op sharing a transaction
 * with earlier ops cannot see their writes. Per-op transactions mean a batch
 * that formats a cell it just wrote behaves the way a caller expects.
 *
 * Failure still rolls the whole batch back: an UndoManager scoped to this
 * layer's own transaction origin undoes every step taken so far, so a caller
 * never has to reason about how far it got. Collaborators may briefly observe
 * intermediate states — the trade we make for correct read-your-own-writes.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {Array<{ op: string, [k: string]: any }>} operations
 * @returns {{ applied: number, results: any[] }}
 */
export function applyBatch(ydoc, operations) {
    prepareForWrite(ydoc);
    if (!Array.isArray(operations) || operations.length === 0) {
        throw new OpError('EMPTY_BATCH', 'applyBatch needs a non-empty array of operations');
    }

    // Validate op names up front — a typo shouldn't cost a partial write.
    operations.forEach((o, i) => {
        if (!o || !BATCH_OPS[o.op]) {
            throw new OpError('UNKNOWN_OP',
                `Operation ${i} has unknown op "${o?.op}"`, { allowed: BATCH_OP_NAMES });
        }
    });

    // Yjs commits whatever a transaction managed to do before an exception, so
    // rollback is an explicit undo of this batch's own changes. The UndoManager
    // tracks only our origin, so a concurrent collaborator edit is never undone.
    const undo = new Y.UndoManager(root(ydoc), {
        trackedOrigins: new Set([YJS_ORIGIN.API]),
        captureTimeout: 0,
    });

    const results = [];
    try {
        for (const o of operations) results.push(BATCH_OPS[o.op](ydoc, o));
    } catch (err) {
        try { while (undo.canUndo()) undo.undo(); } catch { /* best-effort rollback */ }
        undo.destroy();
        throw err;
    }

    undo.destroy();
    return { applied: results.length, results };
}
