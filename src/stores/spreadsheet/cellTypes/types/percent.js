/**
 * Percent cell type descriptor
 */
export const percentType = {
    id: 'percent',
    formatValue(rawValue, config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        const num = Number(rawValue);
        if (isNaN(num)) return String(rawValue);

        const decimals = config?.decimals ?? 2;

        // Percent typically stores 0.125 as 12.5%
        const formatted = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
            style: 'percent'
        }).format(num);

        return formatted;
    },
    parseInput(inputString) {
        if (inputString === '') return null;
        let clean = inputString.replace(/[^\d.%-]/g, '');
        let isPercent = clean.includes('%');
        clean = clean.replace('%', '');

        const num = Number(clean);
        if (isNaN(num)) return inputString;

        // If user typed '12.5%', store as 0.125
        return isPercent ? num / 100 : num;
    },
    defaultStyle() {
        return { horizontalAlign: 'right' };
    }
};

export default percentType;
