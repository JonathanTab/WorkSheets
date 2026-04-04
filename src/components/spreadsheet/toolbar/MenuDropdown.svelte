<script>
    import { onMount, onDestroy, tick } from "svelte";

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
    let dropdownStyle = $state("position:fixed; left:-9999px; top:-9999px;");
    let submenuDirection = $state("right");
    let panelResizeObserver = null;
    let buttonResizeObserver = null;

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

    function close({ restoreFocus = false } = {}) {
        setOpen(false);
        activeSubmenu = null;
        hoveredSubmenu = null;
        if (restoreFocus) buttonRef?.focus();
    }

    function updateDropdownPosition() {
        if (!open || !buttonRef) return;
        const margin = 8;
        const gap = 6;
        const br = buttonRef.getBoundingClientRect();
        const dr = dropdownRef?.getBoundingClientRect();
        const panelWidth = dr?.width ?? 240;
        const panelHeight = dr?.height ?? 320;

        let left = br.left;
        let top = br.bottom + gap;

        if (left + panelWidth > window.innerWidth - margin) {
            left = br.right - panelWidth;
        }
        if (left < margin) left = margin;

        if (top + panelHeight > window.innerHeight - margin) {
            const aboveTop = br.top - panelHeight - gap;
            top = aboveTop >= margin ? aboveTop : Math.max(margin, window.innerHeight - panelHeight - margin);
        }
        dropdownStyle = `position:fixed; left:${Math.round(left)}px; top:${Math.round(top)}px;`;
        submenuDirection = left + panelWidth + 190 > window.innerWidth - margin ? "left" : "right";
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

    function focusFirstMenuItem() {
        const item = dropdownRef?.querySelector(".menu-item:not(.disabled):not([disabled])");
        item?.focus();
    }

    function focusNextMenuItem(direction = 1) {
        const items = [...(dropdownRef?.querySelectorAll(".menu-item:not(.disabled):not([disabled])") ?? [])];
        if (!items.length) return;
        const active = document.activeElement;
        const idx = Math.max(0, items.indexOf(active));
        const next = items[(idx + direction + items.length) % items.length];
        next?.focus();
    }

    function handleKeydown(e) {
        if (!open) return;
        if (e.key === "Escape") {
            if (activeSubmenu) {
                activeSubmenu = null;
            } else {
                close({ restoreFocus: true });
            }
        } else if (e.key === "ArrowDown") {
            e.preventDefault();
            focusNextMenuItem(1);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            focusNextMenuItem(-1);
        }
    }

    function handleButtonKeydown(e) {
        if (disabled) return;
        if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (!open) setOpen(true);
            tick().then(focusFirstMenuItem);
        }
    }

    $effect(() => {
        if (!open) return;
        const _submenu = activeSubmenu;
        tick().then(() => {
            updateDropdownPosition();
            if (!panelResizeObserver && dropdownRef) {
                panelResizeObserver = new ResizeObserver(() => updateDropdownPosition());
                panelResizeObserver.observe(dropdownRef);
            }
            if (!buttonResizeObserver && buttonRef) {
                buttonResizeObserver = new ResizeObserver(() => updateDropdownPosition());
                buttonResizeObserver.observe(buttonRef);
            }
        });
        return () => {
            panelResizeObserver?.disconnect();
            panelResizeObserver = null;
            buttonResizeObserver?.disconnect();
            buttonResizeObserver = null;
        };
    });

    onMount(() => {
        document.addEventListener("click", handleClickOutside);
        document.addEventListener("keydown", handleKeydown);
        window.addEventListener("resize", updateDropdownPosition);
        window.addEventListener("scroll", updateDropdownPosition, true);
        window.visualViewport?.addEventListener("resize", updateDropdownPosition);
        window.visualViewport?.addEventListener("scroll", updateDropdownPosition);
    });

    onDestroy(() => {
        document.removeEventListener("click", handleClickOutside);
        document.removeEventListener("keydown", handleKeydown);
        window.removeEventListener("resize", updateDropdownPosition);
        window.removeEventListener("scroll", updateDropdownPosition, true);
        window.visualViewport?.removeEventListener("resize", updateDropdownPosition);
        window.visualViewport?.removeEventListener("scroll", updateDropdownPosition);
    });
</script>

<div
    class="menu-dropdown"
    class:open
    class:menu-active={anyMenuOpen}
>
    <button
        bind:this={buttonRef}
        class="menu-button"
        class:disabled
        class:active={open}
        {disabled}
        onclick={toggle}
        onmouseenter={handleMouseEnter}
        onkeydown={handleButtonKeydown}
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
        <div bind:this={dropdownRef} class="dropdown-panel" style={dropdownStyle} {title}>
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
                        <div class="submenu-panel" class:left={submenuDirection === "left"}>
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
        min-width: 220px;
        max-width: min(300px, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
        overflow: auto;
        padding: 6px 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 8px;
        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
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
        max-width: min(260px, calc(100vw - 16px));
        max-height: calc(100vh - 16px);
        overflow: auto;
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

    .submenu-panel.left {
        left: auto;
        right: 100%;
        margin-left: 0;
        margin-right: 2px;
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
