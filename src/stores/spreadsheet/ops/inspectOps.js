/**
 * ops/inspectOps.js — Diagnostics: find what's wrong with a spreadsheet.
 *
 * "Fix this spreadsheet for me" is a different problem from reading it. An
 * agent handed a broken document needs to LOCATE defects before it can repair
 * them, and scanning cell-by-cell through a general read API is both expensive
 * and unreliable. This produces a structured finding list instead.
 *
 * Findings are advisory, ranked by severity, and always carry the A1 location
 * so a caller can act on one without re-deriving where it is. Nothing here
 * mutates the document.
 *
 * Pure JS — no Svelte, no browser APIs, no Node-only modules.
 */

import { formatA1Cell, formatA1Range } from '../../../formulas/a1.js';
import { root, sheetsMap, resolveSheet, mkCellValuesKV } from './context.js';
import { createDocEvaluator } from './evalOps.js';
import * as sheetOps from './sheetOps.js';
import * as tableOps from './tableOps.js';

/** Spreadsheet error sentinels that indicate a broken cell. */
const ERROR_VALUES = new Set([
    '#CIRC!', '#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NULL!', '#NUM!', '#ERROR!',
]);

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

/**
 * Inspect a document (or a single sheet) for defects.
 *
 * @param {import('yjs').Doc} ydoc
 * @param {{ sheet?: string, checks?: string[] }} [opts]
 * @returns {{ findings: Array<object>, checked: { sheets: number, cells: number } }}
 */
export function inspectDocument(ydoc, opts = {}) {
    const findings = [];
    const evaluator = createDocEvaluator(ydoc);

    const targets = opts.sheet
        ? [sheetOps.listSheets(ydoc).find(s => {
            const { id } = resolveSheet(ydoc, opts.sheet);
            return s.id === id;
        })].filter(Boolean)
        : sheetOps.listSheets(ydoc);

    let cellsChecked = 0;

    for (const { id, name } of targets) {
        const { sheet } = resolveSheet(ydoc, id);
        const values = mkCellValuesKV(sheet);
        if (!values) continue;

        /** @type {Map<string, {row:number,col:number,raw:string}>} */
        const formulaCells = new Map();
        /** @type {Map<string, number[]>} normalised text → row indices, for duplicate detection */
        const rowSignatures = new Map();

        for (const [key, { val }] of values.map) {
            const [row, col] = key.split(',').map(Number);
            if (isNaN(row) || isNaN(col)) continue;
            cellsChecked++;

            const raw = val?.v;
            if (raw === null || raw === undefined || raw === '') continue;

            // 1. Cells that currently evaluate to an error.
            const computed = typeof raw === 'string' && raw.startsWith('=')
                ? evaluator.getValue(id, row, col)
                : raw;
            if (typeof computed === 'string' && ERROR_VALUES.has(computed)) {
                findings.push({
                    type: computed === '#CIRC!' ? 'circular-reference' : 'error-cell',
                    severity: 'error',
                    sheet: name,
                    ref: formatA1Cell(row, col),
                    detail: `evaluates to ${computed}`,
                    ...(typeof raw === 'string' && raw.startsWith('=') ? { formula: raw } : {}),
                });
            }

            if (typeof raw === 'string' && raw.startsWith('=')) {
                formulaCells.set(key, { row, col, raw });
            }

            // 2. Numbers stored as text — they break SUM and sort wrong.
            if (typeof raw === 'string' && !raw.startsWith('=') && raw.trim() !== '' &&
                !isNaN(Number(raw.replace(/[, ]/g, ''))) && /\d/.test(raw)) {
                findings.push({
                    type: 'number-as-text',
                    severity: 'warning',
                    sheet: name,
                    ref: formatA1Cell(row, col),
                    detail: `"${raw}" is stored as text but looks numeric`,
                });
            }

            // Track row content for duplicate detection.
            const sig = String(raw).trim().toLowerCase();
            if (sig) {
                if (!rowSignatures.has(sig)) rowSignatures.set(sig, []);
                rowSignatures.get(sig).push(row);
            }
        }

        findings.push(...findFormulaPatternBreaks(formulaCells, name));
        findings.push(...findHardcodedNumbers(formulaCells, name));
    }

    findings.push(...inspectTables(ydoc));

    findings.sort((a, b) =>
        (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3));

    return {
        findings,
        checked: { sheets: targets.length, cells: cellsChecked },
    };
}

/**
 * Find a formula that breaks the pattern of its neighbours.
 *
 * A row of SUM formulas with one cell overwritten by a hand-typed constant (or
 * a differently-shaped formula) is the single most common way a spreadsheet
 * goes quietly wrong, and it is invisible on screen.
 */
function findFormulaPatternBreaks(formulaCells, sheetName) {
    const findings = [];
    /** @type {Map<number, Array<{col:number, shape:string, raw:string}>>} */
    const byRow = new Map();

    for (const { row, col, raw } of formulaCells.values()) {
        if (!byRow.has(row)) byRow.set(row, []);
        byRow.get(row).push({ col, shape: shapeOf(raw), raw });
    }

    for (const [row, cells] of byRow) {
        if (cells.length < 3) continue;
        const counts = new Map();
        for (const c of cells) counts.set(c.shape, (counts.get(c.shape) ?? 0) + 1);
        if (counts.size < 2) continue;

        const [dominant, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
        // Only flag when there's a clear majority pattern and few exceptions.
        if (dominantCount < cells.length * 0.6) continue;

        for (const c of cells) {
            if (c.shape === dominant) continue;
            findings.push({
                type: 'formula-pattern-break',
                severity: 'warning',
                sheet: sheetName,
                ref: formatA1Cell(row, c.col),
                detail: `formula differs from the ${dominantCount} others in this row`,
                formula: c.raw,
            });
        }
    }
    return findings;
}

/**
 * Flag formulas with a literal number baked in (=B2*1.2, =SUM(A1:A9)+500).
 * These are the values that later turn out to be wrong and untraceable.
 */
function findHardcodedNumbers(formulaCells, sheetName) {
    const findings = [];
    for (const { row, col, raw } of formulaCells.values()) {
        // Strip refs and function names, then look for bare numeric operands.
        const stripped = raw
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')
            .replace(/\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?/g, 'REF')
            .replace(/[A-Z_][A-Z0-9_.]*\s*\(/gi, 'FN(');
        const literals = stripped.match(/(?<![A-Z0-9_.])\d+(?:\.\d+)?/gi) ?? [];
        const meaningful = literals.filter(n => !['0', '1', '2', '100'].includes(n));
        if (meaningful.length === 0) continue;

        findings.push({
            type: 'hardcoded-value',
            severity: 'info',
            sheet: sheetName,
            ref: formatA1Cell(row, col),
            detail: `formula contains literal ${meaningful.join(', ')} — consider a referenced cell`,
            formula: raw,
        });
    }
    return findings;
}

/** Reduce a formula to its structural shape so siblings can be compared. */
function shapeOf(formula) {
    return formula
        .replace(/"(?:[^"\\]|\\.)*"/g, '"S"')
        .replace(/\$?[A-Z]+\$?\d+/g, 'R')
        .replace(/\d+(?:\.\d+)?/g, 'N')
        .replace(/\s+/g, '')
        .toUpperCase();
}

/**
 * Table-level checks: rows violating their own column schema.
 * The UI enforces these on entry, so violations mean data arrived another way
 * (import, an older client, or a script writing past validation).
 */
function inspectTables(ydoc) {
    const findings = [];
    if (!root(ydoc).get('tableData')) return findings;

    for (const t of tableOps.listTables(ydoc)) {
        let schema;
        try { schema = tableOps.getTableSchema(ydoc, t.id); } catch { continue; }

        const constrained = schema.columns.filter(c => c.options?.length && !c.allowCustom);
        const numeric = schema.columns.filter(c => ['number', 'currency', 'percent'].includes(c.type));
        const required = schema.columns.filter(c => c.required && !c.computed);
        if (!constrained.length && !numeric.length && !required.length) continue;

        const rows = tableOps.getRows(ydoc, t.id);
        rows.forEach((row, i) => {
            for (const col of constrained) {
                const v = row[col.id];
                if (v == null || v === '') continue;
                if (!col.options.some(o => String(o) === String(v))) {
                    findings.push({
                        type: 'invalid-table-value',
                        severity: 'warning',
                        table: t.name,
                        row: i,
                        column: col.name,
                        detail: `"${v}" is not among the allowed values`,
                        allowed: col.options,
                    });
                }
            }
            for (const col of numeric) {
                const v = row[col.id];
                if (v == null || v === '') continue;
                if (typeof v !== 'number' && isNaN(Number(v))) {
                    findings.push({
                        type: 'invalid-table-value',
                        severity: 'warning',
                        table: t.name,
                        row: i,
                        column: col.name,
                        detail: `"${v}" is not numeric but the column is ${col.type}`,
                    });
                }
            }
            for (const col of required) {
                const v = row[col.id];
                if (v == null || v === '') {
                    findings.push({
                        type: 'missing-required-value',
                        severity: 'warning',
                        table: t.name,
                        row: i,
                        column: col.name,
                        detail: 'required column is empty',
                    });
                }
            }
        });
    }
    return findings;
}
