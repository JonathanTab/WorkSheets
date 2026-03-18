/**
 * Dropdown cell type descriptor
 *
 * Presents a list of allowed values. The chosen value is stored as a plain
 * string/number. config shape:
 *   { type: 'dropdown', options: ['Option A', 'Option B', ...], allowCustom: false }
 *
 * Canvas rendering shows a ▾ indicator at the right edge of the cell.
 * Clicking/pressing Enter opens a DOM dropdown overlay (handled in Grid.svelte).
 */
export const dropdownType = {
    id: 'dropdown',
    formatValue(rawValue, _config) {
        if (rawValue === undefined || rawValue === null || rawValue === '') return '';
        return String(rawValue);
    },
    parseInput(inputString, config) {
        if (inputString === '' || inputString === null) return null;
        // If allowCustom is false, only accept values in the options list
        if (config?.allowCustom === false && Array.isArray(config?.options)) {
            const match = config.options.find(
                o => String(o).toLowerCase() === inputString.toLowerCase()
            );
            return match !== undefined ? match : inputString;
        }
        return inputString;
    },
    defaultStyle() {
        return { horizontalAlign: 'left' };
    }
};

export default dropdownType;
