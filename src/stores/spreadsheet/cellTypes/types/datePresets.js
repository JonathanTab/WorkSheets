/** @type {{ id: string, example: string }[]} */
export const DATE_PRESETS = [
    { id: 'M/D/YYYY',            example: '1/5/2026' },
    { id: 'MM/DD/YYYY',          example: '01/05/2026' },
    { id: 'MMM D, YYYY',         example: 'Jan 5, 2026' },
    { id: 'MMMM D, YYYY',        example: 'January 5, 2026' },
    { id: 'D-MMM-YYYY',          example: '5-Jan-2026' },
    { id: 'DD/MM/YYYY',          example: '05/01/2026' },
    { id: 'YYYY-MM-DD',          example: '2026-01-05' },
    { id: 'M/D/YY',              example: '1/5/26' },
    { id: 'dddd, MMMM D, YYYY',  example: 'Monday, January 5, 2026' },
    { id: 'ddd, MMM D, YYYY',    example: 'Mon, Jan 5, 2026' },
    { id: 'dddd, M/D/YYYY',      example: 'Monday, 1/5/2026' },
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
