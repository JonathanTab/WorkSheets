/**
 * ClipboardManager — thin orchestrator over the clipboard/ module.
 *
 * Responsibilities kept here (everything else is delegated):
 *   - hold the in-memory model + reactive cut marquee state
 *   - own the browser entry points (keyboard copy/cut event, paste event,
 *     context-menu copy/cut/paste) and route them through ONE encode/decode path
 *   - implement deferred (marching-ants) cut: mark the source on cut, clear it on
 *     the paste that consumes it
 *
 * Architecture (see clipboard/):
 *   extract  → model → codecs ⇄ transport (encode/decode) → apply
 *
 * COPY/CUT
 *   Keyboard: copy()/cut() run on keydown WITHOUT preventDefault, stash the
 *   encoded formats, and fire an async write. The browser then dispatches a native
 *   `copy` event → handleNativeCopyEvent() writes the formats via DataTransfer
 *   (the only way to set custom MIME on Firefox/Safari) and preventDefaults.
 *   Context-menu: copy()/cut() run alone; the async write is the primary path.
 *
 * PASTE
 *   Keyboard: keydown sets _pendingPasteMode (no preventDefault) → native `paste`
 *   event → pasteFromEvent() reads the full DataTransfer (incl. Google compact).
 *   Context-menu: paste() reads navigator.clipboard.read() — which exposes the
 *   same MIME set, so fidelity is identical to the keyboard path.
 *
 * In-memory model is a fast-path only: the full model always rides on the system
 * clipboard as a custom MIME, so paste works at full fidelity across tabs/windows.
 */

import { YJS_ORIGIN } from './yjsOrigins.js';
import { adjustByOffset } from '../../formulas/refs.js';
import { makeModel, generateFingerprint } from './clipboard/model.js';
import { extractRegion } from './clipboard/extract.js';
import { applyModel, clearSourceRange } from './clipboard/apply.js';
import {
    encodeModel, decodeBag, bagMatchesFingerprint,
    writeToSystem, readBagFromSystem,
    writeToDataTransfer, readBagFromDataTransfer,
} from './clipboard/transport/index.js';

// ─── Selection state injection (avoids circular dependency) ────────────────────

let _selectionState = null;
export function setSelectionState(state) { _selectionState = state; }
function getSelectionState() { return _selectionState; }

// ─── ClipboardManager ──────────────────────────────────────────────────────────

class ClipboardManager {
    constructor() {
        /** Last copied/cut model — in-memory fast-path. @type {object|null} */
        this.model = $state(null);
        /** @type {'copy'|'cut'|null} */
        this.mode = $state(null);
        /**
         * Reactive marching-ants source for a pending cut. Read by the selection
         * renderer. @type {{ sheetId:string|null, fingerprint:string, ranges:Array }|null}
         */
        this.cutMarquee = $state(null);

        /** Set by Grid keydown 'v'; consumed by the native paste event handler. */
        this._pendingPasteMode = null;
        /** Set by copy()/cut(); consumed by handleNativeCopyEvent(). */
        this._pendingCopyPayload = null;
    }

    // ─── Copy / Cut ─────────────────────────────────────────────────────────────

    copy(sheetStore, session) {
        const model = this.#buildModelFromSelection(sheetStore, session);
        if (!model) return;
        this.model = model;
        this.mode = 'copy';
        this.cancelCut(); // a fresh copy supersedes any pending cut
        this.#publish(model);
    }

    cut(sheetStore, session) {
        const model = this.#buildModelFromSelection(sheetStore, session);
        if (!model) return;
        this.model = model;
        this.mode = 'cut';
        // Deferred: mark the source with a marquee; the sheet is mutated only when
        // a paste consumes this cut (Excel/Sheets semantics).
        this.cutMarquee = {
            sheetId: session?.activeSheetId ?? null,
            fingerprint: model.fingerprint,
            ranges: model.regions.map(r => ({ ...r.range })),
        };
        this.#publish(model);
    }

    /** Build a model from the current selection's range(s), or null. */
    #buildModelFromSelection(sheetStore, session) {
        const allRanges = getSelectionState()?.allRanges ?? [];
        if (allRanges.length === 0 || !sheetStore) return null;
        const fingerprint = generateFingerprint();
        const regions = allRanges.map(range => extractRegion(sheetStore, session, range));
        const origin = { row: regions[0].range.startRow, col: regions[0].range.startCol };
        return makeModel({ source: 'scriptorium', fingerprint, origin, regions });
    }

    /** Encode + write to the system clipboard (async), stashing formats for the
     *  native copy event handler. */
    #publish(model) {
        const formats = encodeModel(model);
        this._pendingCopyPayload = formats;
        writeToSystem(formats).catch(() => {});
    }

    /**
     * svelte:window oncopy/oncut handler. Writes our formats synchronously via
     * DataTransfer (covers custom MIME on Firefox/Safari) and suppresses the
     * browser's own copy. No-op when the copy did not originate from us.
     * @param {ClipboardEvent} e
     */
    handleNativeCopyEvent(e) {
        const formats = this._pendingCopyPayload;
        if (!formats) return;
        this._pendingCopyPayload = null;
        e.preventDefault();
        writeToDataTransfer(e, formats);
    }

    // ─── Paste ──────────────────────────────────────────────────────────────────

    /**
     * Native paste event (keyboard Ctrl+V). Full DataTransfer access.
     * @param {DataTransfer} clipboardData
     */
    pasteFromEvent(clipboardData, sheetStore, session, ydoc, mode = 'full') {
        const range = this.#pasteTarget();
        if (!range || !sheetStore) return;
        const resolved = this.#resolveModel(readBagFromDataTransfer(clipboardData));
        if (!resolved) { console.warn('[ClipboardManager] no parseable clipboard content'); return; }
        this.#applyResolved(resolved, sheetStore, session, ydoc, range, mode);
    }

    /**
     * Context-menu paste — async system clipboard read. Same decode chain and
     * fidelity as the keyboard path.
     */
    async paste(sheetStore, session, ydoc, mode = 'full') {
        const range = this.#pasteTarget();
        if (!range || !sheetStore) return;
        const resolved = this.#resolveModel(await readBagFromSystem());
        if (!resolved) { console.warn('[ClipboardManager] no clipboard content available'); return; }
        this.#applyResolved(resolved, sheetStore, session, ydoc, range, mode);
    }

    /**
     * Resolve a MIME bag (or null when the clipboard is unreadable) into a model.
     * Prefers the in-memory model when it still matches what's on the clipboard
     * (recovers full fidelity when only our fingerprinted HTML survived), or when
     * the clipboard can't be read at all (same-tab copy, permission denied).
     */
    #resolveModel(bag) {
        if (this.model?.fingerprint) {
            // Unreadable clipboard, or a rich read that fell back to plain text:
            // we can't confirm an external override, so trust our in-memory model.
            if (bag === null || bag.degraded) return { model: this.model, isInternal: true };
            if (bagMatchesFingerprint(bag, this.model.fingerprint)) return { model: this.model, isInternal: true };
        }
        if (!bag) return null;
        return decodeBag(bag);
    }

    #applyResolved({ model, isInternal }, sheetStore, session, ydoc, range, mode) {
        const ctx = { sheetStore, session };
        const consumesCut = isInternal
            && this.cutMarquee
            && model.fingerprint === this.cutMarquee.fingerprint
            && this.cutMarquee.sheetId === (session?.activeSheetId ?? null);

        ydoc?.transact(() => {
            // Clear the cut source FIRST so an overlapping cut→paste is safe (the
            // model is already fully captured in memory, so source data isn't lost).
            if (consumesCut) for (const r of this.cutMarquee.ranges) clearSourceRange(ctx, r);
            applyModel(ctx, model, range, mode, isInternal);
        }, YJS_ORIGIN.UI);

        if (consumesCut) {
            this.cutMarquee = null;
            this.model = null;
            this.mode = null;
        }
    }

    #pasteTarget() {
        const sel = getSelectionState();
        const anchor = sel?.anchor;
        return sel?.range
            ?? (anchor ? { startRow: anchor.row, endRow: anchor.row, startCol: anchor.col, endCol: anchor.col } : null);
    }

    // ─── Cut marquee lifecycle ──────────────────────────────────────────────────

    /**
     * Cancel a pending cut (Esc, an edit, or a sheet switch). The clipboard
     * contents remain, so the data can still be pasted — it just behaves as a copy
     * (the source is no longer cleared).
     */
    cancelCut() {
        if (this.cutMarquee) this.cutMarquee = null;
        if (this.mode === 'cut') this.mode = 'copy';
    }

    // ─── Misc / compat ──────────────────────────────────────────────────────────

    /** Used by GridFillHandle for autofill formula adjustment. */
    adjustFormula(formula, rowOffset, colOffset) { return adjustByOffset(formula, rowOffset, colOffset); }

    hasClipboard() { return this.model !== null; }
    canPaste() { return true; }
}

export const clipboardManager = new ClipboardManager();
