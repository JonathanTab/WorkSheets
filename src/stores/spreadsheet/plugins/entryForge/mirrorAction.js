/**
 * Mirror action for the Entry Forge plugin: given a transfer row, create its
 * complementary entry on the other account (account ⇄ fromTo swapped, amount
 * negated, date/notes copied).
 */

import { toAmount } from './mirrorDetection.js';

/**
 * Build and insert the complementary entry for the row at displayIndex.
 * @param {import('../../features/TableStore.svelte.js').TableStore} table
 * @param {{ account:string, fromTo:string, amount:string, date?:string|null, notes?:string|null }} mapping
 * @param {number} displayIndex
 * @returns {boolean} true if an entry was inserted
 */
export function createMirrorEntry(table, mapping, displayIndex) {
    if (!table || !mapping?.account || !mapping?.fromTo || !mapping?.amount) return false;
    const row = table.sortedFilteredRows?.[displayIndex];
    if (!row) return false;

    const amount = toAmount(row[mapping.amount]);
    if (!Number.isFinite(amount)) return false;

    const newRow = {
        [mapping.account]: row[mapping.fromTo],   // swap sides
        [mapping.fromTo]: row[mapping.account],
        [mapping.amount]: -amount,                // opposite sign
    };
    if (mapping.date) newRow[mapping.date] = row[mapping.date];
    if (mapping.notes) newRow[mapping.notes] = row[mapping.notes];

    // Place the complement directly below the original so the pair sits together,
    // rather than jumping to the top of the table.
    table.insertRowAfter(displayIndex, newRow);
    return true;
}
