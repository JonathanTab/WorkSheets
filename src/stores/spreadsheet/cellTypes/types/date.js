/**
 * Date / Time / DateTime cell type descriptor.
 *
 * subFormat  Storage value             Examples
 * ─────────  ────────────────────────  ─────────────────────────
 * 'date'     "YYYY-MM-DD"              "2025-12-25"
 * 'time'     "HH:mm:ss"                "13:30:45"
 * 'datetime' "YYYY-MM-DD HH:mm:ss"     "2025-12-25 13:30:45"
 *
 * Human-readable, formula-friendly, timezone-free.
 * Backward compat: old ISO strings ("2026-01-05T05:00:00.000Z") are still parsed correctly.
 *
 * Config: { type:'date', subFormat, datePreset, timePreset }
 *   subFormat  defaults to 'date'
 *   datePreset defaults to 'MM/DD/YYYY'
 *   timePreset defaults to 'h:mm A'
 *   Legacy:    config.format is honoured as datePreset
 *
 * Natural shorthand inputs (date subFormat):
 *   1–12        → month N, 1st of that month, current year  (12 → December 1, 2026)
 *   13–31       → day N of current month/year
 *   1900–2100   → January 1 of that year
 *   M/D         → that date in current year  (12/25 → Dec 25, 2026)
 */

// ── Format presets ────────────────────────────────────────────────────────────

/** @type {{ id: string, example: string }[]} */
export const DATE_PRESETS = [
    // ── Full dates ────────────────────────────────────────────────────────────
    { id: 'M/D/YYYY',            example: '1/5/2026' },
    { id: 'MM/DD/YYYY',          example: '01/05/2026' },
    { id: 'MMM D, YYYY',         example: 'Jan 5, 2026' },
    { id: 'MMMM D, YYYY',        example: 'January 5, 2026' },
    { id: 'D-MMM-YYYY',          example: '5-Jan-2026' },
    { id: 'DD/MM/YYYY',          example: '05/01/2026' },
    { id: 'YYYY-MM-DD',          example: '2026-01-05' },
    { id: 'M/D/YY',              example: '1/5/26' },
    // ── With day name ─────────────────────────────────────────────────────────
    { id: 'dddd, MMMM D, YYYY',  example: 'Monday, January 5, 2026' },
    { id: 'ddd, MMM D, YYYY',    example: 'Mon, Jan 5, 2026' },
    { id: 'dddd, M/D/YYYY',      example: 'Monday, 1/5/2026' },
    // ── Partial / component ───────────────────────────────────────────────────
    { id: 'MMMM YYYY',           example: 'January 2026' },
    { id: 'MMM YYYY',            example: 'Jan 2026' },
    { id: 'MMMM',                example: 'January' },
    { id: 'MMM',                 example: 'Jan' },
    { id: 'YYYY',                example: '2026' },
    { id: 'D',                   example: '5' },
    { id: 'dddd',                example: 'Monday' },
    { id: 'ddd',                 example: 'Mon' },
    { id: 'D-MMM',               example: '5-Jan' },
];

/** @type {{ id: string, example: string }[]} */
export const TIME_PRESETS = [
    { id: 'h:mm A',    example: '1:30 PM' },
    { id: 'h:mm:ss A', example: '1:30:45 PM' },
    { id: 'HH:mm',     example: '13:30' },
    { id: 'HH:mm:ss',  example: '13:30:45' },
];

// ── Token-based formatter ─────────────────────────────────────────────────────

// Order: longest tokens first to avoid partial matches
// (dddd before ddd, MMMM before MMM before MM before M, HH before H, etc.)
// Note: lowercase d = day-name tokens; uppercase D = day-number tokens — no collision.
const TOKEN_ORDER = ['YYYY','MMMM','MMM','MM','dddd','ddd','DD','HH','hh','YY','M','D','H','h','mm','ss','A','a'];
const TOKEN_RE    = new RegExp(TOKEN_ORDER.join('|'), 'g');

const FMT_MONTHS_LONG  = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December'];
const FMT_MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun',
                           'Jul','Aug','Sep','Oct','Nov','Dec'];
const FMT_DAYS_LONG    = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const FMT_DAYS_SHORT   = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

/**
 * Format a Date object using a token-based pattern string.
 *
 * Tokens:
 *   YYYY  4-digit year        YY    2-digit year
 *   MMMM  full month name     MMM   short month name
 *   MM    padded month         M    month number
 *   DD    padded day           D    day number
 *   HH    padded 24h hour      H    24h hour
 *   hh    padded 12h hour      h    12h hour
 *   mm    padded minutes       ss   padded seconds
 *   A     AM/PM                a    am/pm
 *
 * @param {Date} date
 * @param {string} pattern
 * @returns {string}
 */
function formatTokens(date, pattern) {
    const y   = date.getFullYear();
    const mo  = date.getMonth();
    const d   = date.getDate();
    const hr  = date.getHours();
    const mi  = date.getMinutes();
    const sc  = date.getSeconds();
    const h12 = hr % 12 || 12;
    const ap  = hr < 12 ? 'AM' : 'PM';

    /** @type {Record<string,string>} */
    const map = {
        YYYY: String(y),
        YY:   String(y).slice(-2),
        dddd: FMT_DAYS_LONG[date.getDay()],
        ddd:  FMT_DAYS_SHORT[date.getDay()],
        MMMM: FMT_MONTHS_LONG[mo],
        MMM:  FMT_MONTHS_SHORT[mo],
        MM:   String(mo + 1).padStart(2, '0'),
        M:    String(mo + 1),
        DD:   String(d).padStart(2, '0'),
        D:    String(d),
        HH:   String(hr).padStart(2, '0'),
        H:    String(hr),
        hh:   String(h12).padStart(2, '0'),
        h:    String(h12),
        mm:   String(mi).padStart(2, '0'),
        ss:   String(sc).padStart(2, '0'),
        A:    ap,
        a:    ap.toLowerCase(),
    };

    return pattern.replace(TOKEN_RE, tok => map[tok] ?? tok);
}

// ── Storage format helpers ────────────────────────────────────────────────────

/**
 * Serialize a Date to the canonical date storage string "YYYY-MM-DD".
 * @param {Date} date
 * @returns {string}
 */
function toDateString(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Serialize a Date to the canonical datetime storage string "YYYY-MM-DD HH:mm:ss".
 * @param {Date} date
 * @returns {string}
 */
function toDateTimeString(date) {
    const h  = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const sc = String(date.getSeconds()).padStart(2, '0');
    return `${toDateString(date)} ${h}:${mi}:${sc}`;
}

// ── Time helpers ──────────────────────────────────────────────────────────────

/**
 * Parse a time string into { hours, minutes, seconds }.
 * Accepts: "H:MM", "H:MM:SS", "H:MM AM/PM", "H:MM:SS AM/PM"
 * @param {string} s
 * @returns {{ hours: number, minutes: number, seconds: number }|null}
 */
function parseTimeString(s) {
    const m = String(s).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
    if (!m) return null;
    let hours    = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const seconds = m[3] ? parseInt(m[3], 10) : 0;
    const ap = m[4]?.toUpperCase();
    if (ap === 'AM') { if (hours === 12) hours = 0; }
    else if (ap === 'PM') { if (hours !== 12) hours += 12; }
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    return { hours, minutes, seconds };
}

/** Serialize { hours, minutes, seconds } to "HH:mm:ss". */
function timeToString({ hours, minutes, seconds }) {
    return `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

/**
 * Build a throwaway Date from a stored "HH:mm:ss" string (only h/m/s matter for formatting).
 * @param {string} s
 * @returns {Date|null}
 */
function timeStringToDate(s) {
    const t = parseTimeString(s);
    if (!t) return null;
    return new Date(2000, 0, 1, t.hours, t.minutes, t.seconds, 0);
}

// ── DateTime helpers ──────────────────────────────────────────────────────────

/**
 * Parse a datetime raw value into a full Date, preserving time.
 * Handles "YYYY-MM-DD HH:mm:ss", full ISO strings, "MM/DD/YYYY HH:mm:ss",
 * and date-only strings (returns local midnight).
 * @param {string|number|null|undefined} s
 * @returns {Date|null}
 */
function parseLocalDateTime(s) {
    if (s === null || s === undefined) return null;
    const str = String(s).trim();
    if (!str) return null;

    // Full ISO 8601 with time ("2026-01-05T13:30:45.000Z")
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        return isValidDate(d) ? d : null;
    }

    // "YYYY-MM-DD HH:MM[:SS][ AM/PM]"
    const m1 = str.match(/^(\d{4}-\d{1,2}-\d{1,2})\s+(.+)$/);
    if (m1) {
        const dp = parseLocalDate(m1[1]);
        const tp = parseTimeString(m1[2].trim());
        if (dp && tp) {
            return new Date(dp.getFullYear(), dp.getMonth(), dp.getDate(),
                tp.hours, tp.minutes, tp.seconds);
        }
    }

    // "MM/DD/YYYY HH:MM[:SS][ AM/PM]" or similar
    const m2 = str.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s+(.+)$/);
    if (m2) {
        const dp = parseLocalDate(m2[1]);
        const tp = parseTimeString(m2[2].trim());
        if (dp && tp) {
            return new Date(dp.getFullYear(), dp.getMonth(), dp.getDate(),
                tp.hours, tp.minutes, tp.seconds);
        }
    }

    // Fall back: date-only (midnight)
    return parseLocalDate(str);
}

// ── Cell type descriptor ──────────────────────────────────────────────────────

export const dateType = {
    id: 'date',

    formatValue(rawValue, config) {
        if (!rawValue) return '';
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

        // Default: date only
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

        // date only — store as "YYYY-MM-DD"
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

// ── Date parsing ──────────────────────────────────────────────────────────────

// Month name lookup (case-insensitive)
const MONTH_NAMES = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
};

// Excel epoch (December 30, 1899 is serial date 0) — kept for numeric input compat
const EXCEL_EPOCH = new Date(1899, 11, 30);

/**
 * Parse a date string (or number) into a local Date.
 * Returns null for invalid/unparseable input.
 *
 * Natural shorthand (new):
 *   1–12        → month N, 1st of that month, current year  ("12" → Dec 1)
 *   13–31       → day N of current month/year
 *   1900–2100   → January 1 of that year
 *   M/D         → that date in current year  ("12/25" → Dec 25)
 *
 * Full date formats:
 *   "YYYY-MM-DD"           ISO date (preferred storage format)
 *   "MM/DD/YYYY"           US format
 *   "D-MMM-YYYY"           Excel-style
 *   "MMM D, YYYY"          Long
 *   + many more variants (see below)
 *
 * Backward compat:
 *   ISO 8601 strings with time ("2026-01-05T05:00:00.000Z") — time portion ignored
 *   Excel serial numbers (numeric type input only)
 *
 * @param {string|number} s
 * @returns {Date|null}
 */
function parseLocalDate(s) {
    if (s === null || s === undefined) return null;

    // Numeric input — treat as Excel serial date for formula/import compat
    if (typeof s === 'number') {
        return serialToDate(s);
    }

    const str = String(s).trim();
    if (!str) return null;

    // ── Relative date keywords ──────────────────────────────────────────────
    const lower = str.toLowerCase();
    if (lower === 'today' || lower === 'now') {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // ── Natural shorthand integers ──────────────────────────────────────────
    // Handles things like: "12" → December, "25" → 25th of this month, "2026" → that year
    if (/^\d+$/.test(str)) {
        const n   = parseInt(str, 10);
        const now = new Date();
        if (n >= 1 && n <= 12) {
            // Month number → 1st of that month, current year
            return new Date(now.getFullYear(), n - 1, 1);
        }
        if (n >= 13 && n <= 31) {
            // Day of current month/year
            return new Date(now.getFullYear(), now.getMonth(), n);
        }
        if (n >= 1900 && n <= 2100) {
            // Year only → January 1
            return new Date(n, 0, 1);
        }
        // Fall through to Excel serial for other ranges (backward compat)
        if (n > 0 && n < 2958465) {
            return serialToDate(n);
        }
        return null;
    }

    // ── YYYY-MM-DD — preferred storage format (also ISO prefix) ────────────
    const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]|$)/);
    if (ymd) {
        const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
        return isValidDate(d) ? d : null;
    }

    // ── Named month formats ─────────────────────────────────────────────────

    // "MMM D, YYYY" / "MMMM D, YYYY" (e.g. "Jan 15, 2024")
    const mdyNamed = str.match(/^([a-zA-Z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mdyNamed) {
        const monthIdx = MONTH_NAMES[mdyNamed[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+mdyNamed[3], monthIdx, +mdyNamed[2]);
            return isValidDate(d) ? d : null;
        }
    }

    // "D-MMM-YYYY" / "D MMM YYYY" (e.g. "15-Jan-2024")
    const dmyNamed = str.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})[-/ ](\d{4})$/);
    if (dmyNamed) {
        const monthIdx = MONTH_NAMES[dmyNamed[2].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+dmyNamed[3], monthIdx, +dmyNamed[1]);
            return isValidDate(d) ? d : null;
        }
    }

    // "D-MMM" / "D MMM" without year — use current year (e.g. "5-Jan" or "5 Jan")
    const dmShort = str.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})$/);
    if (dmShort) {
        const monthIdx = MONTH_NAMES[dmShort[2].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(new Date().getFullYear(), monthIdx, +dmShort[1]);
            return isValidDate(d) ? d : null;
        }
    }

    // "MMM YYYY" / "MMMM YYYY" — month + year only, returns 1st of month
    const myNamed = str.match(/^([a-zA-Z]{3,})\s+(\d{4})$/);
    if (myNamed) {
        const monthIdx = MONTH_NAMES[myNamed[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+myNamed[2], monthIdx, 1);
            return isValidDate(d) ? d : null;
        }
    }

    // "January" / "Jan" — month name only, returns 1st of that month in current year
    const mOnly = str.match(/^([a-zA-Z]{3,})$/);
    if (mOnly) {
        const monthIdx = MONTH_NAMES[mOnly[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            return new Date(new Date().getFullYear(), monthIdx, 1);
        }
    }

    // ── Numeric date formats ────────────────────────────────────────────────

    // "M/D" or "MM/DD" without year — current year shorthand
    const mdNoYear = str.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (mdNoYear) {
        const now = new Date();
        const d = new Date(now.getFullYear(), +mdNoYear[1] - 1, +mdNoYear[2]);
        return isValidDate(d) ? d : null;
    }

    // "MM/DD/YYYY", "M/D/YY", "MM-DD-YYYY", "M-D-YYYY"
    const mdy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (mdy) {
        let month = +mdy[1];
        let day   = +mdy[2];
        let year  = +mdy[3];
        if (year < 100) year = year < 30 ? 2000 + year : 1900 + year;
        // DD/MM/YYYY disambiguation: if first > 12, it must be the day
        if (month > 12 && day <= 12) [month, day] = [day, month];
        const d = new Date(year, month - 1, day);
        return isValidDate(d) ? d : null;
    }

    // ISO 8601 string with time or any other browser-parseable date (strip time, use local date)
    const d = new Date(str);
    if (isValidDate(d)) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    return null;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

/** @param {Date} d @returns {boolean} */
function isValidDate(d) {
    return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Convert Excel serial date number to a JavaScript Date.
 * Excel serial 1 = January 1, 1900.
 * @param {number} serial
 * @returns {Date|null}
 */
function serialToDate(serial) {
    if (serial < 1 || serial > 2958465) return null;
    const days = Math.floor(serial);
    const date = new Date(EXCEL_EPOCH.getTime() + days * 86400000);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// ── Kept exports for DatePickerEditor ────────────────────────────────────────

/**
 * Format a Date to a MM/DD/YYYY display string (used by DatePickerEditor input).
 * @param {Date|null} date
 * @returns {string}
 */
export function formatDate(date) {
    if (!date) return '';
    const mm   = String(date.getMonth() + 1).padStart(2, '0');
    const dd   = String(date.getDate()).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}

/**
 * Convert a local Date to the canonical date storage string "YYYY-MM-DD".
 * (Previously returned a full ISO string — changed to be formula-friendly.)
 * @param {Date} date
 * @returns {string}
 */
export function dateToISO(date) {
    return toDateString(date);
}

export { parseLocalDate };

export default dateType;
