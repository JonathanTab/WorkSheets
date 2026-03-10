/**
 * Date cell type descriptor
 */
export const dateType = {
    id: 'date',
    formatValue(rawValue, config) {
        if (!rawValue) return '';
        const date = new Date(rawValue);
        if (isNaN(date.getTime())) return String(rawValue);

        const format = config?.format || 'MM/DD/YYYY';
        // Simple formatter for demo purposes
        const mm = String(date.getMonth() + 1).padStart(2, '0');
        const dd = String(date.getDate()).padStart(2, '0');
        const yyyy = date.getFullYear();

        return format.replace('MM', mm).replace('DD', dd).replace('YYYY', yyyy);
    },
    parseInput(inputString) {
        if (!inputString) return null;
        const date = new Date(inputString);
        return isNaN(date.getTime()) ? inputString : date.toISOString();
    },
    defaultStyle() {
        return { horizontalAlign: 'left' };
    },
    getEditorComponent() {
        return { component: 'date-picker' };
    }
};

export default dateType;
