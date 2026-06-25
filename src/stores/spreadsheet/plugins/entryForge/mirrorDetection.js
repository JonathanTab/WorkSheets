/**
 * Mirror (complementary transfer) detection for the Entry Forge plugin.
 *
 * A ledger transfer moves money between two real accounts and should be recorded
 * as two complementary rows: one on each account, with opposite-signed amounts.
 * This module finds rows that look like one half of a transfer but have no
 * matching complement yet, so the UI can offer to create it.
 *
 * Detection is fully derived (no persisted pairing) so it stays correct across
 * manual edits, undo, and sync.
 */

const EPSILON = 0.005;

/** Coerce a cell value to a number, tolerating currency-ish strings. */
export function toAmount(v) {
    if (typeof v === 'number') return v;
    if (v == null || v === '') return NaN;
    const n = parseFloat(String(v).replace(/[^0-9.eE+-]/g, ''));
    return Number.isFinite(n) ? n : NaN;
}

function norm(v) {
    return String(v ?? '').trim().toLowerCase();
}

/**
 * Find rows that are unmatched halves of a transfer.
 *
 * @param {import('../../features/TableStore.svelte.js').TableStore} table
 * @param {{ account:string, fromTo:string, amount:string }} mapping  colIds
 * @param {string[]} accountNames  the document's real account names
 * @returns {Array<{ displayIndex:number }>}
 */
export function findMirrorCandidates(table, mapping, accountNames) {
    if (!table || !mapping?.account || !mapping?.fromTo || !mapping?.amount) return [];

    const rows = table.sortedFilteredRows;
    if (!rows?.length) return [];

    const accountSet = new Set((accountNames ?? []).map(norm).filter(Boolean));
    if (accountSet.size === 0) return [];

    const out = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const account = norm(row[mapping.account]);
        const fromTo = norm(row[mapping.fromTo]);
        const amount = toAmount(row[mapping.amount]);

        // Must be a real transfer: a known account on both ends, with an amount.
        if (!account || !fromTo) continue;
        if (!accountSet.has(fromTo)) continue;        // the other side must be a real account
        if (!Number.isFinite(amount) || Math.abs(amount) < EPSILON) continue;

        // Already has a complement? account/fromTo swapped with negated amount.
        const hasComplement = rows.some((other, j) => {
            if (j === i) return false;
            return norm(other[mapping.account]) === fromTo
                && norm(other[mapping.fromTo]) === account
                && Math.abs(toAmount(other[mapping.amount]) + amount) < EPSILON;
        });
        if (hasComplement) continue;

        out.push({ displayIndex: i });
    }
    return out;
}
