/**
 * viewPlacementStore — singleton reactive state for grid placement mode.
 *
 * When active, Grid.svelte renders a ViewPlacementOverlay that lets the user
 * click anywhere on the grid to choose (row, col) for a new or moved view.
 *
 * Usage:
 *   viewPlacementStore.activate('Finance View', (row, col) => {
 *       session.createTableViewOnSheet({ ..., startRow: row, startCol: col });
 *   });
 */

export class ViewPlacementStore {
    /** Whether placement mode is currently active */
    active = $state(false);

    /** Human-readable name shown in the overlay banner */
    viewName = $state('');

    /** @type {((row: number, col: number) => void) | null} */
    #onPlace = null;

    /** @type {(() => void) | null} */
    #onCancel = null;

    /**
     * Enter placement mode.
     * @param {string} viewName
     * @param {(row: number, col: number) => void} onPlace  Called when user confirms position.
     * @param {(() => void) | null} [onCancel]  Called when user presses ESC.
     */
    activate(viewName, onPlace, onCancel = null) {
        this.viewName = viewName;
        this.#onPlace  = onPlace;
        this.#onCancel = onCancel;
        this.active    = true;
    }

    /** Called by the overlay when the user confirms a position. */
    place(row, col) {
        this.#onPlace?.(row, col);
        this.#reset();
    }

    /** Called by the overlay when the user cancels (ESC or Cancel button). */
    cancel() {
        this.#onCancel?.();
        this.#reset();
    }

    #reset() {
        this.active    = false;
        this.viewName  = '';
        this.#onPlace  = null;
        this.#onCancel = null;
    }
}

export const viewPlacementStore = new ViewPlacementStore();
