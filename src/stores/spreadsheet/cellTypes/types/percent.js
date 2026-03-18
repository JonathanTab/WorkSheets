/**
 * Percent cell type descriptor
 *
 * Stores the percentage as a plain number (50 = 50%).
 * Does NOT use the 0–1 fraction convention to avoid confusion.
 */
export const percentType = {
    id: 'percent',
    formatValue(rawValue, config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        const num = Number(rawValue);
        if (isNaN(num)) return String(rawValue);

        const decimals = config?.decimals ?? 2;

        const formatted = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        }).format(num);

        return `${formatted}%`;
    },
    parseInput(inputString) {
        if (inputString === '') return null;
        // Strip % and whitespace, keep digits, dot, minus
        const clean = inputString.replace(/[^\d.\-]/g, '');
        const num = Number(clean);
        if (isNaN(num)) return inputString;
        // Store as-is — 50% is stored as 50
        return num;
    },
    defaultStyle() {
        return { horizontalAlign: 'right' };
    }
};

export default percentType;
