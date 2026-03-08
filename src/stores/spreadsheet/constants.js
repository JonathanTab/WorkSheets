/**
 * Spreadsheet Constants
 *
 * Configuration values for the spreadsheet application.
 */

// Grid dimensions
export const ROW_HEIGHT = 24;
export const COL_WIDTH = 100;
export const HEADER_HEIGHT = 28;
export const HEADER_WIDTH = 50;
export const TOTAL_ROWS = 10000;
export const TOTAL_COLS = 100;

// Viewport buffer for virtualization
export const BUFFER_ROWS = 5;
export const BUFFER_COLS = 2;

// Overscan multipliers for virtualization (viewportPx * multiplier)
// Using pixel-based overscan adapts better to variable row/col sizes.
export const OVERSCAN_PX_ROWS = 1.0;
export const OVERSCAN_PX_COLS = 1.0;

// Back-compat aliases (deprecated)
export const OVERSCAN_ROWS = OVERSCAN_PX_ROWS;
export const OVERSCAN_COLS = OVERSCAN_PX_COLS;

// Schema version
export const SCHEMA_VERSION = '2';

// Default sheet dimensions
export const DEFAULT_ROW_COUNT = 1000;
export const DEFAULT_COL_COUNT = 26;

// Cell property keys (short names for storage efficiency)
// Note: Formulas are stored in VALUE ('v') field with '=' prefix
export const CELL_KEYS = {
    VALUE: 'v',
    TYPE: 't',
    PROTECTED: 'protected',
    // Formatting
    FONT_FAMILY: 'fontFamily',
    FONT_SIZE: 'fontSize',
    BOLD: 'bold',
    ITALIC: 'italic',
    UNDERLINE: 'underline',
    STRIKETHROUGH: 'strikethrough',
    COLOR: 'color',
    BACKGROUND_COLOR: 'backgroundColor',
    BORDER: 'border',
    HORIZONTAL_ALIGN: 'horizontalAlign',
    VERTICAL_ALIGN: 'verticalAlign',
    WRAP_TEXT: 'wrapText',
    NUMBER_FORMAT: 'numberFormat'
};

// Cell type hints
export const CELL_TYPES = {
    TEXT: 'text',
    NUMBER: 'number',
    DATE: 'date',
    BOOLEAN: 'boolean',
    ERROR: 'error'
};

// Horizontal alignment options
export const H_ALIGN = {
    LEFT: 'left',
    CENTER: 'center',
    RIGHT: 'right'
};

// Vertical alignment options
export const V_ALIGN = {
    TOP: 'top',
    MIDDLE: 'middle',
    BOTTOM: 'bottom'
};

// Metadata keys
export const META_KEYS = {
    DESCRIPTION: 'description',
    CREATED: 'created',
    CREATOR: 'creator',
    MODIFIED: 'modified',
    LAST_MODIFIED_BY: 'lastModifiedBy',
    LOCALE: 'locale',
    TIMEZONE: 'timezone',
    DEFAULT_CURRENCY: 'defaultCurrency'
};

// Row/Column meta keys
export const ROW_META_KEYS = {
    HEIGHT: 'height',
    HIDDEN: 'hidden'
};

export const COL_META_KEYS = {
    WIDTH: 'width',
    HIDDEN: 'hidden'
};
