<script>
    import { onMount, onDestroy } from "svelte";

    let { x = 0, y = 0, items = [], onClose = () => {} } = $props();

    let menuRef = $state(null);
    let position = $state({ x, y });
    let menuPositioned = $state(false);

    // Submenu state
    let activeIndex = $state(-1);
    let submenuRef = $state(null);
    let submenuPos = $state({ x: 0, y: 0 });
    let submenuPositioned = $state(false);
    let closeTimer = null;

    // Position main menu within viewport after first render
    $effect(() => {
        if (menuRef) {
            const rect = menuRef.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            position = {
                x: Math.max(8, x + rect.width  > vw - 8 ? vw - rect.width  - 8 : x),
                y: Math.max(8, y + rect.height > vh - 8 ? vh - rect.height - 8 : y),
            };
            menuPositioned = true;
        }
    });

    // Fine-tune submenu position after it renders (corrects vertical overflow)
    $effect(() => {
        if (submenuRef && activeIndex >= 0) {
            const rect = submenuRef.getBoundingClientRect();
            const vh = window.innerHeight;
            const maxY = Math.max(8, vh - rect.height - 8);
            if (submenuPos.y > maxY) submenuPos = { ...submenuPos, y: maxY };
            submenuPositioned = true;
        }
    });

    function openSubmenu(index, itemEl) {
        clearTimeout(closeTimer);
        if (activeIndex === index) return;

        submenuPositioned = false;
        const r = itemEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const estimatedWidth = 200;
        const openLeft = r.right + 2 + estimatedWidth > vw - 8;

        activeIndex = index;
        submenuPos = {
            x: openLeft ? Math.max(8, r.left - estimatedWidth - 2) : r.right + 2,
            y: r.top - 6,
        };
    }

    function scheduleClose() {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => {
            activeIndex = -1;
            submenuPositioned = false;
        }, 150);
    }

    function cancelClose() {
        clearTimeout(closeTimer);
    }

    function handleRegularItemEnter() {
        cancelClose();
        activeIndex = -1;
        submenuPositioned = false;
    }

    function handleItemClick(item) {
        if (item.disabled || item.submenu) return;
        onClose();
        item.action?.();
    }

    function handleSubmenuItemClick(item) {
        if (item.disabled) return;
        onClose();
        item.action?.();
    }

    function handleClickOutside(e) {
        if (!menuRef?.contains(e.target) && !submenuRef?.contains(e.target)) {
            onClose();
        }
    }

    function handleKeydown(e) {
        if (e.key === "Escape") onClose();
    }

    onMount(() => {
        document.addEventListener("click", handleClickOutside);
        document.addEventListener("keydown", handleKeydown);
    });

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
        clearTimeout(closeTimer);
    });
</script>

<!-- Main menu -->
<div
    bind:this={menuRef}
    class="context-menu"
    class:positioned={menuPositioned}
    style="left: {position.x}px; top: {position.y}px;"
    role="menu"
>
    {#each items as item, i}
        {#if item.divider}
            <div class="divider"></div>
        {:else if item.submenu}
            <!-- svelte-ignore a11y_interactive_supports_focus -->
            <div
                class="menu-item has-submenu"
                class:active={activeIndex === i}
                role="menuitem"
                aria-haspopup="true"
                aria-expanded={activeIndex === i}
                onmouseenter={(e) => openSubmenu(i, e.currentTarget)}
                onmouseleave={scheduleClose}
            >
                {#if item.icon}
                    <span class="item-icon">
                        {#if item.isSvgIcon}{@html item.icon}{:else}{item.icon}{/if}
                    </span>
                {/if}
                <span class="item-label">{item.label}</span>
                <span class="submenu-arrow">▶</span>
            </div>
        {:else}
            <button
                class="menu-item"
                class:disabled={item.disabled}
                role="menuitem"
                onclick={() => handleItemClick(item)}
                onmouseenter={handleRegularItemEnter}
                disabled={item.disabled}
            >
                {#if item.icon}
                    <span class="item-icon">
                        {#if item.isSvgIcon}{@html item.icon}{:else}{item.icon}{/if}
                    </span>
                {/if}
                <span class="item-label">{item.label}</span>
                {#if item.shortcut}
                    <span class="shortcut">{item.shortcut}</span>
                {/if}
            </button>
        {/if}
    {/each}
</div>

<!--
    Submenu rendered as a sibling fixed-position panel — NOT a child of the main
    menu — so it is never clipped by the parent's overflow or stacking context.
-->
{#if activeIndex >= 0 && items[activeIndex]?.submenu}
    <div
        bind:this={submenuRef}
        class="context-menu submenu-panel"
        class:positioned={submenuPositioned}
        style="left: {submenuPos.x}px; top: {submenuPos.y}px;"
        role="menu"
        onmouseenter={cancelClose}
        onmouseleave={scheduleClose}
    >
        {#each items[activeIndex].submenu as subItem}
            {#if subItem.divider}
                <div class="divider"></div>
            {:else}
                <button
                    class="menu-item"
                    class:disabled={subItem.disabled}
                    role="menuitem"
                    onclick={() => handleSubmenuItemClick(subItem)}
                    disabled={subItem.disabled}
                >
                    {#if subItem.icon}
                        <span class="item-icon">
                            {#if subItem.isSvgIcon}{@html subItem.icon}{:else}{subItem.icon}{/if}
                        </span>
                    {/if}
                    <span class="item-label">{subItem.label}</span>
                    {#if subItem.shortcut}
                        <span class="shortcut">{subItem.shortcut}</span>
                    {/if}
                </button>
            {/if}
        {/each}
    </div>
{/if}

<style>
    .context-menu {
        position: fixed;
        min-width: 200px;
        max-width: 280px;
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        padding: 6px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.12),
            0 8px 24px rgba(0, 0, 0, 0.14);
        z-index: 10000;
        /* Hidden until JS positions it — prevents flash at (0,0) */
        visibility: hidden;
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
    }

    .context-menu.positioned {
        visibility: visible;
        animation: menu-enter 0.1s ease-out;
    }

    .submenu-panel {
        z-index: 10001;
    }

    @keyframes menu-enter {
        from { opacity: 0; transform: scale(0.96); }
        to   { opacity: 1; transform: scale(1); }
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
        transition: background 0.08s ease;
    }

    .menu-item:hover:not(.disabled),
    .menu-item.active {
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
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }

    .submenu-arrow {
        font-size: 0.5625rem;
        color: var(--color-text-tertiary);
        margin-left: auto;
        flex-shrink: 0;
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 6px 10px;
    }

    @media (max-width: 600px) {
        .context-menu {
            min-width: 220px;
        }
        .menu-item {
            padding: 11px 16px;
            font-size: 0.875rem;
        }
        .item-icon {
            width: 20px;
            height: 20px;
        }
        .shortcut {
            display: none;
        }
        .divider {
            margin: 8px 12px;
        }
    }
</style>
