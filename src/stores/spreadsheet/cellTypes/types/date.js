/**
 * Date / Time / DateTime cell type descriptor.
 *
 * subFormat  Storage value             Examples
 * ─────────  ────────────────────────  ─────────────────────────
 * 'date'     "YYYY-MM-DD"              "2025-12-25"
 * 'time'     "HH:mm:ss"                "13:30:45"
 * 'datetime' "YYYY-MM-DD HH:mm:ss"     "2025-12-25 13:30:45"
 *
 * Config: { type:'date', subFormat, datePreset, timePreset }
 *   subFormat  defaults to 'date'
 *   datePreset defaults to 'MM/DD/YYYY'
 *   timePreset defaults to 'h:mm A'
 *   Legacy:    config.format is honoured as datePreset
 *
 * Natural shorthand inputs (date subFormat):
 *   1–12        → month N, 1st of that month, current year
 *   13–31       → day N of current month/year
 *   1900–2100   → January 1 of that year
 *   M/D         → that date in current year
 */

import {
    parseLocalDate,
    parseLocalDateTime,
    parseTimeString,
    formatTokens,
    formatDate,
    dateToISO,
    toDateString,
    toDateTimeString,
    timeToString,
    timeStringToDate,
} from '../../../../util/dateAndNumber.js';

import DateConfigPanel from './DateConfigPanel.svelte';

// Re-export presets so consumers can import from one place (no circular dep since
// the arrays now live in datePresets.js, not here).
export { DATE_PRESETS, TIME_PRESETS } from './datePresets.js';

// Re-export for backward-compat consumers. Prefer importing from util/dateAndNumber.js in new code.
export { parseLocalDate, formatDate, dateToISO };

// ── Cell type descriptor ──────────────────────────────────────────────────────

export const dateType = {
    id: 'date',
    renderType: 'text',
    configPanel: DateConfigPanel,

    formatValue(rawValue, config) {
        if (!rawValue && rawValue !== 0) return '';
        const subFmt      = config?.subFormat  || 'date';
        const datePattern = config?.datePreset ?? config?.format ?? 'MM/DD/YYYY';
        const timePattern = config?.timePreset ?? 'h:mm A';

        if (subFmt === 'time') {
            const d = timeStringToDate(rawValue);
            if (!d) return String(rawValue);
            return formatTokens(d, timePattern);
        }

        if (subFmt === 'datetime') {
            const d = parseLocalDateTime(rawValue);
            if (!d) return String(rawValue);
            return formatTokens(d, `${datePattern} ${timePattern}`);
        }

        const date = parseLocalDate(rawValue);
        if (!date) return String(rawValue);
        return formatTokens(date, datePattern);
    },

    parseInput(inputString, config) {
        if (!inputString) return null;
        const s = String(inputString).trim();
        const subFmt = config?.subFormat || 'date';

        if (subFmt === 'time') {
            const t = parseTimeString(s);
            if (!t) return s;
            return timeToString(t);
        }

        if (subFmt === 'datetime') {
            const d = parseLocalDateTime(s);
            if (!d) return s;
            return toDateTimeString(d);
        }

        const date = parseLocalDate(s);
        if (!date) return s;
        return toDateString(date);
    },

    defaultStyle() {
        return { horizontalAlign: 'left' };
    },

    getEditorComponent() {
        return { component: 'date-picker' };
    },
};

export default dateType;
