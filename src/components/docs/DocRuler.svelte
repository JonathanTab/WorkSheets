<script>
    /**
     * DocRuler — horizontal ruler aligned with the document page.
     * Shows margins (shaded), text area (white), inch marks, and indent markers.
     */
    let {
        zoom = 100,         // percent
        viewMode = 'paginated',
        pageWidthPx = 816,  // Letter at 96dpi
        leftMarginPx = 96,  // 1 inch
        rightMarginPx = 96,
        indentLeft = 0,     // extra paragraph left indent in px (from text start)
        indentRight = 0,
        hangingIndent = 0,
    } = $props();

    let canvas = $state(null);
    let containerWidth = $state(0);

    // Scale factor
    let scale = $derived(zoom / 100);

    // Draw the ruler on the canvas whenever inputs change
    $effect(() => {
        if (!canvas) return;
        drawRuler(canvas, {
            pageWidthPx, leftMarginPx, rightMarginPx,
            indentLeft, indentRight, hangingIndent,
            containerWidth, scale,
        });
    });

    function drawRuler(c, opts) {
        const { pageWidthPx, leftMarginPx, rightMarginPx, scale, containerWidth } = opts;
        const dpr = window.devicePixelRatio || 1;
        const H = 22; // logical height

        // The page is centered inside the editor container. We need to compute
        // how many px from the ruler's left edge the page starts.
        const scaledPageW = pageWidthPx * scale;
        const pageOffsetX = Math.max(0, (containerWidth - scaledPageW) / 2);

        const totalW = containerWidth || scaledPageW;

        c.width  = Math.round(totalW * dpr);
        c.height = Math.round(H * dpr);
        c.style.width  = totalW + 'px';
        c.style.height = H + 'px';

        const ctx = c.getContext('2d');
        ctx.scale(dpr, dpr);
        ctx.clearRect(0, 0, totalW, H);

        // Fill margin zones (gray-blue tint)
        const marginColor = '#dde3ec';
        const textAreaColor = '#f8f9fb';
        const borderColor = '#c0c8d4';

        // Left side (before page)
        if (pageOffsetX > 0) {
            ctx.fillStyle = marginColor;
            ctx.fillRect(0, 0, pageOffsetX, H);
        }

        // Page background
        ctx.fillStyle = textAreaColor;
        ctx.fillRect(pageOffsetX, 0, scaledPageW, H);

        // Left margin zone
        const scaledLeftM = leftMarginPx * scale;
        const scaledRightM = rightMarginPx * scale;
        const textStart = pageOffsetX + scaledLeftM;
        const textEnd   = pageOffsetX + scaledPageW - scaledRightM;

        ctx.fillStyle = marginColor;
        ctx.fillRect(pageOffsetX, 0, scaledLeftM, H);
        ctx.fillRect(textEnd, 0, scaledRightM, H);

        // Right side (after page)
        const afterPage = pageOffsetX + scaledPageW;
        if (afterPage < totalW) {
            ctx.fillStyle = marginColor;
            ctx.fillRect(afterPage, 0, totalW - afterPage, H);
        }

        // Bottom border
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, H - 0.5);
        ctx.lineTo(totalW, H - 0.5);
        ctx.stroke();

        // Tick marks — one inch = 96px at 100% zoom
        const inch = 96 * scale;
        const textWidthInches = (pageWidthPx - leftMarginPx - rightMarginPx) / 96;

        ctx.fillStyle = '#4a5568';
        ctx.font = `10px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // Draw ticks from left page edge
        const startX = pageOffsetX;
        const endX   = pageOffsetX + scaledPageW;

        for (let px = 0; px <= pageWidthPx * scale; px += inch / 8) {
            const x = startX + px;
            if (x < 0 || x > totalW) continue;

            const eighth = Math.round(px / (inch / 8));
            const isMajor   = eighth % 8 === 0;
            const isHalf    = eighth % 4 === 0;
            const isQuarter = eighth % 2 === 0;

            // Only draw ticks within the ruler area
            let tickH;
            if (isMajor) tickH = 10;
            else if (isHalf) tickH = 7;
            else if (isQuarter) tickH = 5;
            else tickH = 3;

            ctx.strokeStyle = '#8898aa';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, H - 1);
            ctx.lineTo(x, H - 1 - tickH);
            ctx.stroke();

            // Labels for inch marks (relative to text start = 0)
            if (isMajor && inch > 30) {
                const inchNum = Math.round(px / inch);
                // Convert to position relative to text start
                const relInch = Math.round((px - leftMarginPx * scale) / inch);
                const label   = relInch === 0 ? '' : String(Math.abs(relInch));
                if (label) {
                    ctx.fillStyle = '#718096';
                    ctx.fillText(label, x, 2);
                }
            }
        }

        // Margin boundary lines
        ctx.strokeStyle = '#7b9cc4';
        ctx.lineWidth = 1;
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(textStart, 0);
        ctx.lineTo(textStart, H);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(textEnd, 0);
        ctx.lineTo(textEnd, H);
        ctx.stroke();

        // First-line / hanging indent triangle handles (simplified)
        // Left indent marker at textStart + indentLeft * scale
        const indL = textStart + opts.indentLeft * scale;
        drawTriangle(ctx, indL, H - 5, 7, '#4a90d9', true);

        // Right indent marker
        const indR = textEnd - opts.indentRight * scale;
        drawTriangle(ctx, indR, H - 5, 7, '#4a90d9', false);
    }

    function drawTriangle(ctx, x, y, size, color, pointLeft) {
        ctx.fillStyle = color;
        ctx.beginPath();
        if (pointLeft) {
            ctx.moveTo(x, y);
            ctx.lineTo(x + size, y - size / 2);
            ctx.lineTo(x + size, y + size / 2);
        } else {
            ctx.moveTo(x, y);
            ctx.lineTo(x - size, y - size / 2);
            ctx.lineTo(x - size, y + size / 2);
        }
        ctx.closePath();
        ctx.fill();
    }
</script>

<div class="ruler-wrap" bind:clientWidth={containerWidth}>
    <canvas bind:this={canvas}></canvas>
</div>

<style>
    .ruler-wrap {
        width: 100%;
        height: 22px;
        overflow: hidden;
        flex-shrink: 0;
        background: #dde3ec;
        border-bottom: 1px solid #c0c8d4;
        user-select: none;
        cursor: default;
    }

    canvas {
        display: block;
    }
</style>
