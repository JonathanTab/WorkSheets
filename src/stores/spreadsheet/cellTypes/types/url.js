/**
 * URL cell type descriptor
 */
export const urlType = {
    id: 'url',
    formatValue(rawValue) {
        return String(rawValue);
    },
    parseInput(inputString) {
        return inputString;
    },
    defaultStyle() {
        return { horizontalAlign: 'left', color: '#1a73e8', underline: true };
    }
};

export default urlType;
