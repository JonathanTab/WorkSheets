/**
 * ClipboardManager - Handles copy/cut/paste operations for spreadsheet
 *
 * Supports multiple clipboard formats:
 * - Internal format (full fidelity for within plainTab)
 * - TSV format (basic interoperability)
 * - HTML table format (for external apps like Google Sheets/Excel)
 *
 * Paste modes:
 * - Full paste: values + formulas + formatting + borders
 * - Values only: just computed values
 * - Formulas only: formulas (adjusted for relative position)
 * - Formatting only: just styling
 * - Values & Formatting
 * - Formulas & Formatting
 */

// selectionState will be injected from index.js to avoid circular dependency
let _selectionState = null;

/**
 * Set the selection state instance (called from index.js)
 * @param {import('./SelectionState.svelte.js').SelectionState} state
 */
export function setSelectionState(state) {
    _selectionState = state;
}

/**
 * Get the selection state instance
 */
function getSelectionState() {
    return _selectionState;
}

// Custom MIME type for internal clipboard
const PLAINTAB_MIME = 'application/x-plaintab-clipboard+json';

// Create a reactive clipboard state
class ClipboardManager {
    constructor() {
        // Internal clipboard state for operations within the app
        this.clipboardData = $state(null);
        this.clipboardType = $state(null); // 'cut' | 'copy'
    }

    /**
     * Copy the current selection to clipboard
     * @param {Object} sheetStore - The active sheet store
     * @param {Object} session - The spreadsheet session for formula display values
     */
    async copy(sheetStore, session) {
        const selectionState = getSelectionState();
        const range = selectionState?.range;
        if (!range || !sheetStore) return;

        const data = this.extractRangeData(sheetStore, session, range);

        // Store internally
        this.clipboardData = {
            type: 'copy',
            range: { ...range },
            data: data,
        };
        this.clipboardType = 'copy';

        // Write to system clipboard
        await this.writeToSystemClipboard(data, range);
    }

    /**
     * Cut the current selection - copy and clear content only
     * @param {Object} sheetStore - The active sheet store
     * @param {Object} session - The spreadsheet session
     * @param {Object} ydoc - Yjs document for transactions
     */
    async cut(sheetStore, session, ydoc) {
        const selectionState = getSelectionState();
        const range = selectionState?.range;
        if (!range || !sheetStore) return;

        const data = this.extractRangeData(sheetStore, session, range);

        // Store internally
        this.clipboardData = {
            type: 'cut',
            range: { ...range },
            data: data,
        };
        this.clipboardType = 'cut';

        // Write to system clipboard
        await this.writeToSystemClipboard(data, range);

        // Clear only content from source (keep formatting)
        ydoc?.transact(() => {
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    sheetStore.clearCellValue(r, c);
                }
            }
        });
    }

    /**
     * Extract cell data from a range
     * @param {Object} sheetStore - The sheet store
     * @param {Object} session - Spreadsheet session
     * @param {Object} range - Selection range
     * @returns {Object} Extracted data
     */
    extractRangeData(sheetStore, session, range) {
        const cells = [];
        const borders = [];
        const { startRow, endRow, startCol, endCol } = range;

        // Extract cell data
        for (let r = startRow; r <= endRow; r++) {
            const rowData = [];
            for (let c = startCol; c <= endCol; c++) {
                const cell = sheetStore.getCell(r, c);
                const cellData = {
                    // Raw value (what user entered)
                    v: cell.exists ? cell.v : null,
                    // Whether this is a formula
                    isFormula: cell.exists && cell.v && String(cell.v).startsWith('='),
                    // Computed display value
                    displayValue: cell.exists ? session.getCellDisplayValue(r, c) : null,
                    // Formatting properties
                    fontFamily: cell.fontFamily || null,
                    fontSize: cell.fontSize || null,
                    bold: cell.bold || false,
                    italic: cell.italic || false,
                    underline: cell.underline || false,
                    strikethrough: cell.strikethrough || false,
                    color: cell.color || null,
                    backgroundColor: cell.backgroundColor || null,
                    horizontalAlign: cell.horizontalAlign || null,
                };
                rowData.push(cellData);
            }
            cells.push(rowData);
        }

        // Extract borders (edge-based, relative to range)
        for (let r = startRow; r <= endRow; r++) {
            for (let c = startCol; c <= endCol; c++) {
                const cellBorders = sheetStore.getCellBorders(r, c);

                // Top edge (only for first row or if different from cell above)
                if (r === startRow || !this.bordersEqual(cellBorders.top, sheetStore.getCellBorders(r - 1, c).bottom)) {
                    if (cellBorders.top) {
                        borders.push({
                            relRow: r - startRow,
                            relCol: c - startCol,
                            edge: 'top',
                            style: cellBorders.top.style,
                            width: cellBorders.top.width,
                            color: cellBorders.top.color,
                        });
                    }
                }

                // Bottom edge (always include for last row)
                if (r === endRow) {
                    if (cellBorders.bottom) {
                        borders.push({
                            relRow: r - startRow,
                            relCol: c - startCol,
                            edge: 'bottom',
                            style: cellBorders.bottom.style,
                            width: cellBorders.bottom.width,
                            color: cellBorders.bottom.color,
                        });
                    }
                }

                // Left edge (only for first col or if different from cell to left)
                if (c === startCol || !this.bordersEqual(cellBorders.left, sheetStore.getCellBorders(r, c - 1).right)) {
                    if (cellBorders.left) {
                        borders.push({
                            relRow: r - startRow,
                            relCol: c - startCol,
                            edge: 'left',
                            style: cellBorders.left.style,
                            width: cellBorders.left.width,
                            color: cellBorders.left.color,
                        });
                    }
                }

                // Right edge (always include for last col)
                if (c === endCol) {
                    if (cellBorders.right) {
                        borders.push({
                            relRow: r - startRow,
                            relCol: c - startCol,
                            edge: 'right',
                            style: cellBorders.right.style,
                            width: cellBorders.right.width,
                            color: cellBorders.right.color,
                        });
                    }
                }
            }
        }

        return {
            cells,
            borders,
            rowCount: endRow - startRow + 1,
            colCount: endCol - startCol + 1,
        };
    }

    /**
     * Check if two border styles are equal
     */
    bordersEqual(a, b) {
        if (!a && !b) return true;
        if (!a || !b) return false;
        return a.style === b.style && a.width === b.width && a.color === b.color;
    }

    /**
     * Write data to system clipboard in multiple formats
     */
    async writeToSystemClipboard(data, range) {
        const tsv = this.generateTSV(data);
        const html = this.generateHTMLTable(data);
        const json = JSON.stringify({
            version: 1,
            source: 'plainTab',
            range: {
                startRow: range.startRow,
                endRow: range.endRow,
                startCol: range.startCol,
                endCol: range.endCol,
            },
            cells: data.cells,
            borders: data.borders,
        });

        try {
            // Try to use the modern Clipboard API with multiple formats
            const clipboardItem = new ClipboardItem({
                'text/plain': new Blob([tsv], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' }),
                [PLAINTAB_MIME]: new Blob([json], { type: PLAINTAB_MIME }),
            });
            await navigator.clipboard.write([clipboardItem]);
        } catch (err) {
            // Fallback: just write TSV
            try {
                await navigator.clipboard.writeText(tsv);
            } catch (e) {
                console.warn('Failed to write to clipboard:', e);
            }
        }
    }

    /**
     * Generate TSV (tab-separated values) for basic interoperability
     */
    generateTSV(data) {
        return data.cells.map(row =>
            row.map(cell => {
                // Use display value for TSV
                const val = cell.displayValue ?? cell.v ?? '';
                // Escape tabs and newlines
                return String(val).replace(/\t/g, '\\t').replace(/\n/g, '\\n');
            }).join('\t')
        ).join('\n');
    }

    /**
     * Generate HTML table for external apps like Google Sheets/Excel
     */
    generateHTMLTable(data) {
        let html = '<table border="0" cellspacing="0" cellpadding="0">';

        for (const row of data.cells) {
            html += '<tr>';
            for (const cell of row) {
                const styles = [];
                if (cell.fontFamily) styles.push(`font-family: ${cell.fontFamily}`);
                if (cell.fontSize) styles.push(`font-size: ${cell.fontSize}px`);
                if (cell.bold) styles.push('font-weight: bold');
                if (cell.italic) styles.push('font-style: italic');
                const textDecor = [];
                if (cell.underline) textDecor.push('underline');
                if (cell.strikethrough) textDecor.push('line-through');
                if (textDecor.length) styles.push(`text-decoration: ${textDecor.join(' ')}`);
                if (cell.color) styles.push(`color: ${cell.color}`);
                if (cell.backgroundColor) styles.push(`background-color: ${cell.backgroundColor}`);
                if (cell.horizontalAlign) styles.push(`text-align: ${cell.horizontalAlign}`);

                const styleAttr = styles.length ? ` style="${styles.join('; ')}"` : '';
                const value = this.escapeHtml(cell.displayValue ?? cell.v ?? '');
                html += `<td${styleAttr}>${value}</td>`;
            }
            html += '</tr>';
        }

        html += '</table>';
        return html;
    }

    /**
     * Escape HTML special characters
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Parse HTML table from clipboard (for pasting from Google Sheets/Excel)
     */
    parseHTMLTable(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const table = doc.querySelector('table');
        if (!table) return null;

        const cells = [];
        const rows = table.querySelectorAll('tr');

        for (const row of rows) {
            const rowData = [];
            const tds = row.querySelectorAll('td, th');

            for (const td of tds) {
                const style = td.getAttribute('style') || '';
                const cell = {
                    v: td.textContent || null,
                    displayValue: td.textContent || null,
                    isFormula: false,
                };

                // Parse inline styles
                if (style.includes('font-family:')) {
                    const match = style.match(/font-family:\s*([^;]+)/);
                    if (match) cell.fontFamily = match[1].trim();
                }
                if (style.includes('font-size:')) {
                    const match = style.match(/font-size:\s*(\d+)px/);
                    if (match) cell.fontSize = parseInt(match[1], 10);
                }
                if (style.includes('font-weight:')) {
                    cell.bold = style.includes('font-weight: bold');
                }
                if (style.includes('font-style:')) {
                    cell.italic = style.includes('font-style: italic');
                }
                if (style.includes('text-decoration:')) {
                    cell.underline = style.includes('underline');
                    cell.strikethrough = style.includes('line-through');
                }
                if (style.includes('color:')) {
                    const match = style.match(/color:\s*([^;]+)/);
                    if (match) cell.color = match[1].trim();
                }
                if (style.includes('background-color:')) {
                    const match = style.match(/background-color:\s*([^;]+)/);
                    if (match) cell.backgroundColor = match[1].trim();
                }
                if (style.includes('text-align:')) {
                    const match = style.match(/text-align:\s*([^;]+)/);
                    if (match) cell.horizontalAlign = match[1].trim();
                }

                rowData.push(cell);
            }

            if (rowData.length > 0) {
                cells.push(rowData);
            }
        }

        return cells.length > 0 ? { cells, borders: [], rowCount: cells.length, colCount: cells[0].length } : null;
    }

    /**
     * Paste from clipboard with the specified mode
     * @param {Object} sheetStore - The active sheet store
     * @param {Object} session - Spreadsheet session
     * @param {Object} ydoc - Yjs document for transactions
     * @param {string} mode - Paste mode: 'full', 'values', 'formulas', 'formatting', 'valuesFormat', 'formulasFormat'
     */
    async paste(sheetStore, session, ydoc, mode = 'full') {
        const selectionState = getSelectionState();
        const range = selectionState?.range;
        if (!range || !sheetStore) return;

        // Get clipboard data
        let clipboardContent = await this.readFromSystemClipboard();

        if (!clipboardContent) {
            console.log('No clipboard content available');
            return;
        }

        const { data, isInternal } = clipboardContent;

        // Apply the paste operation
        ydoc?.transact(() => {
            this.applyPaste(sheetStore, session, data, range, mode, isInternal);
        });

        // If this was a cut operation, clear the source
        if (isInternal && this.clipboardType === 'cut') {
            const srcRange = this.clipboardData.range;
            ydoc?.transact(() => {
                for (let r = srcRange.startRow; r <= srcRange.endRow; r++) {
                    for (let c = srcRange.startCol; c <= srcRange.endCol; c++) {
                        sheetStore.clearCellValue(r, c);
                    }
                }
            });
            // Clear clipboard after cut-paste
            this.clipboardData = null;
            this.clipboardType = null;
        }
    }

    /**
     * Read from system clipboard
     */
    async readFromSystemClipboard() {
        // First check internal clipboard
        if (this.clipboardData) {
            return { data: this.clipboardData.data, isInternal: true };
        }

        // Try to read from system clipboard
        try {
            const items = await navigator.clipboard.read();

            // Look for our custom format first
            for (const item of items) {
                if (item.types.includes(PLAINTAB_MIME)) {
                    const blob = await item.getType(PLAINTAB_MIME);
                    const text = await blob.text();
                    const json = JSON.parse(text);
                    return {
                        data: {
                            cells: json.cells,
                            borders: json.borders,
                            rowCount: json.cells.length,
                            colCount: json.cells[0]?.length || 0,
                        },
                        isInternal: true
                    };
                }
            }

            // Look for HTML table (from Google Sheets/Excel)
            for (const item of items) {
                if (item.types.includes('text/html')) {
                    const blob = await item.getType('text/html');
                    const html = await blob.text();
                    const parsed = this.parseHTMLTable(html);
                    if (parsed) {
                        return { data: parsed, isInternal: false };
                    }
                }
            }

            // Fall back to plain text (TSV)
            for (const item of items) {
                if (item.types.includes('text/plain')) {
                    const blob = await item.getType('text/plain');
                    const text = await blob.text();
                    const parsed = this.parseTSV(text);
                    if (parsed) {
                        return { data: parsed, isInternal: false };
                    }
                }
            }
        } catch (err) {
            // Fallback to readText
            try {
                const text = await navigator.clipboard.readText();
                const parsed = this.parseTSV(text);
                if (parsed) {
                    return { data: parsed, isInternal: false };
                }
            } catch (e) {
                console.warn('Failed to read from clipboard:', e);
            }
        }

        return null;
    }

    /**
     * Parse TSV text into cell data
     */
    parseTSV(text) {
        if (!text) return null;

        const rows = text.split('\n');
        const cells = [];

        for (const row of rows) {
            const cols = row.split('\t');
            const rowData = cols.map(cell => ({
                v: cell || null,
                displayValue: cell || null,
                isFormula: cell && cell.startsWith('='),
            }));
            cells.push(rowData);
        }

        return cells.length > 0 ? { cells, borders: [], rowCount: cells.length, colCount: cells[0]?.length || 0 } : null;
    }

    /**
     * Apply paste operation to cells
     */
    applyPaste(sheetStore, session, data, targetRange, mode, isInternal) {
        const { cells, borders } = data;
        const srcRowCount = data.rowCount || cells.length;
        const srcColCount = data.colCount || cells[0]?.length || 0;

        // Calculate destination range
        // If source is 1x1 and target is larger, tile the source
        const isSingleCell = srcRowCount === 1 && srcColCount === 1;
        const destStartRow = targetRange.startRow;
        const destStartCol = targetRange.startCol;
        const destEndRow = isSingleCell ? targetRange.endRow : destStartRow + srcRowCount - 1;
        const destEndCol = isSingleCell ? targetRange.endCol : destStartCol + srcColCount - 1;

        // Apply cells
        for (let r = destStartRow; r <= destEndRow; r++) {
            for (let c = destStartCol; c <= destEndCol; c++) {
                // Calculate source cell (with tiling for single-cell copy)
                const srcRow = isSingleCell ? 0 : (r - destStartRow) % srcRowCount;
                const srcCol = isSingleCell ? 0 : (c - destStartCol) % srcColCount;
                const cell = cells[srcRow]?.[srcCol];

                if (!cell) continue;

                // Calculate formula offset for adjustment
                const rowOffset = r - (this.clipboardData?.range?.startRow ?? destStartRow);
                const colOffset = c - (this.clipboardData?.range?.startCol ?? destStartCol);

                // Apply based on mode
                switch (mode) {
                    case 'full':
                        this.applyValue(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
                        this.applyFormatting(sheetStore, cell, r, c);
                        break;
                    case 'values':
                        this.applyValueOnly(sheetStore, cell, r, c);
                        break;
                    case 'formulas':
                        this.applyFormulaOnly(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
                        break;
                    case 'formatting':
                        this.applyFormatting(sheetStore, cell, r, c);
                        break;
                    case 'valuesFormat':
                        this.applyValueOnly(sheetStore, cell, r, c);
                        this.applyFormatting(sheetStore, cell, r, c);
                        break;
                    case 'formulasFormat':
                        this.applyFormulaOnly(sheetStore, cell, r, c, rowOffset, colOffset, isInternal);
                        this.applyFormatting(sheetStore, cell, r, c);
                        break;
                }
            }
        }

        // Apply borders (only in modes that include formatting)
        if (['full', 'formatting', 'valuesFormat', 'formulasFormat'].includes(mode) && borders && borders.length > 0) {
            this.applyBorders(sheetStore, borders, destStartRow, destStartCol, destEndRow, destEndCol);
        }
    }

    /**
     * Apply value (formula or raw value) with adjustment
     */
    applyValue(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
        if (cell.isFormula && isInternal && cell.v) {
            // Adjust formula references
            const adjusted = this.adjustFormula(cell.v, rowOffset, colOffset);
            sheetStore.setCellFormula(row, col, adjusted);
        } else if (cell.v !== null && cell.v !== undefined) {
            sheetStore.setCellValue(row, col, cell.v);
        }
    }

    /**
     * Apply only the computed value (not formula)
     */
    applyValueOnly(sheetStore, cell, row, col) {
        const value = cell.displayValue ?? cell.v;
        if (value !== null && value !== undefined) {
            sheetStore.setCellValue(row, col, value);
        }
    }

    /**
     * Apply only the formula (with adjustment)
     */
    applyFormulaOnly(sheetStore, cell, row, col, rowOffset, colOffset, isInternal) {
        if (cell.isFormula && isInternal && cell.v) {
            const adjusted = this.adjustFormula(cell.v, rowOffset, colOffset);
            sheetStore.setCellFormula(row, col, adjusted);
        } else if (cell.v !== null && cell.v !== undefined && !cell.isFormula) {
            // For non-formulas, just paste the value
            sheetStore.setCellValue(row, col, cell.v);
        }
    }

    /**
     * Apply formatting from cell
     */
    applyFormatting(sheetStore, cell, row, col) {
        const props = {};
        if (cell.fontFamily) props.fontFamily = cell.fontFamily;
        if (cell.fontSize) props.fontSize = cell.fontSize;
        if (cell.bold) props.bold = cell.bold;
        if (cell.italic) props.italic = cell.italic;
        if (cell.underline) props.underline = cell.underline;
        if (cell.strikethrough) props.strikethrough = cell.strikethrough;
        if (cell.color) props.color = cell.color;
        if (cell.backgroundColor) props.backgroundColor = cell.backgroundColor;
        if (cell.horizontalAlign) props.horizontalAlign = cell.horizontalAlign;

        if (Object.keys(props).length > 0) {
            sheetStore.setCellProperties(row, col, props);
        }
    }

    /**
     * Apply borders relative to destination
     */
    applyBorders(sheetStore, borders, startRow, startCol, endRow, endCol) {
        // Clear existing borders in range first
        sheetStore.clearBordersInRange(startRow, endRow, startCol, endCol);

        // Apply each border
        for (const border of borders) {
            const row = startRow + border.relRow;
            const col = startCol + border.relCol;

            // Only apply if within destination range
            if (row < startRow || row > endRow || col < startCol || col > endCol) continue;

            const borderStyle = {
                style: border.style,
                width: border.width,
                color: border.color,
            };

            sheetStore.setCellBorder(row, col, border.edge, borderStyle);
        }
    }

    /**
     * Adjust formula references based on offset
     * E.g., =A1 becomes =B2 when moved 1 row and 1 column
     */
    adjustFormula(formula, rowOffset, colOffset) {
        if (rowOffset === 0 && colOffset === 0) return formula;

        // Parse and adjust cell/range references
        return formula.replace(/(\$?)([A-Z]+)(\$?)(\d+)/g, (match, colAbs, col, rowAbs, row) => {
            const colNum = this.colToNum(col);
            const rowNum = parseInt(row, 10);

            // Adjust only relative references
            const newCol = colAbs ? col : this.numToCol(colNum + colOffset);
            const newRow = rowAbs ? row : String(rowNum + rowOffset);

            return `${colAbs}${newCol}${rowAbs}${newRow}`;
        });
    }

    /**
     * Convert column letters to number (A=0, B=1, etc.)
     */
    colToNum(col) {
        let num = 0;
        for (let i = 0; i < col.length; i++) {
            num = num * 26 + (col.charCodeAt(i) - 64);
        }
        return num - 1; // Convert to 0-indexed
    }

    /**
     * Convert number to column letters
     */
    numToCol(num) {
        let col = '';
        num++; // Convert to 1-indexed
        while (num > 0) {
            num--;
            col = String.fromCharCode(65 + (num % 26)) + col;
            num = Math.floor(num / 26);
        }
        return col;
    }

    /**
     * Check if clipboard has content
     */
    hasClipboard() {
        return this.clipboardData !== null;
    }

    /**
     * Check if we can paste (has clipboard or system clipboard available)
     */
    canPaste() {
        return true; // We can always attempt to paste from system clipboard
    }
}

// Export singleton instance
export const clipboardManager = new ClipboardManager();
