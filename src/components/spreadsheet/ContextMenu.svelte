<script>
    import { onMount, onDestroy } from "svelte";

    let { x = 0, y = 0, items = [], onClose = () => {} } = $props();

    let menuRef = $state(null);
    let position = $state({ x, y });
    let activeSubmenu = $state(null); // Index of submenu item being shown

    // Recalculate position to stay within viewport
    $effect(() => {
        if (menuRef && x !== undefined && y !== undefined) {
            const rect = menuRef.getBoundingClientRect();
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;

            let newX = x;
            let newY = y;

            // Adjust horizontal position
            if (x + rect.width > viewportWidth - 8) {
                newX = viewportWidth - rect.width - 8;
            }

            // Adjust vertical position
            if (y + rect.height > viewportHeight - 8) {
                newY = viewportHeight - rect.height - 8;
            }

            position = { x: newX, y: newY };
        }
    });

    function handleItemClick(item) {
        if (item.disabled || item.submenu) return;
        onClose();
        item.action?.();
    }

    function handleSubmenuEnter(index) {
        activeSubmenu = index;
    }

    function handleSubmenuLeave() {
        activeSubmenu = null;
    }

    function handleSubmenuItemClick(item) {
        if (item.disabled) return;
        onClose();
        item.action?.();
    }

    function handleClickOutside(e) {
        if (menuRef && !menuRef.contains(e.target)) {
            onClose();
        }
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            onClose();
        }
    }

    onMount(() => {
        document.addEventListener("click", handleClickOutside);
        document.addEventListener("keydown", handleKeydown);
    });

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
    });
</script>

<div
    bind:this={menuRef}
    class="context-menu"
    style="left: {position.x}px; top: {position.y}px;"
>
    {#each items as item, i}
        {#if item.divider}
            <div class="divider"></div>
        {:else if item.submenu}
            <div
                class="menu-item has-submenu"
                class:active={activeSubmenu === i}
                onmouseenter={() => handleSubmenuEnter(i)}
                onmouseleave={handleSubmenuLeave}
            >
                {#if item.icon}
                    <span class="item-icon"
                        >{#if item.isSvgIcon}{@html item.icon}{:else}{item.icon}{/if}</span
                    >
                {/if}
                <span class="item-label">{item.label}</span>
                <span class="submenu-arrow">▶</span>

                {#if activeSubmenu === i}
                    <div class="submenu">
                        {#each item.submenu as subItem, j}
                            {#if subItem.divider}
                                <div class="divider"></div>
                            {:else}
                                <button
                                    class="submenu-item"
                                    class:disabled={subItem.disabled}
                                    onclick={() =>
                                        handleSubmenuItemClick(subItem)}
                                    disabled={subItem.disabled}
                                >
                                    <span class="item-label"
                                        >{subItem.label}</span
                                    >
                                    {#if subItem.shortcut}
                                        <span class="shortcut"
                                            >{subItem.shortcut}</span
                                        >
                                    {/if}
                                </button>
                            {/if}
                        {/each}
                    </div>
                {/if}
            </div>
        {:else}
            <button
                class="menu-item"
                class:disabled={item.disabled}
                onclick={() => handleItemClick(item)}
                disabled={item.disabled}
            >
                {#if item.icon}
                    <span class="item-icon"
                        >{#if item.isSvgIcon}{@html item.icon}{:else}{item.icon}{/if}</span
                    >
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.shortcut}
                    <span class="shortcut">{item.shortcut}</span>
                {/if}
            </button>
        {/if}
    {/each}
</div>

<style>
    .context-menu {
        position: fixed;
        min-width: 180px;
        padding: 4px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 10000;
    }

    .menu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 12px;
        font-size: 0.8125rem;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
        position: relative;
    }

    .menu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .menu-item.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .menu-item.has-submenu {
        position: relative;
    }

    .menu-item.has-submenu.active {
        background: var(--color-fill);
    }

    .item-icon {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 14px;
    }

    .item-label {
        flex: 1;
    }

    .shortcut {
        font-size: 0.75rem;
        color: var(--color-text-tertiary);
        margin-left: 16px;
    }

    .submenu-arrow {
        font-size: 0.625rem;
        color: var(--color-text-tertiary);
        margin-left: 8px;
    }

    .submenu {
        position: absolute;
        left: 100%;
        top: 0;
        min-width: 160px;
        padding: 4px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 10001;
    }

    .submenu-item {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 6px 12px;
        font-size: 0.8125rem;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
    }

    .submenu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .submenu-item.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 4px 8px;
    }
</style>
