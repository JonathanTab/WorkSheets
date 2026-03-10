<script>
    import { onMount, onDestroy } from "svelte";

    let {
        label = "",
        icon = null,
        title = "",
        items = [],
        disabled = false,
        children = null,
    } = $props();

    let open = $state(false);
    let buttonRef = $state(null);
    let dropdownRef = $state(null);
    let activeSubmenu = $state(null);

    function toggle() {
        if (disabled) return;
        open = !open;
    }

    function close() {
        open = false;
        activeSubmenu = null;
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

<div class="menu-dropdown" class:open>
    <button
        bind:this={buttonRef}
        class="menu-button"
        class:disabled
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
        <span class="arrow">▾</span>
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
                        disabled={item.disabled}
                    >
                        {#if item.icon}
                            <span class="item-icon">{item.icon}</span>
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
                                                >{subItem.icon}</span
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
        gap: 4px;
        padding: 0.25rem 0.5rem;
        font-size: 0.8125rem;
        font-weight: 500;
        color: var(--color-text);
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.15s ease;
    }

    .menu-button:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .menu-button.open {
        background: var(--color-fill-secondary);
    }

    .menu-button.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .arrow {
        font-size: 0.625rem;
        opacity: 0.6;
    }

    .dropdown-panel {
        position: absolute;
        top: 100%;
        left: 0;
        min-width: 180px;
        margin-top: 4px;
        padding: 4px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1000;
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
    }

    .menu-item:hover:not(.disabled) {
        background: var(--color-fill);
    }

    .menu-item.disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .item-icon {
        width: 16px;
        text-align: center;
        opacity: 0.7;
    }

    .item-label {
        flex: 1;
    }

    .shortcut {
        font-size: 0.75rem;
        color: var(--color-text-tertiary);
        margin-left: 16px;
    }

    .divider {
        height: 1px;
        background: var(--color-border);
        margin: 4px 8px;
    }

    .has-submenu {
        position: relative;
    }

    .submenu-arrow {
        font-size: 0.625rem;
        opacity: 0.6;
        margin-left: auto;
    }

    .submenu-panel {
        position: absolute;
        left: 100%;
        top: 0;
        min-width: 160px;
        padding: 4px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        z-index: 1001;
    }

    .menu-item.submenu-open {
        background: var(--color-fill);
    }
</style>
