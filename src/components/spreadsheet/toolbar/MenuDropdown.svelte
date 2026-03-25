<script>
    import { onMount, onDestroy } from "svelte";

    let {
        label = "",
        icon = null,
        title = "",
        items = [],
        disabled = false,
        children = null,
        // Controlled mode for cursor-following behavior
        isOpen = false,
        onOpenChange = undefined,
        menuId = undefined,
        anyMenuOpen = false,
    } = $props();

    // Use controlled state if provided, otherwise internal state
    let internalOpen = $state(false);
    let open = $derived(onOpenChange !== undefined ? isOpen : internalOpen);
    let buttonRef = $state(null);
    let dropdownRef = $state(null);
    let activeSubmenu = $state(null);
    let hoveredSubmenu = $state(null);

    function setOpen(value) {
        if (onOpenChange) {
            onOpenChange(value, menuId);
        } else {
            internalOpen = value;
        }
    }

    function toggle() {
        if (disabled) return;
        setOpen(!open);
    }

    function close() {
        setOpen(false);
        activeSubmenu = null;
        hoveredSubmenu = null;
    }

    function handleMouseEnter() {
        // Only switch menus on hover when another menu is already open
        if (anyMenuOpen && !disabled && !open) {
            setOpen(true);
        }
    }

    function handleItemClick(item) {
        if (item.disabled) return;
        if (item.submenu) {
            // Toggle submenu
            activeSubmenu = activeSubmenu === item.label ? null : item.label;
            return;
        }
        close();
        item.action?.();
    }

    function handleItemMouseEnter(item) {
        if (item.submenu && !item.disabled) {
            hoveredSubmenu = item.label;
            // Small delay before activating submenu
            setTimeout(() => {
                if (hoveredSubmenu === item.label) {
                    activeSubmenu = item.label;
                }
            }, 100);
        }
    }

    function handleItemMouseLeave() {
        hoveredSubmenu = null;
    }

    function handleSubmenuClick(subItem) {
        if (subItem.disabled) return;
        close();
        subItem.action?.();
    }

    function handleClickOutside(e) {
        if (
            dropdownRef &&
            !dropdownRef.contains(e.target) &&
            buttonRef &&
            !buttonRef.contains(e.target)
        ) {
            close();
        }
    }

    function handleKeydown(e) {
        if (e.key === "Escape") {
            if (activeSubmenu) {
                activeSubmenu = null;
            } else {
                close();
                buttonRef?.focus();
            }
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
    class="menu-dropdown"
    class:open
    class:menu-active={anyMenuOpen}
    onmouseenter={handleMouseEnter}
>
    <button
        bind:this={buttonRef}
        class="menu-button"
        class:disabled
        class:active={open}
        {disabled}
        onclick={toggle}
        aria-haspopup="true"
        aria-expanded={open}
    >
        {#if icon}
            <span class="icon">{icon}</span>
        {/if}
        {#if label}
            {label}
        {/if}
        {#if label || icon}
            <span class="arrow">▾</span>
        {/if}
    </button>

    {#if open}
        <div bind:this={dropdownRef} class="dropdown-panel" {title}>
            {#if children}
                {@render children()}
            {/if}
            {#each items as item, i}
                {#if item.divider}
                    <div class="divider"></div>
                {:else}
                    <button
                        class="menu-item"
                        class:disabled={item.disabled}
                        class:has-submenu={item.submenu}
                        class:submenu-open={activeSubmenu === item.label}
                        onclick={() => handleItemClick(item)}
                        onmouseenter={() => handleItemMouseEnter(item)}
                        onmouseleave={handleItemMouseLeave}
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
                        {#if item.submenu}
                            <span class="submenu-arrow">▸</span>
                        {/if}
                    </button>
                    {#if item.submenu && activeSubmenu === item.label}
                        <div class="submenu-panel">
                            {#each item.submenu as subItem, j}
                                {#if subItem.divider}
                                    <div class="divider"></div>
                                {:else}
                                    <button
                                        class="menu-item"
                                        class:disabled={subItem.disabled}
                                        onclick={() =>
                                            handleSubmenuClick(subItem)}
                                        disabled={subItem.disabled}
                                    >
                                        {#if subItem.icon}
                                            <span class="item-icon"
                                                >{#if subItem.isSvgIcon}{@html subItem.icon}{:else}{subItem.icon}{/if}</span
                                            >
                                        {/if}
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
                {/if}
            {/each}
        </div>
    {/if}
</div>

<style>
    .menu-dropdown {
        position: relative;
    }

    .menu-button {
        display: flex;
        align-items: center;
        gap: 3px;
        padding: 4px 8px;
        font-size: 0.8125rem;
        font-weight: 500;
        font-family: inherit;
        color: var(--color-text);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        line-height: 1.4;
        transition: background 0.08s ease;
    }

    .menu-button:hover:not(.disabled) {
        background: var(--color-fill-secondary);
    }

    .menu-button.active {
        background: var(--color-fill-secondary);
        color: var(--color-text);
    }

    .menu-button.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .menu-button:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 1px;
    }

    .arrow {
        font-size: 0.5625rem;
        opacity: 0.5;
        margin-left: 1px;
    }

    .dropdown-panel {
        position: absolute;
        top: 100%;
        left: 0;
        min-width: 220px;
        max-width: 300px;
        margin-top: 2px;
        padding: 6px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 2px 8px rgba(0, 0, 0, 0.12),
            0 8px 24px rgba(0, 0, 0, 0.14);
        z-index: 1000;
        animation: dropdown-enter 0.1s ease-out;
    }

    @keyframes dropdown-enter {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
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
        transition: background 0.08s ease;
    }

    .menu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .menu-item.disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .menu-item:focus-visible {
        outline: none;
        background: var(--color-primary-soft);
    }

    .item-icon {
        width: 18px;
        height: 18px;
        font-size: 0.875rem;
        text-align: center;
        opacity: 0.7;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
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

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 6px 10px;
    }

    .has-submenu {
        position: relative;
    }

    .submenu-arrow {
        font-size: 0.5625rem;
        opacity: 0.5;
        margin-left: auto;
        flex-shrink: 0;
    }

    .submenu-panel {
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
        z-index: 1001;
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

    .menu-item.submenu-open {
        background: var(--color-fill);
    }

    /* ── Mobile: bigger touch targets ── */
    @media (pointer: coarse), (max-width: 768px) {
        .menu-button {
            padding: 8px 10px;
            font-size: 0.875rem;
        }
        .menu-item {
            padding: 11px 14px;
            font-size: 0.875rem;
        }
        .shortcut {
            display: none; /* hide keyboard shortcuts on touch devices */
        }
        .dropdown-panel {
            min-width: 220px;
        }
    }
</style>
