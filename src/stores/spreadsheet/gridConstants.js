/**
 * Grid UI constants — pixel values and thresholds specific to Grid.svelte
 * and its overlay/interaction system.
 */

// Viewport overlay positioning
export const OVERLAY_MARGIN_PX = 8;       // gap between overlay panels and viewport edge
export const OVERLAY_OFFSET_PX = 6;       // gap between anchor and floating panel
export const PANEL_MIN_WIDTH = 120;        // smallest overlay panel width before clamping
export const PANEL_MIN_HEIGHT = 60;        // smallest overlay panel height before clamping

// Fallback dimensions used when a panel element isn't yet in the DOM
export const FILTER_POPOVER_DEFAULT_WIDTH  = 244;
export const FILTER_POPOVER_DEFAULT_HEIGHT = 320;
export const EDIT_PANEL_DEFAULT_WIDTH  = 248;
export const EDIT_PANEL_DEFAULT_HEIGHT = 380;

// Repeater panel icon offset from row top
export const REPEATER_PANEL_ICON_OFFSET_PX = 20;

// Table row drag-handle hit zone (leftmost N px of the first column)
export const TABLE_GRIP_HANDLE_PX = 14;
