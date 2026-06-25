<script>
    import { spreadsheetSession, selectionState } from "../../../stores/spreadsheetStore.svelte.js";
    import { date, checkbox, star, imageIcon } from "../../../lib/icons/index.js";
    import { CellTypeRegistry } from "../../../stores/spreadsheet/cellTypes/index.js";
    import DateConfigPanel     from "../../../stores/spreadsheet/cellTypes/types/DateConfigPanel.svelte";
    import NumberConfigPanel   from "../../../stores/spreadsheet/cellTypes/types/NumberConfigPanel.svelte";
    import DropdownConfigPanel from "../../../stores/spreadsheet/cellTypes/types/DropdownConfigPanel.svelte";

    const CONFIG_PANELS = {
        date:     DateConfigPanel,
        number:   NumberConfigPanel,
        dropdown: DropdownConfigPanel,
    };

    /**
     * Controlled mode: when both props are provided the component reads/writes
     * through these instead of the spreadsheet store.
     * @type {{ controlledConfig?: ({ type: string, [key: string]: any } | null), onControlledChange?: (((config: { type: string, [key: string]: any } | null) => void) | null) }}
     */
    let { controlledConfig = null, onControlledChange = null } = $props();

    let sheetStore = $derived(spreadsheetSession.activeSheetStore);
    let selection  = $derived(selectionState.range);

    let currentType = $state('text');
    /** @type {any} */
    let options = $state({});

    let isNumberFamily = $derived(currentType === 'number');

    $effect(() => {
        if (onControlledChange !== null) {
            currentType = controlledConfig?.type || 'text';
            options = controlledConfig
                ? Object.fromEntries(Object.entries(controlledConfig).filter(([key]) => key !== 'type'))
                : {};
            return;
        }
        if (selection && sheetStore) {
            const _cellVer    = sheetStore.cellsVersion;
            const _rowMetaVer = sheetStore.rowMetaVersion;
            const _colMetaVer = sheetStore.colMetaVersion;
            const config = sheetStore.getCellTypeConfig(selection.startRow, selection.startCol);
            currentType = config?.type || 'text';
            options = config
                ? Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'type'))
                : {};
        }
    });

    function getDefaultOptionsForType(type) {
        const defaults = {
            text:     {},
            number:   { subFormat: 'default', decimals: 2, thousandsSep: true, negativeStyle: 'minus' },
            date:     { subFormat: 'date', datePreset: 'MM/DD/YYYY', timePreset: 'h:mm A' },
            rating:   { max: 5 },
            checkbox: {},
            image:    { fit: 'contain' },
            file:     {},
            dropdown: { source: 'list', options: [], allowCustom: false },
        };
        return defaults[type] || {};
    }

    function setType(type) {
        // In controlled mode (e.g. table column panel) there is no grid selection;
        // applyToSelection routes through onControlledChange instead.
        if (!onControlledChange && (!selection || !sheetStore)) return;
        const newOptions = getDefaultOptionsForType(type);
        const config = { type, ...newOptions };
        currentType = type;
        options = newOptions;
        applyToSelection(type === 'text' ? null : config);
    }

    function applyToSelection(config) {
        if (onControlledChange) { onControlledChange(config); return; }
        if (!selection || !sheetStore) return;
        spreadsheetSession.ydoc.transact(() => {
            for (let r = selection.startRow; r <= selection.endRow; r++) {
                for (let c = selection.startCol; c <= selection.endCol; c++) {
                    sheetStore.setCellTypeConfig(r, c, config);
                }
            }
        });
    }

    // Called by config panels when any option changes
    function handlePanelUpdate(config) {
        currentType = config.type;
        options = Object.fromEntries(Object.entries(config).filter(([k]) => k !== 'type'));
        applyToSelection(config);
    }

    // Active type id, normalising the number family
    let activeTypeId = $derived(isNumberFamily ? 'number' : currentType);

    // Descriptor for the active type (resolves legacy ids too)
    let descriptor = $derived(CellTypeRegistry.get(isNumberFamily ? 'number' : currentType));

    const types = [
        { id: 'text',     label: 'Text',     icon: 'abc'       },
        { id: 'number',   label: 'Number',   icon: '123'       },
        { id: 'date',     label: 'Date',     icon: date,      isSvg: true },
        { id: 'checkbox', label: 'Checkbox', icon: checkbox,  isSvg: true },
        { id: 'rating',   label: 'Rating',   icon: star,      isSvg: true },
        { id: 'image',    label: 'Image',    icon: imageIcon, isSvg: true },
        { id: 'file',     label: 'File',     icon: '📎'        },
        { id: 'dropdown', label: 'Dropdown', icon: '▾'         },
    ];
</script>

<div class="configurator">
    <div class="type-grid">
        {#each types as type}
            <button
                class="type-btn"
                class:active={activeTypeId === type.id}
                onclick={() => setType(type.id)}
                title={type.label}
            >
                <span class="icon">{#if type.isSvg}{@html type.icon}{:else}{type.icon}{/if}</span>
                <span class="label">{type.label}</span>
            </button>
        {/each}
    </div>

    {#if CONFIG_PANELS[activeTypeId]}
        <svelte:component
            this={CONFIG_PANELS[activeTypeId]}
            {options}
            onUpdate={handlePanelUpdate}
        />
    {/if}
</div>

<style>
    .configurator {
        padding: 2px 0;
        min-width: 220px;
        background: transparent;
        border-radius: 4px;
    }

    .type-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        margin-bottom: 10px;
    }

    .type-btn {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 7px 11px;
        border: 1px solid #e2e8f0;
        background: var(--cell-bg, #fff);
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-color, #1e293b);
        text-align: left;
    }

    .type-btn:hover { background: #f8fafc; border-color: #94a3b8; }

    .type-btn.active {
        background: #eff6ff;
        border-color: #3b82f6;
        color: #1d4ed8;
        font-weight: 600;
    }

    .icon {
        font-weight: bold;
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 13px;
        flex-shrink: 0;
    }
</style>
