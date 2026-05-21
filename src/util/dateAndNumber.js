/**
 * dateAndNumber.js — Shared date/number parse+format utilities.
 *
 * Cell types, the formula engine, and table evaluators all need the same
 * parsing logic. This module is the single import point so neither layer
 * depends directly on the other's internals.
 *
 * Consumers:
 *   - src/formulas/evaluator.js  (already imports from functions.js)
 *   - src/formulas/functions.js  (defines parseNumericString)
 *   - src/formulas/dateCore.js   (defines date helpers)
 *   - src/stores/spreadsheet/cellTypes/types/text.js (was importing both)
 *   - src/stores/spreadsheet/cellTypes/types/date.js
 *   - src/stores/spreadsheet/features/tableFormulaEval.js
 */

// ── Number parsing ─────────────────────────────────────────────────────────────

export { parseNumericString } from '../formulas/functions.js';

// ── Date helpers ───────────────────────────────────────────────────────────────

export {
    dateToSerial,
    serialToDate,
    dateSerialOnly,
    parseLocalDate,
    parseLocalDateTime,
    parseTimeString,
    dateToISO,
    formatDate,
    formatTokens,
    toDateString,
    toDateTimeString,
    timeToString,
    timeStringToDate,
} from '../formulas/dateCore.js';
