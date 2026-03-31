<script>
    /**
     * DocPageSetupPanel — Page setup dialog for document editor.
     * Manages paper size, orientation, and margins for the document.
     */
    import { docSession } from "../../stores/docs/docStore.svelte.js";

    let { onclose } = $props();

    // ── Paper sizes ────────────────────────────────────────────────────────────
    const PAPER_SIZES = [
        { key: "letter", label: "Letter (8.5×11 in)" },
        { key: "legal", label: "Legal (8.5×14 in)" },
        { key: "A4", label: "A4 (210×297 mm)" },
        { key: "A3", label: "A3 (297×420 mm)" },
        { key: "A5", label: "A5 (148×210 mm)" },
    ];

    const PAPER_DIMS = {
        letter: { w: 215.9, h: 279.4 },
        legal: { w: 215.9, h: 355.6 },
        A4: { w: 210, h: 297 },
        A3: { w: 297, h: 420 },
        A5: { w: 148, h: 210 },
    };

    // Margin presets (mm)
    const MARGIN_PRESETS = {
        normal: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
        wide: { top: 50.8, bottom: 50.8, left: 50.8, right: 50.8 },
        narrow: { top: 12.7, bottom: 12.7, left: 12.7, right: 12.7 },
    };

    // ── Read current settings from docSession ──────────────────────────────────
    function readSettings() {
        return docSession.getPageSetup() ?? {};
    }

    let saved = readSettings();

    // Local reactive state
    let paperSize = $state(saved.paperSize ?? "letter");
    let orientation = $state(saved.orientation ?? "portrait");
    let marginTop = $state(saved.marginTop ?? 25.4);
    let marginBottom = $state(saved.marginBottom ?? 25.4);
    let marginLeft = $state(saved.marginLeft ?? 25.4);
    let marginRight = $state(saved.marginRight ?? 25.4);

    // ── Derived page info ──────────────────────────────────────────────────────
    let pageInfo = $derived.by(() => {
        const dims = PAPER_DIMS[paperSize] ?? PAPER_DIMS.letter;
        const pw = orientation === "landscape" ? dims.h : dims.w;
        const ph = orientation === "landscape" ? dims.w : dims.h;
        const printW = pw - marginLeft - marginRight;
        const printH = ph - marginTop - marginBottom;
        return {
            pageW: pw,
            pageH: ph,
            printW: Math.max(1, printW),
            printH: Math.max(1, printH),
        };
    });

    // Preview canvas dimensions (for the paper preview widget)
    let previewDims = $derived.by(() => {
        const MAX_W = 160,
            MAX_H = 200;
        const { pageW, pageH } = pageInfo;
        const ratio = pageW / pageH;
        let w = MAX_W,
            h = MAX_W / ratio;
        if (h > MAX_H) {
            h = MAX_H;
            w = MAX_H * ratio;
        }
        const scale_px = w / pageW;
        return {
            w: Math.round(w),
            h: Math.round(h),
            marginTopPx: Math.round(marginTop * scale_px),
            marginBottomPx: Math.round(marginBottom * scale_px),
            marginLeftPx: Math.round(marginLeft * scale_px),
            marginRightPx: Math.round(marginRight * scale_px),
        };
    });

    // ── Helpers ────────────────────────────────────────────────────────────────
    function currentSettings() {
        return {
            paperSize,
            orientation,
            marginTop,
            marginBottom,
            marginLeft,
            marginRight,
        };
    }

    // ── Actions ────────────────────────────────────────────────────────────────
    function applyMarginPreset(preset) {
        const p = MARGIN_PRESETS[preset];
        marginTop = p.top;
        marginBottom = p.bottom;
        marginLeft = p.left;
        marginRight = p.right;
    }

    function saveSettings() {
        docSession.setPageSetup(currentSettings());
    }

    function handleClose() {
        saveSettings();
        onclose?.();
    }

    function handleCancel() {
        onclose?.();
    }

    function clampMargin(v) {
        const n = parseFloat(v);
        if (isNaN(n)) return 0;
        return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
    }
</script>

<!-- Modal backdrop -->
<div class="backdrop" role="dialog" aria-modal="true" aria-label="Page Setup">
    <div class="panel">
        <!-- Header -->
        <div class="panel-header">
            <h2 class="panel-title">Page Setup</h2>
            <button class="close-btn" onclick={handleCancel} title="Close"
                >✕</button
            >
        </div>

        <div class="panel-body">
            <!-- Left column: settings -->
            <div class="settings-col">
                <!-- Paper & Orientation -->
                <section class="section">
                    <div class="section-label">Paper</div>
                    <select class="select" bind:value={paperSize}>
                        {#each PAPER_SIZES as ps}
                            <option value={ps.key}>{ps.label}</option>
                        {/each}
                    </select>
                    <div class="orientation-row">
                        <label class="radio-label">
                            <input
                                type="radio"
                                name="orientation"
                                value="portrait"
                                bind:group={orientation}
                            />
                            <span class="orient-icon">⬜</span> Portrait
                        </label>
                        <label class="radio-label">
                            <input
                                type="radio"
                                name="orientation"
                                value="landscape"
                                bind:group={orientation}
                            />
                            <span class="orient-icon orient-icon--land">⬜</span
                            > Landscape
                        </label>
                    </div>
                </section>

                <!-- Margins -->
                <section class="section">
                    <div class="section-label-row">
                        <span class="section-label">Margins (mm)</span>
                        <div class="preset-btns">
                            <button
                                class="preset-btn"
                                onclick={() => applyMarginPreset("normal")}
                                >Normal</button
                            >
                            <button
                                class="preset-btn"
                                onclick={() => applyMarginPreset("wide")}
                                >Wide</button
                            >
                            <button
                                class="preset-btn"
                                onclick={() => applyMarginPreset("narrow")}
                                >Narrow</button
                            >
                        </div>
                    </div>
                    <div class="margins-grid">
                        <label class="margin-label">
                            Top
                            <input
                                type="number"
                                class="margin-input"
                                min="0"
                                max="100"
                                step="1"
                                bind:value={marginTop}
                                onchange={() =>
                                    (marginTop = clampMargin(marginTop))}
                            />
                        </label>
                        <label class="margin-label">
                            Bottom
                            <input
                                type="number"
                                class="margin-input"
                                min="0"
                                max="100"
                                step="1"
                                bind:value={marginBottom}
                                onchange={() =>
                                    (marginBottom = clampMargin(marginBottom))}
                            />
                        </label>
                        <label class="margin-label">
                            Left
                            <input
                                type="number"
                                class="margin-input"
                                min="0"
                                max="100"
                                step="1"
                                bind:value={marginLeft}
                                onchange={() =>
                                    (marginLeft = clampMargin(marginLeft))}
                            />
                        </label>
                        <label class="margin-label">
                            Right
                            <input
                                type="number"
                                class="margin-input"
                                min="0"
                                max="100"
                                step="1"
                                bind:value={marginRight}
                                onchange={() =>
                                    (marginRight = clampMargin(marginRight))}
                            />
                        </label>
                    </div>
                </section>

                <!-- Page info -->
                <section class="section info-section">
                    <div class="info-row">
                        <span class="info-icon">📄</span>
                        <span class="info-text">
                            {orientation === "portrait"
                                ? "Portrait"
                                : "Landscape"}
                        </span>
                    </div>
                    <div class="info-row">
                        <span class="info-text muted">
                            Printable area: {pageInfo.printW.toFixed(
                                0,
                            )}×{pageInfo.printH.toFixed(0)} mm
                        </span>
                    </div>
                </section>
            </div>

            <!-- Right column: paper preview -->
            <div class="preview-col">
                <div class="preview-label">Preview</div>
                <div
                    class="paper-preview"
                    style="width:{previewDims.w}px; height:{previewDims.h}px;"
                >
                    <div
                        class="print-area"
                        style="
                            top:{previewDims.marginTopPx}px;
                            bottom:{previewDims.marginBottomPx}px;
                            left:{previewDims.marginLeftPx}px;
                            right:{previewDims.marginRightPx}px;
                        "
                    ></div>

                    <div class="margin-label-top">{marginTop}</div>
                    <div class="margin-label-bottom">{marginBottom}</div>
                    <div class="margin-label-left">{marginLeft}</div>
                    <div class="margin-label-right">{marginRight}</div>
                </div>
            </div>
        </div>

        <!-- Footer actions -->
        <div class="panel-footer">
            <button class="btn btn-secondary" onclick={handleCancel}
                >Cancel</button
            >
            <button class="btn btn-primary" onclick={handleClose}>Apply</button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }

    .panel {
        background: var(--color-surface, #fff);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 10px;
        box-shadow: 0 8px 40px rgba(0, 0, 0, 0.22);
        width: 520px;
        max-width: 96vw;
        max-height: 92vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .panel-title {
        font-size: 1rem;
        font-weight: 600;
        margin: 0;
        color: var(--color-text, #1e293b);
    }

    .close-btn {
        background: none;
        border: none;
        cursor: pointer;
        font-size: 1rem;
        color: var(--color-text-secondary, #64748b);
        padding: 2px 6px;
        border-radius: 4px;
        line-height: 1;
    }
    .close-btn:hover {
        background: var(--color-fill, #f1f5f9);
    }

    .panel-body {
        display: flex;
        gap: 24px;
        padding: 18px;
        overflow-y: auto;
        flex: 1;
        min-height: 0;
    }

    .settings-col {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 14px;
        min-width: 0;
    }

    .preview-col {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
    }

    .preview-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .section {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    .section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--color-text-secondary, #64748b);
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }

    .section-label-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
    }

    .preset-btns {
        display: flex;
        gap: 4px;
    }

    .preset-btn {
        height: 20px;
        padding: 0 7px;
        border-radius: 4px;
        font-size: 0.7rem;
        font-weight: 500;
        border: 1px solid var(--color-border, #e2e8f0);
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
        cursor: pointer;
        white-space: nowrap;
    }
    .preset-btn:hover {
        background: var(--color-fill-2, #e2e8f0);
    }

    .select {
        height: 28px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 5px;
        background: var(--color-surface, #fff);
        color: var(--color-text, #1e293b);
        font-size: 0.8125rem;
        padding: 0 6px;
        cursor: pointer;
    }
    .select:focus {
        outline: 2px solid var(--color-primary, #3b82f6);
        outline-offset: 1px;
    }

    .orientation-row {
        display: flex;
        gap: 16px;
    }

    .radio-label {
        display: flex;
        align-items: center;
        gap: 5px;
        font-size: 0.8125rem;
        cursor: pointer;
        color: var(--color-text, #1e293b);
    }

    .orient-icon {
        font-size: 1.1rem;
        line-height: 1;
    }
    .orient-icon--land {
        display: inline-block;
        transform: rotate(90deg);
    }

    .margins-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px 12px;
    }

    .margin-label {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
        gap: 6px;
    }

    .margin-input {
        width: 60px;
        height: 24px;
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 4px;
        padding: 0 5px;
        font-size: 0.8125rem;
        text-align: right;
        color: var(--color-text, #1e293b);
        background: var(--color-surface, #fff);
    }
    .margin-input:focus {
        outline: 2px solid var(--color-primary, #3b82f6);
        outline-offset: 1px;
    }

    .info-section {
        background: var(--color-fill, #f8fafc);
        border: 1px solid var(--color-border, #e2e8f0);
        border-radius: 6px;
        padding: 8px 10px;
        gap: 4px;
    }

    .info-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .info-icon {
        font-size: 0.875rem;
    }

    .info-text {
        font-size: 0.8125rem;
        color: var(--color-text, #1e293b);
    }
    .info-text.muted {
        color: var(--color-text-secondary, #64748b);
    }

    /* Paper preview widget */
    .paper-preview {
        position: relative;
        background: #fff;
        border: 1px solid #cbd5e1;
        box-shadow: 2px 3px 10px rgba(0, 0, 0, 0.12);
        flex-shrink: 0;
    }

    .print-area {
        position: absolute;
        border: 1px dashed #94a3b8;
        background: #f8fafc;
        overflow: hidden;
    }

    .margin-label-top,
    .margin-label-bottom,
    .margin-label-left,
    .margin-label-right {
        position: absolute;
        font-size: 8px;
        color: #94a3b8;
        pointer-events: none;
    }
    .margin-label-top {
        top: 2px;
        left: 50%;
        transform: translateX(-50%);
    }
    .margin-label-bottom {
        bottom: 2px;
        left: 50%;
        transform: translateX(-50%);
    }
    .margin-label-left {
        left: 2px;
        top: 50%;
        transform: translateY(-50%) rotate(-90deg);
        transform-origin: center;
    }
    .margin-label-right {
        right: 2px;
        top: 50%;
        transform: translateY(-50%) rotate(90deg);
        transform-origin: center;
    }

    /* Footer */
    .panel-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--color-border, #e2e8f0);
        flex-shrink: 0;
    }

    .btn {
        height: 30px;
        padding: 0 14px;
        border-radius: 5px;
        font-size: 0.8125rem;
        font-weight: 500;
        border: 1px solid transparent;
        cursor: pointer;
        transition: all 0.08s ease;
    }

    .btn-secondary {
        background: var(--color-fill, #f1f5f9);
        color: var(--color-text, #1e293b);
        border-color: var(--color-border, #e2e8f0);
    }
    .btn-secondary:hover {
        background: var(--color-fill-2, #e2e8f0);
    }

    .btn-primary {
        background: var(--color-primary, #3b82f6);
        color: #fff;
    }
    .btn-primary:hover:not(:disabled) {
        background: var(--color-primary-dark, #2563eb);
    }
</style>
