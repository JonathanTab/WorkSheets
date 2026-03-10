/**
 * Checkbox cell type descriptor
 */
export const checkboxType = {
    id: 'checkbox',
    formatValue(rawValue) {
        return ''; // Rendered via component
    },
    parseInput(inputString) {
        if (typeof inputString === 'boolean') return inputString;
        if (inputString === 'true' || inputString === '1') return true;
        if (inputString === 'false' || inputString === '0') return false;
        return !!inputString;
    },
    defaultStyle() {
        return { horizontalAlign: 'center' };
    },
    getDisplayComponent() {
        return { component: 'CheckboxCell' };
    },
    handlesClick: true
};

export default checkboxType;
