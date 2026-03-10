/**
 * Number cell type descriptor
 */
export const numberType = {
    id: 'number',
    formatValue(rawValue, config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        const num = Number(rawValue);
        if (isNaN(num)) return String(rawValue);

        const decimals = config?.decimals ?? 2;
        const useGrouping = config?.thousandsSep ?? true;

        return new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
            useGrouping
        }).format(num);
    },
    parseInput(inputString) {
        if (inputString === '') return null;
        const num = Number(inputString.replace(/[^\d.-]/g, ''));
        return isNaN(num) ? inputString : num;
    },
    defaultStyle() {
        return { horizontalAlign: 'right' };
    }
};

export default numberType;
