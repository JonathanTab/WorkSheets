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
        // If any menu is open (we're in controlled mode and some menu is open),
        // open this menu on hover
        if (onOpenChange && !disabled) {
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

<div class="menu-dropdown" class:open onmouseenter={handleMouseEnter}>
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
        color: var(--color-text);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        line-height: 1.4;
    }

    .menu-button:hover:not(.disabled) {
        background: var(--color-fill);
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
        min-width: 200px;
        margin-top: 2px;
        padding: 6px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 6px;
        box-shadow:
            0 1px 3px rgba(0, 0, 0, 0.08),
            0 4px 12px rgba(0, 0, 0, 0.12);
        z-index: 1000;
    }

    .menu-item {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 7px 12px;
        font-size: 0.8125rem;
        color: var(--color-text);
        background: transparent;
        border: none;
        cursor: pointer;
        text-align: left;
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
        background: var(--color-fill-secondary);
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

    .item-label {
        flex: 1;
        white-space: nowrap;
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
        margin: 6px 8px;
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
            0 1px 3px rgba(0, 0, 0, 0.08),
            0 4px 12px rgba(0, 0, 0, 0.12);
        z-index: 1001;
    }

    .menu-item.submenu-open {
        background: var(--color-fill);
    }
</style>
