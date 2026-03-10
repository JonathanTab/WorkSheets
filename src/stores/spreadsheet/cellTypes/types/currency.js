/**
 * Currency cell type descriptor
 */
export const currencyType = {
    id: 'currency',
    formatValue(rawValue, config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        const num = Number(rawValue);
        if (isNaN(num)) return String(rawValue);

        const symbol = config?.symbol || '$';
        const decimals = config?.decimals ?? 2;
        const locale = config?.locale || undefined;

        // We use Intl.NumberFormat but might need to handle custom symbols manually
        // if they aren't standard ISO codes. For simplicity here, we prepend the symbol.
        const formatted = new Intl.NumberFormat(locale, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
            useGrouping: true
        }).format(num);

        return `${symbol}${formatted}`;
    },
    parseInput(inputString) {
        if (inputString === '') return null;
        // Strip symbol and commas
        const clean = inputString.replace(/[^\d.-]/g, '');
        const num = Number(clean);
        return isNaN(num) ? inputString : num;
    },
    defaultStyle() {
        return { horizontalAlign: 'right' };
    }
};

export default currencyType;
