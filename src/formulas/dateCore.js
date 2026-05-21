/**
 * dateCore.js — shared date/time serial arithmetic for formulas and cell types.
 *
 * Serial system (matches Google Sheets 1900 date system):
 *   Serial 0  = December 30, 1899
 *   Serial 1  = December 31, 1899
 *   Serial 2  = January  1,  1900
 *   Serial 44927 = January 1, 2023
 *
 * Integer part = days since epoch; fractional part = fraction of 24-hour day.
 * The Lotus/Excel 1900 leap-day bug (serial 60 = Feb 29 1900) is NOT replicated.
 */

// ── Epoch ──────────────────────────────────────────────────────────────────────

// December 30, 1899 in UTC — serial 0
const EPOCH_UTC = Date.UTC(1899, 11, 30);

// ── Serial ↔ Date ──────────────────────────────────────────────────────────────

/**
 * Convert a JS Date to a serial number.
 * Uses local calendar fields so the result is timezone-independent.
 * @param {Date} d
 * @returns {number}
 */
export function dateToSerial(d) {
    const localMidnightUTC = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    const days = (localMidnightUTC - EPOCH_UTC) / 86400000;
    const frac = (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400;
    return days + frac;
}

/**
 * Convert a serial number to a local JS Date.
 * @param {number} serial
 * @returns {Date}
 */
export function serialToDate(serial) {
    const days = Math.floor(serial);
    const frac = serial - days;
    const tmp = new Date(EPOCH_UTC + days * 86400000);
    const totalSec = Math.round(frac * 86400);
    const h  = Math.floor(totalSec / 3600);
    const mi = Math.floor((totalSec % 3600) / 60);
    const s  = totalSec % 60;
    return new Date(tmp.getUTCFullYear(), tmp.getUTCMonth(), tmp.getUTCDate(), h, mi, s);
}

/**
 * Return only the integer (date) part of a serial.
 * @param {Date} d
 * @returns {number}
 */
export function dateSerialOnly(d) {
    const localMidnightUTC = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    return (localMidnightUTC - EPOCH_UTC) / 86400000;
}

// ── Parsing ────────────────────────────────────────────────────────────────────

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

/** @param {Date} d @returns {boolean} */
function isValidDate(d) {
    return d instanceof Date && !isNaN(d.getTime());
}

/**
 * Parse a time string into { hours, minutes, seconds }.
 * Accepts "H:MM", "H:MM:SS", "H:MM AM/PM", "H:MM:SS AM/PM"
 * @param {string} s
 * @returns {{ hours: number, minutes: number, seconds: number }|null}
 */
export function parseTimeString(s) {
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

/**
 * Parse a date string (or serial number) into a local JS Date.
 * Returns null for invalid/unparseable input.
 *
 * Handles:
 *   "YYYY-MM-DD"          ISO (preferred storage)
 *   "MM/DD/YYYY", "M/D/YY"
 *   "D-MMM-YYYY", "MMM D, YYYY"
 *   "MMM YYYY", "Jan", "2026" (year only), "12" (month), "25" (day)
 *   Full ISO strings with time (time portion stripped)
 *   Numeric input treated as Excel serial
 *
 * @param {string|number} s
 * @returns {Date|null}
 */
export function parseLocalDate(s) {
    if (s === null || s === undefined) return null;

    if (typeof s === 'number') {
        return serialToDate(s);
    }

    const str = String(s).trim();
    if (!str) return null;

    const lower = str.toLowerCase();
    if (lower === 'today' || lower === 'now') {
        const d = new Date();
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    // Natural shorthand integers
    if (/^\d+$/.test(str)) {
        const n   = parseInt(str, 10);
        const now = new Date();
        if (n >= 1 && n <= 12)         return new Date(now.getFullYear(), n - 1, 1);
        if (n >= 13 && n <= 31)        return new Date(now.getFullYear(), now.getMonth(), n);
        if (n >= 1900 && n <= 2100)    return new Date(n, 0, 1);
        if (n > 0 && n < 2958465)      return serialToDate(n);
        return null;
    }

    // YYYY-MM-DD (with optional T or space after)
    const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]|$)/);
    if (ymd) {
        const d = new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
        return isValidDate(d) ? d : null;
    }

    // "MMM D, YYYY" / "MMMM D, YYYY"
    const mdyNamed = str.match(/^([a-zA-Z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
    if (mdyNamed) {
        const monthIdx = MONTH_NAMES[mdyNamed[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+mdyNamed[3], monthIdx, +mdyNamed[2]);
            return isValidDate(d) ? d : null;
        }
    }

    // "D-MMM-YYYY" / "D MMM YYYY"
    const dmyNamed = str.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})[-/ ](\d{4})$/);
    if (dmyNamed) {
        const monthIdx = MONTH_NAMES[dmyNamed[2].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+dmyNamed[3], monthIdx, +dmyNamed[1]);
            return isValidDate(d) ? d : null;
        }
    }

    // "D-MMM" / "D MMM" (no year — current year)
    const dmShort = str.match(/^(\d{1,2})[-/ ]([a-zA-Z]{3,})$/);
    if (dmShort) {
        const monthIdx = MONTH_NAMES[dmShort[2].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(new Date().getFullYear(), monthIdx, +dmShort[1]);
            return isValidDate(d) ? d : null;
        }
    }

    // "MMM YYYY" / "MMMM YYYY"
    const myNamed = str.match(/^([a-zA-Z]{3,})\s+(\d{4})$/);
    if (myNamed) {
        const monthIdx = MONTH_NAMES[myNamed[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            const d = new Date(+myNamed[2], monthIdx, 1);
            return isValidDate(d) ? d : null;
        }
    }

    // "January" / "Jan" (month name only)
    const mOnly = str.match(/^([a-zA-Z]{3,})$/);
    if (mOnly) {
        const monthIdx = MONTH_NAMES[mOnly[1].toLowerCase().substring(0, 3)];
        if (monthIdx !== undefined) {
            return new Date(new Date().getFullYear(), monthIdx, 1);
        }
    }

    // "M/D" or "MM/DD" (no year)
    const mdNoYear = str.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (mdNoYear) {
        const now = new Date();
        const d = new Date(now.getFullYear(), +mdNoYear[1] - 1, +mdNoYear[2]);
        return isValidDate(d) ? d : null;
    }

    // "MM/DD/YYYY", "M/D/YY"
    const mdy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (mdy) {
        let month = +mdy[1], day = +mdy[2], year = +mdy[3];
        if (year < 100) year = year < 30 ? 2000 + year : 1900 + year;
        if (month > 12 && day <= 12) [month, day] = [day, month];
        const d = new Date(year, month - 1, day);
        return isValidDate(d) ? d : null;
    }

    // ISO 8601 with time — strip time, use local date
    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        if (isValidDate(d)) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    return null;
}

/**
 * Parse a datetime string into a full Date (preserving time).
 * @param {string|number|null|undefined} s
 * @returns {Date|null}
 */
export function parseLocalDateTime(s) {
    if (s === null || s === undefined) return null;
    const str = String(s).trim();
    if (!str) return null;

    if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
        const d = new Date(str);
        return isValidDate(d) ? d : null;
    }

    const m1 = str.match(/^(\d{4}-\d{1,2}-\d{1,2})\s+(.+)$/);
    if (m1) {
        const dp = parseLocalDate(m1[1]);
        const tp = parseTimeString(m1[2].trim());
        if (dp && tp) {
            return new Date(dp.getFullYear(), dp.getMonth(), dp.getDate(),
                tp.hours, tp.minutes, tp.seconds);
        }
    }

    const m2 = str.match(/^(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4})\s+(.+)$/);
    if (m2) {
        const dp = parseLocalDate(m2[1]);
        const tp = parseTimeString(m2[2].trim());
        if (dp && tp) {
            return new Date(dp.getFullYear(), dp.getMonth(), dp.getDate(),
                tp.hours, tp.minutes, tp.seconds);
        }
    }

    return parseLocalDate(str);
}

/**
 * Coerce any value to a date serial. Returns null if the value is not a date.
 * - number  → returned as-is
 * - Date    → converted via dateToSerial
 * - string  → tried as time-only (returns fraction), then datetime, then date
 * @param {any} value
 * @returns {number|null}
 */
export function coerceToSerial(value) {
    if (typeof value === 'number') return value;
    if (value instanceof Date) return dateToSerial(value);
    if (typeof value === 'string') {
        const str = value.trim();
        // Time-only string → fractional serial
        const t = parseTimeString(str);
        if (t) {
            return (t.hours * 3600 + t.minutes * 60 + t.seconds) / 86400;
        }
        // Datetime string
        const dt = parseLocalDateTime(str);
        if (dt) return dateToSerial(dt);
        // Date string
        const d = parseLocalDate(str);
        if (d) return dateToSerial(d);
    }
    return null;
}

// ── Formatting ─────────────────────────────────────────────────────────────────

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
 * Tokens: YYYY YY MMMM MMM MM M dddd ddd DD D HH H hh h mm ss A a
 * @param {Date} date
 * @param {string} pattern
 * @returns {string}
 */
export function formatTokens(date, pattern) {
    const y   = date.getFullYear();
    const mo  = date.getMonth();
    const d   = date.getDate();
    const hr  = date.getHours();
    const mi  = date.getMinutes();
    const sc  = date.getSeconds();
    const h12 = hr % 12 || 12;
    const ap  = hr < 12 ? 'AM' : 'PM';

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

/**
 * Format a serial number using a token-based date/time pattern.
 * @param {number} serial
 * @param {string} pattern
 * @returns {string}
 */
export function formatSerial(serial, pattern) {
    return formatTokens(serialToDate(serial), pattern);
}

// ── Storage string helpers ─────────────────────────────────────────────────────

/** @param {Date} d @returns {string} "YYYY-MM-DD" */
export function toDateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** @param {Date} d @returns {string} "YYYY-MM-DD HH:mm:ss" */
export function toDateTimeString(d) {
    const h  = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const sc = String(d.getSeconds()).padStart(2, '0');
    return `${toDateString(d)} ${h}:${mi}:${sc}`;
}

/** @param {{ hours: number, minutes: number, seconds: number }} t @returns {string} "HH:mm:ss" */
export function timeToString({ hours, minutes, seconds }) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Build a throwaway Date from a stored "HH:mm:ss" string (only h/m/s matter).
 * @param {string} s
 * @returns {Date|null}
 */
export function timeStringToDate(s) {
    const t = parseTimeString(s);
    if (!t) return null;
    return new Date(2000, 0, 1, t.hours, t.minutes, t.seconds, 0);
}

// ── Date arithmetic primitives ─────────────────────────────────────────────────

/** @param {number} year @returns {boolean} */
export function isLeapYear(year) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * Add a number of months to a date serial (EDATE behavior — clamps to month end).
 * @param {number} serial
 * @param {number} months  integer (positive or negative)
 * @returns {number}
 */
export function addMonths(serial, months) {
    const d   = serialToDate(Math.floor(serial));
    let y  = d.getFullYear();
    let m  = d.getMonth() + months;
    const day = d.getDate();
    y += Math.floor(m / 12);
    m  = ((m % 12) + 12) % 12;
    const maxDay = new Date(y, m + 1, 0).getDate();
    return dateToSerial(new Date(y, m, Math.min(day, maxDay)));
}

/**
 * Return the serial for the last day of the month that is `offsetMonths` from start.
 * @param {number} serial
 * @param {number} offsetMonths
 * @returns {number}
 */
export function endOfMonth(serial, offsetMonths) {
    const d = serialToDate(Math.floor(serial));
    let y = d.getFullYear();
    let m = d.getMonth() + offsetMonths;
    y += Math.floor(m / 12);
    m  = ((m % 12) + 12) % 12;
    return dateToSerial(new Date(y, m + 1, 0)); // day 0 of next month = last day of this
}

/**
 * Day-of-week number for a serial.
 * type 1 (default): Sun=1..Sat=7
 * type 2: Mon=1..Sun=7
 * type 3: Mon=0..Sun=6
 * @param {number} serial
 * @param {number} type
 * @returns {number}
 */
export function weekdayNum(serial, type = 1) {
    const dow = serialToDate(Math.floor(serial)).getDay(); // 0=Sun
    if (type === 1) return dow + 1;
    if (type === 2) return dow === 0 ? 7 : dow;
    if (type === 3) return dow === 0 ? 6 : dow - 1;
    return dow + 1;
}

/**
 * Week number within the year.
 * type 1 (default): week starts Sunday
 * type 2: week starts Monday
 * @param {number} serial
 * @param {number} type
 * @returns {number}
 */
export function weekNum(serial, type = 1) {
    const d    = serialToDate(Math.floor(serial));
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const dayOfYear = Math.floor((d - jan1) / 86400000) + 1;
    if (type === 2) {
        const offset = jan1.getDay() === 0 ? 6 : jan1.getDay() - 1;
        return Math.ceil((dayOfYear + offset) / 7);
    }
    return Math.ceil((dayOfYear + jan1.getDay()) / 7);
}

/**
 * ISO 8601 week number (Monday start, week 1 contains first Thursday).
 * @param {number} serial
 * @returns {number}
 */
export function isoWeekNum(serial) {
    const d = serialToDate(Math.floor(serial));
    const dow = d.getDay() || 7; // Mon=1..Sun=7
    const thursday = new Date(d);
    thursday.setDate(d.getDate() + 4 - dow);
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    return Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
}

/**
 * Parse a WORKDAY.INTL / NETWORKDAYS.INTL weekend spec to a Set of weekend dow numbers (JS: 0=Sun).
 * Numeric codes 1–17 match Excel. String "1000011" = Mon..Sun mask (1=weekend).
 * @param {number|string} spec
 * @returns {Set<number>}
 */
export function parseWeekendSpec(spec) {
    if (typeof spec === 'string' && spec.length === 7) {
        // "1000011": position 0=Mon, 6=Sun; 1=weekend day
        const dayMap = [1, 2, 3, 4, 5, 6, 0]; // Mon→1, Tue→2, ..., Sat→6, Sun→0
        const days = new Set();
        for (let i = 0; i < 7; i++) {
            if (spec[i] === '1') days.add(dayMap[i]);
        }
        return days;
    }
    const n = Number(spec);
    const codes = {
        1: [0, 6], 2: [0, 1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [5, 6],
        11: [0], 12: [1], 13: [2], 14: [3], 15: [4], 16: [5], 17: [6],
    };
    return new Set(codes[n] ?? [0, 6]);
}

const DEFAULT_WEEKEND = new Set([0, 6]); // Sun, Sat

/**
 * Count network (work) days between two serials (inclusive), excluding weekends and holidays.
 * When start > end, returns a negative count.
 * @param {number} startSerial
 * @param {number} endSerial
 * @param {number[]} holidays  array of date serials to exclude
 * @param {Set<number>} weekendDays  JS dow numbers that are weekend
 * @returns {number}
 */
export function networkDays(startSerial, endSerial, holidays = [], weekendDays = DEFAULT_WEEKEND) {
    const sign  = startSerial <= endSerial ? 1 : -1;
    const start = Math.floor(Math.min(startSerial, endSerial));
    const end   = Math.floor(Math.max(startSerial, endSerial));
    const hols  = new Set(holidays.map(h => Math.floor(h)));
    let count = 0;
    for (let s = start; s <= end; s++) {
        const dow = serialToDate(s).getDay();
        if (!weekendDays.has(dow) && !hols.has(s)) count++;
    }
    return sign * count;
}

/**
 * Return the serial that is n workdays from start (positive = forward, negative = backward).
 * @param {number} startSerial
 * @param {number} n
 * @param {number[]} holidays
 * @param {Set<number>} weekendDays
 * @returns {number}
 */
export function workday(startSerial, n, holidays = [], weekendDays = DEFAULT_WEEKEND) {
    if (n === 0) return Math.floor(startSerial);
    const hols = new Set(holidays.map(h => Math.floor(h)));
    const step = n > 0 ? 1 : -1;
    let current = Math.floor(startSerial);
    let remaining = Math.abs(n);
    while (remaining > 0) {
        current += step;
        const dow = serialToDate(current).getDay();
        if (!weekendDays.has(dow) && !hols.has(current)) remaining--;
    }
    return current;
}

/**
 * DAYS360: difference using 360-day year (30-day months).
 * method false (US, default): adjust end day only when start is also 30/31
 * method true (European): both days clamped to 30
 * @param {number} startSerial
 * @param {number} endSerial
 * @param {boolean} method
 * @returns {number}
 */
export function days360(startSerial, endSerial, method = false) {
    const s = serialToDate(Math.floor(startSerial));
    const e = serialToDate(Math.floor(endSerial));
    let y1 = s.getFullYear(), m1 = s.getMonth() + 1, d1 = s.getDate();
    let y2 = e.getFullYear(), m2 = e.getMonth() + 1, d2 = e.getDate();
    if (!method) {
        if (d1 === 31) d1 = 30;
        if (d2 === 31 && d1 === 30) d2 = 30;
    } else {
        if (d1 === 31) d1 = 30;
        if (d2 === 31) d2 = 30;
    }
    return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

// ── Legacy / compat exports (for DatePickerEditor and other existing callers) ──

/**
 * Format a Date to "MM/DD/YYYY" (used by DatePickerEditor input).
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
 * Convert a Date to the canonical "YYYY-MM-DD" storage string.
 * @param {Date} date
 * @returns {string}
 */
export function dateToISO(date) {
    return toDateString(date);
}
