/**
 * clipboard/pasteModes.js — the paste-mode matrix, as data.
 *
 * Previously this logic was a tangle of `['full','values',...].includes(mode)`
 * checks recomputed inside applyPaste. Centralizing it here makes "what does each
 * mode actually do" a single readable table, and keeps apply.js declarative.
 *
 * Supported modes:
 *   full           — everything (values, formulas, format, borders, merges, dims, structure)
 *   values         — computed/display values only, no formula, no format
 *   formulas       — formulas only (with ref adjustment), no format
 *   formatting     — format + borders only, overlaid (no structural clear)
 *   valuesFormat   — values + format + borders
 *   formulasFormat — formulas + format + borders
 */

/** @typedef {'full'|'values'|'formulas'|'formatting'|'valuesFormat'|'formulasFormat'} PasteMode */

const MATRIX = {
    full:           { values: true,  formulas: true,  format: true,  structure: true  },
    values:         { values: true,  formulas: false, format: false, structure: false },
    formulas:       { values: false, formulas: true,  format: false, structure: false },
    formatting:     { values: false, formulas: false, format: true,  structure: false },
    valuesFormat:   { values: true,  formulas: false, format: true,  structure: false },
    formulasFormat: { values: false, formulas: true,  format: true,  structure: false },
};

/**
 * Resolve a paste mode + source provenance into a concrete plan of flags.
 *
 * @param {PasteMode} mode
 * @param {boolean} isInternal  whether the payload originated from this app
 * @returns {{
 *   includesValues:boolean, includesFormulas:boolean, includesFormatting:boolean,
 *   includesBorders:boolean, formulasOnly:boolean,
 *   clearExistingBorders:boolean, clearAbsentStyleProps:boolean,
 *   replaceStructure:boolean, isInternal:boolean,
 * }}
 */
export function resolvePastePlan(mode, isInternal) {
    const m = MATRIX[mode] ?? MATRIX.full;

    const includesFormatting = m.format;
    return {
        includesValues:    m.values,
        includesFormulas:  m.formulas,
        includesFormatting,
        includesBorders:   includesFormatting,
        formulasOnly:      mode === 'formulas',
        // Only "full" replaces destination borders/merges/dims wholesale; special
        // formatting modes overlay on top without wiping unmentioned destination edges.
        clearExistingBorders: m.structure,
        replaceStructure:     m.structure,
        // Clear destination style keys the source doesn't set — but only for internal
        // pastes. External (HTML/TSV/Google) pastes leave unmentioned destination
        // styles intact so a plain-text paste doesn't strip surrounding formatting.
        clearAbsentStyleProps: isInternal && includesFormatting,
        isInternal,
    };
}
