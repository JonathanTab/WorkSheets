/**
 * yjsOrigins.js — Named transaction origins for the docs sub-app.
 *
 * Pass one of these as the second arg to `ydoc.transact(fn, origin)` so undo /
 * history scoping can track or ignore specific origin classes. Migrations must
 * always use MIGRATION so they never land in the user's undo stack.
 *
 * NOTE: y-prosemirror's yUndoPlugin manages the docs undo stack and tracks
 * its own origin internally; these origins are for the lifecycle/migration
 * writes that happen outside the editor.
 */

export const DOCS_YJS_ORIGIN = Object.freeze({
    /** Explicit local action (metadata edits, page setup) — not editor content. */
    LOCAL:     'docs:local',
    /** Schema migration — must never appear in undo history. */
    MIGRATION: 'docs:migration',
    /** Snapshot restore — replaces entire doc state, not undoable. */
    RESTORE:   'docs:restore',
});
