/**
 * Rating cell type descriptor
 */
export const ratingType = {
    id: 'rating',
    formatValue(rawValue) {
        return ''; // Rendered via component
    },
    parseInput(inputString) {
        const val = parseInt(inputString, 10);
        return isNaN(val) ? 0 : val;
    },
    defaultStyle() {
        return { horizontalAlign: 'center' };
    },
    getDisplayComponent() {
        return { component: 'RatingCell' };
    },
    handlesClick: true
};

export default ratingType;
