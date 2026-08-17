/**
 * yjsOrigins.js — Named transaction origins for Yjs undo/history scoping.
 *
 * Pass one of these as the second arg to `ydoc.transact(fn, origin)` so the
 * UndoManager can be configured to track or ignore specific origin classes.
 *
 * Usage:
 *   import { YJS_ORIGIN } from './yjsOrigins.js';
 *   ydoc.transact(() => { ... }, YJS_ORIGIN.UI);
 *   ydoc.transact(() => { ... }, YJS_ORIGIN.MIGRATION);
 *
 * UndoManager setup (future):
 *   new Y.UndoManager(trackedTypes, { trackedOrigins: new Set([YJS_ORIGIN.UI]) })
 *   — this ensures only explicit user actions are undoable, never migrations.
 */

export const YJS_ORIGIN = Object.freeze({
    /** Explicit user action that should be undoable. */
    UI:        'ui',
    /** Schema migration — must never appear in undo history. */
    MIGRATION: 'migration',
    /** Snapshot restore — replaces entire doc state, not undoable. */
    RESTORE:   'restore',
    /** Remote sync applied by the Yjs CRDT — not undoable. */
    REMOTE:    'remote',
    /**
     * Write from the Node API / MCP server (script or AI agent), not a human
     * at the keyboard. Kept distinct from UI so agent edits are attributable in
     * history and can be filtered separately from a user's own undo stack.
     */
    API:       'api',
});
