import { FormulaError, isError, toNumber, toString } from './_helpers.js';

export const textFunctions = {
    LEN: {
        category: 'text', syntax: 'LEN(text)',
        desc: 'Returns the number of characters in a text string.',
        example: '=LEN("hello")  →  5\n=LEN(A1)  →  character count of A1',
        description: 'Length of text', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            return str.length;
        }
    },

    UPPER: {
        category: 'text', syntax: 'UPPER(text)',
        desc: 'Converts all characters in a text string to uppercase.',
        example: '=UPPER("hello")  →  "HELLO"',
        description: 'Convert to uppercase', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            return str.toUpperCase();
        }
    },

    LOWER: {
        category: 'text', syntax: 'LOWER(text)',
        desc: 'Converts all characters in a text string to lowercase.',
        example: '=LOWER("HELLO")  →  "hello"',
        description: 'Convert to lowercase', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            return str.toLowerCase();
        }
    },

    PROPER: {
        category: 'text', syntax: 'PROPER(text)',
        desc: 'Capitalizes the first letter of each word.',
        example: '=PROPER("hello world")  →  "Hello World"',
        description: 'Title case', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            return str.replace(/\b\w/g, c => c.toUpperCase());
        }
    },

    TRIM: {
        category: 'text', syntax: 'TRIM(text)',
        desc: 'Removes leading and trailing spaces, and collapses multiple interior spaces to one.',
        example: '=TRIM("  hello  world  ")  →  "hello world"',
        description: 'Remove extra whitespace', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            return str.trim().replace(/\s+/g, ' ');
        }
    },

    LEFT: {
        category: 'text', syntax: 'LEFT(text, [count])',
        desc: 'Returns the specified number of characters from the start of a text string. Defaults to 1.',
        example: '=LEFT("Hello", 3)  →  "Hel"\n=LEFT(A1)  →  first character',
        description: 'Leftmost characters', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            const num = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(num)) return num;
            return str.slice(0, Math.max(0, num));
        }
    },

    RIGHT: {
        category: 'text', syntax: 'RIGHT(text, [count])',
        desc: 'Returns the specified number of characters from the end of a text string. Defaults to 1.',
        example: '=RIGHT("Hello", 3)  →  "llo"\n=RIGHT(A1)  →  last character',
        description: 'Rightmost characters', minArgs: 1, maxArgs: 2,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            const num = args[1] !== undefined ? toNumber(args[1]) : 1;
            if (isError(num)) return num;
            return str.slice(-Math.max(0, num));
        }
    },

    MID: {
        category: 'text', syntax: 'MID(text, start, count)',
        desc: 'Returns a specified number of characters from the middle of a text string. start is 1-based.',
        example: '=MID("Hello World", 7, 5)  →  "World"',
        description: 'Extract substring', minArgs: 3, maxArgs: 3,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            const start = toNumber(args[1]); if (isError(start)) return start;
            const num = toNumber(args[2]); if (isError(num)) return num;
            return str.slice(Math.max(0, start - 1), Math.max(0, start - 1 + num));
        }
    },

    CONCATENATE: {
        category: 'text', syntax: 'CONCATENATE(text1, [text2, …])',
        desc: 'Joins multiple text strings into one. Equivalent to CONCAT.',
        example: '=CONCATENATE(A1, " ", B1)  →  "John Smith"',
        description: 'Join text strings', minArgs: 1, maxArgs: Infinity,
        call: (args) => args.map(toString).join('')
    },

    CONCAT: {
        category: 'text', syntax: 'CONCAT(text1, [text2, …])',
        desc: 'Joins multiple text strings into one. Also accepts ranges.',
        example: '=CONCAT(A1:A3)  →  joins all three cells\n=CONCAT("a","b","c")  →  "abc"',
        description: 'Join text strings', minArgs: 1, maxArgs: Infinity,
        call: (args) => args.map(toString).join('')
    },

    TEXTJOIN: {
        category: 'text', syntax: 'TEXTJOIN(delimiter, ignore_empty, text1, [text2, …])',
        desc: 'Joins text strings with a delimiter between them, optionally ignoring empty values.',
        example: '=TEXTJOIN(", ", TRUE, A1:A5)  →  "a, b, c" (skipping blanks)',
        description: 'Join with delimiter', minArgs: 3, maxArgs: Infinity,
        call: (args) => {
            const delim = toString(args[0]);
            const ignoreEmpty = args[1] === true || args[1] === 1 || String(args[1]).toUpperCase() === 'TRUE';
            const parts = [];
            for (const a of args.slice(2)) {
                const vals = Array.isArray(a) ? a.flat(Infinity) : [a];
                for (const v of vals) {
                    const s = toString(v);
                    if (!ignoreEmpty || s !== '') parts.push(s);
                }
            }
            return parts.join(isError(delim) ? '' : delim);
        }
    },

    SUBSTITUTE: {
        category: 'text', syntax: 'SUBSTITUTE(text, old_text, new_text, [instance])',
        desc: 'Replaces occurrences of old_text with new_text. If instance is given, only that occurrence is replaced.',
        example: '=SUBSTITUTE("aababc","a","X")  →  "XXbXbc"\n=SUBSTITUTE("aababc","a","X",2)  →  "aXbabc"',
        description: 'Replace text occurrences', minArgs: 3, maxArgs: 4,
        call: (args) => {
            const text = toString(args[0]); const oldText = toString(args[1]); const newText = toString(args[2]);
            if (isError(text) || isError(oldText) || isError(newText)) return isError(text) ? text : isError(oldText) ? oldText : newText;
            if (oldText === '') return text;
            if (args[3] !== undefined) {
                const n = toNumber(args[3]); if (isError(n)) return n;
                let count = 0, pos = 0, result = '';
                while (pos < text.length) {
                    const idx = text.indexOf(oldText, pos);
                    if (idx === -1) { result += text.slice(pos); break; }
                    count++;
                    if (count === Math.trunc(n)) { result += text.slice(pos, idx) + newText; pos = idx + oldText.length; }
                    else { result += text.slice(pos, idx + oldText.length); pos = idx + oldText.length; }
                }
                return result;
            }
            return text.split(oldText).join(newText);
        }
    },

    REPLACE: {
        category: 'text', syntax: 'REPLACE(text, start, count, new_text)',
        desc: 'Replaces part of a text string with another string. start is 1-based.',
        example: '=REPLACE("Hello World", 7, 5, "There")  →  "Hello There"',
        description: 'Replace by position', minArgs: 4, maxArgs: 4,
        call: (args) => {
            const text = toString(args[0]); if (isError(text)) return text;
            const start = toNumber(args[1]); if (isError(start)) return start;
            const count = toNumber(args[2]); if (isError(count)) return count;
            const newText = toString(args[3]); if (isError(newText)) return newText;
            const s = Math.max(0, Math.trunc(start) - 1);
            return text.slice(0, s) + newText + text.slice(s + Math.max(0, Math.trunc(count)));
        }
    },

    FIND: {
        category: 'text', syntax: 'FIND(find_text, within_text, [start])',
        desc: 'Returns the position of find_text within within_text. Case-sensitive. Returns #VALUE! if not found.',
        example: '=FIND("World", "Hello World")  →  7',
        description: 'Find (case-sensitive)', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const find = toString(args[0]); const within = toString(args[1]);
            if (isError(find) || isError(within)) return isError(find) ? find : within;
            const start = args[2] !== undefined ? toNumber(args[2]) : 1;
            if (isError(start)) return start;
            const idx = within.indexOf(find, Math.max(0, Math.trunc(start) - 1));
            return idx === -1 ? FormulaError.VALUE : idx + 1;
        }
    },

    SEARCH: {
        category: 'text', syntax: 'SEARCH(find_text, within_text, [start])',
        desc: 'Like FIND but case-insensitive. Supports wildcards (* and ?).',
        example: '=SEARCH("hello", "Hello World")  →  1',
        description: 'Find (case-insensitive)', minArgs: 2, maxArgs: 3,
        call: (args) => {
            const find = toString(args[0]); const within = toString(args[1]);
            if (isError(find) || isError(within)) return isError(find) ? find : within;
            const start = args[2] !== undefined ? toNumber(args[2]) : 1;
            if (isError(start)) return start;
            const pattern = find.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
            const regex = new RegExp(pattern, 'i');
            const sub = within.slice(Math.max(0, Math.trunc(start) - 1));
            const m = regex.exec(sub);
            return m ? m.index + Math.max(0, Math.trunc(start) - 1) + 1 : FormulaError.VALUE;
        }
    },

    VALUE: {
        category: 'text', syntax: 'VALUE(text)',
        desc: 'Converts a text string that represents a number to a numeric value.',
        example: '=VALUE("42")  →  42\n=VALUE("$1,234")  →  1234',
        description: 'Text to number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const n = toNumber(args[0]);
            return isError(n) ? FormulaError.VALUE : n;
        }
    },

    CHAR: {
        category: 'text', syntax: 'CHAR(number)',
        desc: 'Returns the character corresponding to the given Unicode code point.',
        example: '=CHAR(65)  →  "A"\n=CHAR(10)  →  newline',
        description: 'Character from code', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const num = toNumber(args[0]); if (isError(num)) return num;
            return String.fromCodePoint(Math.trunc(num));
        }
    },

    CODE: {
        category: 'text', syntax: 'CODE(text)',
        desc: 'Returns the Unicode code point of the first character in a text string.',
        example: '=CODE("A")  →  65\n=CODE("hello")  →  104',
        description: 'Code of first character', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            if (!str.length) return FormulaError.VALUE;
            return str.codePointAt(0);
        }
    },

    EXACT: {
        category: 'text', syntax: 'EXACT(text1, text2)',
        desc: 'Returns TRUE if two text strings are exactly the same (case-sensitive).',
        example: '=EXACT("Hello","Hello")  →  TRUE\n=EXACT("Hello","hello")  →  FALSE',
        description: 'Case-sensitive equality', minArgs: 2, maxArgs: 2,
        call: (args) => {
            return toString(args[0]) === toString(args[1]);
        }
    },

    REPT: {
        category: 'text', syntax: 'REPT(text, count)',
        desc: 'Repeats a text string a specified number of times.',
        example: '=REPT("-", 10)  →  "----------"',
        description: 'Repeat text', minArgs: 2, maxArgs: 2,
        call: (args) => {
            const str = toString(args[0]); if (isError(str)) return str;
            const num = toNumber(args[1]); if (isError(num)) return num;
            return str.repeat(Math.max(0, Math.trunc(num)));
        }
    },

    NUMBERVALUE: {
        category: 'text', syntax: 'NUMBERVALUE(text)',
        desc: 'Converts a text string to a number, handling locale-style formatting.',
        example: '=NUMBERVALUE("1,234.56")  →  1234.56',
        description: 'Locale-aware text to number', minArgs: 1, maxArgs: 1,
        call: (args) => {
            const n = toNumber(args[0]);
            return isError(n) ? FormulaError.VALUE : n;
        }
    },
};
