<script>
    import { onMount, onDestroy } from "svelte";

    let { x = 0, y = 0, items = [], onClose = () => {} } = $props();

    let menuRef = $state(null);
    let position = $state({ x, y });
    let activeSubmenu = $state(null); // Index of submenu item being shown
    let focusedIndex = $state(-1); // Keyboard navigation

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

            // Ensure minimum position
            newX = Math.max(8, newX);
            newY = Math.max(8, newY);

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
        min-width: 200px;
        max-width: 280px;
        padding: 6px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.12),
            0 8px 24px rgba(0, 0, 0, 0.14);
        z-index: 10000;
        animation: context-menu-enter 0.1s ease-out;
    }

    @keyframes context-menu-enter {
        from {
            opacity: 0;
            transform: scale(0.96);
        }
        to {
            opacity: 1;
            transform: scale(1);
        }
    }

    .menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 7px 14px;
        font-size: 0.8125rem;
        font-family: inherit;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
        position: relative;
        transition: background 0.08s ease;
    }

    .menu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .menu-item:focus-visible {
        outline: none;
        background: var(--color-primary-soft);
    }

    .menu-item.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .menu-item.has-submenu {
        position: relative;
    }

    .menu-item.has-submenu.active {
        background: var(--color-fill);
    }

    .item-icon {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 14px;
        opacity: 0.7;
    }

    .item-icon :global(svg) {
        width: 16px;
        height: 16px;
    }

    .item-label {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .shortcut {
        font-size: 0.6875rem;
        color: var(--color-text-muted);
        margin-left: 20px;
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
            monospace;
    }

    .submenu-arrow {
        font-size: 0.5625rem;
        color: var(--color-text-tertiary);
        margin-left: auto;
        flex-shrink: 0;
    }

    .submenu {
        position: absolute;
        left: 100%;
        top: -6px;
        min-width: 180px;
        padding: 6px 0;
        margin-left: 2px;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.12),
            0 8px 24px rgba(0, 0, 0, 0.14);
        z-index: 10001;
        animation: submenu-enter 0.1s ease-out;
    }

    @keyframes submenu-enter {
        from {
            opacity: 0;
            transform: translateX(-4px);
        }
        to {
            opacity: 1;
            transform: translateX(0);
        }
    }

    .submenu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 7px 14px;
        font-size: 0.8125rem;
        font-family: inherit;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
        transition: background 0.08s ease;
    }

    .submenu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .submenu-item:focus-visible {
        outline: none;
        background: var(--color-primary-soft);
    }

    .submenu-item.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 6px 10px;
    }

    /* ── Mobile: bigger touch targets ── */
    @media (pointer: coarse), (max-width: 768px) {
        .context-menu {
            min-width: 220px;
        }
        .menu-item,
        .submenu-item {
            padding: 11px 16px;
            font-size: 0.875rem;
        }
        .item-icon {
            width: 20px;
            height: 20px;
        }
        .shortcut {
            display: none; /* hide keyboard shortcuts on touch devices */
        }
        .divider {
            margin: 8px 12px;
        }
    }
</style>
