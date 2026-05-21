import {
    dateToSerial, serialToDate, coerceToSerial,
    addMonths, endOfMonth,
    weekdayNum, weekNum, isoWeekNum,
    networkDays, workday, parseWeekendSpec, days360,
    formatSerial, parseTimeString,
} from '../dateCore.js';
import { FormulaError, isError, toNumber, toString, toDateSerial, toHolidaySerials } from './_helpers.js';

export const dateFunctions = {
    TODAY: {
        category: 'date', syntax: 'TODAY()',
        desc: "Returns today's date as a serial number. Recalculates each time the sheet recalculates.",
        example: '=TODAY()  →  today\'s date\n=TODAY()-A1  →  days since date in A1',
        description: "Return today's date as a serial number", minArgs: 0, maxArgs: 0,
        call: () => {
            const now = new Date();
            return dateToSerial(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
        }
    },

    NOW: {
        category: 'date', syntax: 'NOW()',
        desc: 'Returns the current date and time as a serial number (integer part = date, fractional part = time).',
        example: '=NOW()  →  current date+time serial',
        description: 'Return current date and time as a serial number', minArgs: 0, maxArgs: 0,
        call: () => dateToSerial(new Date())
    },

    DATE: {
        category: 'date', syntax: 'DATE(year, month, day)',
        desc: 'Returns the serial number for a date given year, month, and day. Month/day overflow rolls over.',
        example: '=DATE(2024, 1, 15)  →  Jan 15 2024\n=DATE(2024, 13, 1)  →  Feb 1 2025 (overflow)',
        description: 'Create a date from year, month, day', minArgs: 3, maxArgs: 3,
        call: (args) => {
            const year = toNumber(args[0]); const month = toNumber(args[1]); const day = toNumber(args[2]);
            if (isError(year)) return year; if (isError(month)) return month; if (isError(day)) return day;
            const y = Math.trunc(year) < 1900 && Math.trunc(year) >= 0 ? 1900 + Math.trunc(year) : Math.trunc(year);
            const d = new Date(y, Math.trunc(month) - 1, Math.trunc(day));
            if (isNaN(d.getTime())) return FormulaError.NUM;
            return dateToSerial(d);
        }
    },

    TIME: {
        category: 'date', syntax: 'TIME(hours, minutes, seconds)',
        desc: 'Returns a fractional serial (0–<1) representing a time of day.',
        example: '=TIME(12, 30, 0)  →  0.520833…  (12:30 PM)',
        description: 'Create a time fraction from hours, minutes, seconds', minArgs: 3, maxArgs: 3,
        call: (args) => {
            const h = toNumber(args[0]); const m = toNumber(args[1]); const s = toNumber(args[2]);
            if (isError(h)) return h; if (isError(m)) return m; if (isError(s)) return s;
            const totalSec = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
            return (((totalSec % 86400) + 86400) % 86400) / 86400;
        }
    },

    DATEVALUE: {
        category: 'date', syntax: 'DATEVALUE(date_text)',
        desc: 'Converts a date string to a serial number.',
        example: '=DATEVALUE("2024-03-15")  →  serial for Mar 15 2024',
        description: 'Convert a date string to a serial number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return Math.floor(s);
        }
    },

    TIMEVALUE: {
        category: 'date', syntax: 'TIMEVALUE(time_text)',
        desc: 'Converts a time string to a fractional serial number (0–<1).',
        example: '=TIMEVALUE("14:30:00")  →  0.604166…',
        description: 'Convert a time string to a fractional serial', minArgs: 1, maxArgs: 1,
        call: (args) => {
            if (typeof args[0] !== 'string') return FormulaError.VALUE;
            const t = parseTimeString(args[0]); if (!t) return FormulaError.VALUE;
            return (t.hours * 3600 + t.minutes * 60 + t.seconds) / 86400;
        }
    },

    YEAR: {
        category: 'date', syntax: 'YEAR(date)',
        desc: 'Returns the year component of a date.',
        example: '=YEAR(TODAY())  →  current year\n=YEAR("2024-03-15")  →  2024',
        description: 'Extract the year from a date', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return serialToDate(Math.floor(s)).getFullYear();
        }
    },

    MONTH: {
        category: 'date', syntax: 'MONTH(date)',
        desc: 'Returns the month (1–12) of a date.',
        example: '=MONTH("2024-03-15")  →  3',
        description: 'Extract the month (1–12) from a date', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return serialToDate(Math.floor(s)).getMonth() + 1;
        }
    },

    DAY: {
        category: 'date', syntax: 'DAY(date)',
        desc: 'Returns the day of the month (1–31) of a date.',
        example: '=DAY("2024-03-15")  →  15',
        description: 'Extract the day of month (1–31) from a date', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return serialToDate(Math.floor(s)).getDate();
        }
    },

    HOUR: {
        category: 'date', syntax: 'HOUR(datetime)',
        desc: 'Returns the hour component (0–23) of a date-time serial.',
        example: '=HOUR(NOW())  →  current hour',
        description: 'Extract the hour (0–23) from a date/time', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return Math.floor((s - Math.floor(s)) * 24);
        }
    },

    MINUTE: {
        category: 'date', syntax: 'MINUTE(datetime)',
        desc: 'Returns the minute component (0–59) of a date-time serial.',
        example: '=MINUTE(NOW())  →  current minute',
        description: 'Extract the minutes (0–59) from a date/time', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return Math.floor(((s - Math.floor(s)) * 1440) % 60);
        }
    },

    SECOND: {
        category: 'date', syntax: 'SECOND(datetime)',
        desc: 'Returns the seconds component (0–59) of a date-time serial.',
        example: '=SECOND(NOW())  →  current second',
        description: 'Extract the seconds (0–59) from a date/time', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return Math.round(((s - Math.floor(s)) * 86400) % 60);
        }
    },

    WEEKDAY: {
        category: 'date', syntax: 'WEEKDAY(date, [type])',
        desc: 'Returns the day of the week as a number. type 1: Sun=1,Sat=7 (default). type 2: Mon=1,Sun=7. type 3: Mon=0,Sun=6.',
        example: '=WEEKDAY("2024-01-15")  →  2 (Monday with default type)',
        description: 'Day of week number', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            const type = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(type)) return type;
            return weekdayNum(s, Math.trunc(type));
        }
    },

    WEEKNUM: {
        category: 'date', syntax: 'WEEKNUM(date, [type])',
        desc: 'Returns the week number within the year. type 1: Sun start (default), type 2: Mon start.',
        example: '=WEEKNUM("2024-01-15")  →  3',
        description: 'Week number within year', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            const type = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(type)) return type;
            return weekNum(s, Math.trunc(type));
        }
    },

    ISOWEEKNUM: {
        category: 'date', syntax: 'ISOWEEKNUM(date)',
        desc: 'Returns the ISO 8601 week number (Monday start, week 1 contains first Thursday).',
        example: '=ISOWEEKNUM("2024-01-01")  →  1',
        description: 'ISO 8601 week number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            return isoWeekNum(s);
        }
    },

    QUARTER: {
        category: 'date', syntax: 'QUARTER(date)',
        desc: 'Returns the calendar quarter (1–4) of a date.',
        example: '=QUARTER("2024-07-15")  →  3',
        description: 'Quarter of the year (1–4)', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const s = toDateSerial(args[0]); if (isError(s)) return s;
            const month = serialToDate(Math.floor(s)).getMonth() + 1;
            return Math.ceil(month / 3);
        }
    },

    EDATE: {
        category: 'date', syntax: 'EDATE(start_date, months)',
        desc: 'Returns the date N months before/after start_date, clamped to month-end.',
        example: '=EDATE("2024-01-31", 1)  →  Feb 29 2024',
        description: 'Date N months from start', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const s = toDateSerial(args[0]); const m = toNumber(args[1]);
            if (isError(s)) return s; if (isError(m)) return m;
            return addMonths(s, Math.trunc(m));
        }
    },

    EOMONTH: {
        category: 'date', syntax: 'EOMONTH(start_date, months)',
        desc: 'Returns the last day of the month N months from start_date.',
        example: '=EOMONTH("2024-01-15", 0)  →  Jan 31 2024\n=EOMONTH("2024-01-15", 1)  →  Feb 29 2024',
        description: 'End of month N months away', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const s = toDateSerial(args[0]); const m = toNumber(args[1]);
            if (isError(s)) return s; if (isError(m)) return m;
            return endOfMonth(s, Math.trunc(m));
        }
    },

    WORKDAY: {
        category: 'date', syntax: 'WORKDAY(start_date, days, [holidays])',
        desc: 'Returns the date N workdays (Mon–Fri) from start_date, optionally excluding holidays.',
        example: '=WORKDAY("2024-01-01", 5)  →  Jan 8 2024',
        description: 'Date N workdays from start', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const s = toDateSerial(args[0]); const n = toNumber(args[1]);
            if (isError(s)) return s; if (isError(n)) return n;
            return workday(s, Math.trunc(n), toHolidaySerials(args[2]));
        }
    },

    'WORKDAY.INTL': {
        category: 'date', syntax: 'WORKDAY.INTL(start_date, days, [weekend], [holidays])',
        desc: 'Like WORKDAY but with a custom weekend. weekend: 1–17 code or "0000011" string.',
        example: '=WORKDAY.INTL("2024-01-01", 5, 2)  →  Mon start weekend',
        note: 'weekend codes: 1=Sat-Sun (default), 2=Sun-Mon, …, 7=Fri-Sat, 11=Sun only, …',
        description: 'Workday with custom weekend', minArgs: 2, maxArgs: 4,
        call: (args) => {
            const s = toDateSerial(args[0]); const n = toNumber(args[1]);
            if (isError(s)) return s; if (isError(n)) return n;
            const wknd = args[2] !== undefined ? parseWeekendSpec(args[2]) : new Set([0, 6]);
            return workday(s, Math.trunc(n), toHolidaySerials(args[3]), wknd);
        }
    },

    DAYS: {
        category: 'date', syntax: 'DAYS(end_date, start_date)',
        desc: 'Returns the number of days between two dates (end_date − start_date).',
        example: '=DAYS("2024-12-31", "2024-01-01")  →  365',
        description: 'Number of days between two dates', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const e = toDateSerial(args[0]); const s = toDateSerial(args[1]);
            if (isError(e)) return e; if (isError(s)) return s;
            return Math.floor(e) - Math.floor(s);
        }
    },

    DAYS360: {
        category: 'date', syntax: 'DAYS360(start_date, end_date, [method])',
        desc: 'Returns days between dates using a 360-day year (30-day months). method TRUE = European.',
        example: '=DAYS360("2024-01-01", "2024-04-01")  →  90',
        description: 'Days using 360-day year', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const s = toDateSerial(args[0]); const e = toDateSerial(args[1]);
            if (isError(s)) return s; if (isError(e)) return e;
            return days360(s, e, !!args[2]);
        }
    },

    DATEDIF: {
        category: 'date', syntax: 'DATEDIF(start_date, end_date, unit)',
        desc: 'Returns the difference between two dates in the given unit: Y, M, D, MD, YM, or YD.',
        example: '=DATEDIF("2020-01-01", "2024-03-15", "Y")  →  4 (complete years)',
        note: 'MD: days ignoring months/years. YM: months ignoring years. YD: days ignoring years.',
        description: 'Date difference in a given unit', minArgs: 3, maxArgs: 3,
        call: (args) => {
            const s = toDateSerial(args[0]); const e = toDateSerial(args[1]);
            if (isError(s)) return s; if (isError(e)) return e;
            if (Math.floor(s) > Math.floor(e)) return FormulaError.NUM;
            const unit = String(args[2]).toUpperCase();
            const sd = serialToDate(Math.floor(s)); const ed = serialToDate(Math.floor(e));
            const sy = sd.getFullYear(), sm = sd.getMonth(), sday = sd.getDate();
            const ey = ed.getFullYear(), em = ed.getMonth(), eday = ed.getDate();
            switch (unit) {
                case 'Y': { let yrs = ey - sy; if (em < sm || (em === sm && eday < sday)) yrs--; return yrs; }
                case 'M': { let mos = (ey - sy) * 12 + (em - sm); if (eday < sday) mos--; return mos; }
                case 'D': return Math.floor(e) - Math.floor(s);
                case 'MD': { let d = eday - sday; if (d < 0) d = new Date(ey, em, 0).getDate() - sday + eday; return d; }
                case 'YM': { let m = em - sm; if (eday < sday) m--; return ((m % 12) + 12) % 12; }
                case 'YD': {
                    const sameYear = new Date(ey, sm, sday); const adjEnd = new Date(ey, em, eday);
                    if (adjEnd < sameYear) return Math.round(dateToSerial(new Date(ey + 1, em, eday)) - dateToSerial(sameYear));
                    return Math.round(dateToSerial(adjEnd) - dateToSerial(sameYear));
                }
                default: return FormulaError.VALUE;
            }
        }
    },

    NETWORKDAYS: {
        category: 'date', syntax: 'NETWORKDAYS(start_date, end_date, [holidays])',
        desc: 'Returns the number of workdays (Mon–Fri) between two dates, excluding holidays.',
        example: '=NETWORKDAYS("2024-01-01", "2024-01-31")  →  23',
        description: 'Workdays between two dates', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const s = toDateSerial(args[0]); const e = toDateSerial(args[1]);
            if (isError(s)) return s; if (isError(e)) return e;
            return networkDays(s, e, toHolidaySerials(args[2]));
        }
    },

    'NETWORKDAYS.INTL': {
        category: 'date', syntax: 'NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])',
        desc: 'Like NETWORKDAYS with a custom weekend. weekend: 1–17 code or "0000011" string.',
        example: '=NETWORKDAYS.INTL("2024-01-01","2024-01-31",2)  →  Mon start',
        description: 'Workdays with custom weekend', minArgs: 2, maxArgs: 4,
        call: (args) => {
            const s = toDateSerial(args[0]); const e = toDateSerial(args[1]);
            if (isError(s)) return s; if (isError(e)) return e;
            const wknd = args[2] !== undefined ? parseWeekendSpec(args[2]) : new Set([0, 6]);
            return networkDays(s, e, toHolidaySerials(args[3]), wknd);
        }
    },

    TEXT: {
        category: 'date', syntax: 'TEXT(value, format)',
        desc: 'Formats a number or date as a text string using a format pattern.',
        example: '=TEXT(TODAY(), "yyyy-MM-dd")  →  "2024-03-15"\n=TEXT(1234.5, "$#,##0.00")  →  "$1,234.50"',
        description: 'Format a number or date as text', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const value = args[0]; const pattern = String(args[1] ?? '');
            const hasDateToken = /[yYmMdDhHsAa]/.test(pattern);
            if (hasDateToken) {
                const serial = toDateSerial(value);
                if (!isError(serial)) return formatSerial(serial, pattern);
            }
            const n = toNumber(value);
            if (isError(n)) return String(value ?? '');
            const pct = pattern.includes('%');
            const num = pct ? n * 100 : n;
            const decMatch = pattern.match(/\.([0#]+)/);
            const decimals = decMatch ? decMatch[1].length : 0;
            const useCommas = pattern.includes(',');
            let result = useCommas
                ? num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
                : num.toFixed(decimals);
            if (pattern.startsWith('"$"') || pattern.startsWith('$')) result = '$' + result;
            if (pct) result += '%';
            return result;
        }
    },

    ISDATE: {
        category: 'date', syntax: 'ISDATE(value)',
        desc: 'Returns TRUE if the value can be interpreted as a date.',
        example: '=ISDATE("2024-03-15")  →  TRUE\n=ISDATE("hello")  →  FALSE',
        description: 'Check if value is a date', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const v = args[0];
            if (typeof v === 'number') return v >= 1 && v < 2958465;
            if (typeof v === 'string') return coerceToSerial(v) !== null;
            return false;
        }
    },
};
