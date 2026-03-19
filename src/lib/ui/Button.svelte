<script>
    /** @type {((event: MouseEvent) => void) | undefined} */
    export let onclick = undefined;

    /** @type {'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warning'} */
    export let variant = "primary";

    /** @type {'sm' | 'md' | 'lg'} */
    export let size = "md";

    /** @type {'default' | 'round' | 'pill'} */
    export let shape = "default";

    /** @type {string | undefined} */
    export let icon = undefined;

    /** @type {'left' | 'right' | 'only'} */
    export let iconPosition = "left";

    /** @type {boolean} */
    export let loading = false;

    /** @type {boolean} */
    export let disabled = false;

    /** @type {boolean} */
    export let fullWidth = false;

    /** @type {string | undefined} */
    export let ariaLabel = undefined;

    /** @type {'button' | 'submit' | 'reset'} */
    export let type = "button";

    /** @type {string | undefined} */
    export let href = undefined;

    /** @type {string | undefined} */
    export let className = undefined;

    // Internal click handler
    function handleClick(event) {
        if (!disabled && !loading && onclick) {
            onclick(event);
        }
    }

    // Determine if we should render as an anchor or button
    $: tag = href ? "a" : "button";

    // Base button styles - desktop/dialog style
    $: baseClasses = `
        inline-flex items-center justify-center gap-2
        font-medium transition-all duration-100 ease-out
        select-none
        border box-border relative overflow-hidden
        [-webkit-tap-highlight-color:transparent]
    `;

    // Size classes - compact desktop button dimensions
    $: sizeClasses = {
        sm: "h-7 px-3 text-[0.8125em] min-w-[32px] rounded-[4px]",
        md: "h-8 px-3 text-[0.875em] min-w-[36px] rounded-[5px]",
        lg: "h-9 px-4 text-[0.9375em] min-w-[40px] rounded-[5px]",
    }[size];

    // Shape classes
    $: shapeClasses = {
        default: "",
        round: "rounded-full aspect-square p-0 w-auto",
        pill: "rounded-full",
    }[shape];

    // Variant classes - flat desktop style
    $: variantClasses = {
        primary: `
            bg-primary text-white
            border-primary
            hover:bg-[#0066dd]
            active:bg-[#0055cc]
        `,
        secondary: `
            bg-surface text-text
            border-border
            hover:bg-fill
            active:bg-fill-secondary
        `,
        ghost: `
            bg-transparent text-text-secondary
            border-transparent
            hover:bg-fill
            active:bg-fill-secondary
        `,
        danger: `
            bg-[#dc2626] text-white
            border-[#dc2626]
            hover:bg-[#b91c1c]
            active:bg-[#991b1b]
        `,
        success: `
            bg-[#16a34a] text-white
            border-[#16a34a]
            hover:bg-[#15803d]
            active:bg-[#166534]
        `,
        warning: `
            bg-[#ea580c] text-white
            border-[#ea580c]
            hover:bg-[#c2410c]
            active:bg-[#9a3412]
        `,
    }[variant];

    // Dark mode adjustments
    $: darkClasses = {
        primary: `
            dark:bg-primary dark:border-primary
            dark:hover:bg-[#0066dd]
        `,
        secondary: `
            dark:bg-surface dark:border-border
            dark:hover:bg-fill
        `,
        ghost: `
            dark:bg-transparent dark:border-transparent
            dark:hover:bg-fill
        `,
        danger: `
            dark:bg-[#dc2626] dark:border-[#dc2626]
            dark:hover:bg-[#b91c1c]
        `,
        success: `
            dark:bg-[#16a34a] dark:border-[#16a34a]
            dark:hover:bg-[#15803d]
        `,
        warning: `
            dark:bg-[#ea580c] dark:border-[#ea580c]
            dark:hover:bg-[#c2410c]
        `,
    }[variant];

    // Disabled/loading classes
    $: stateClasses =
        disabled || loading
            ? "opacity-50 cursor-not-allowed pointer-events-none"
            : "cursor-pointer";

    // Width class
    $: widthClass = fullWidth ? "w-full" : "";
</script>

{#if tag === "a"}
    <a
        {href}
        class="{baseClasses} {sizeClasses} {shapeClasses} {variantClasses} {darkClasses} {stateClasses} {widthClass} {className}"
        class:opacity-60={loading}
        aria-label={ariaLabel}
        onclick={handleClick}
        role="button"
    >
        {#if loading}
            <span
                class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full"
            ></span>
        {:else if icon && iconPosition === "only"}
            <span class="flex items-center justify-center w-5 h-5">
                {@html icon}
            </span>
        {:else}
            {#if icon && iconPosition === "left"}
                <span class="flex items-center w-5 h-5">
                    {@html icon}
                </span>
            {/if}
            {#if iconPosition !== "only"}
                <span class="whitespace-nowrap overflow-hidden text-ellipsis">
                    <slot />
                </span>
            {/if}
            {#if icon && iconPosition === "right"}
                <span class="flex items-center w-5 h-5">
                    {@html icon}
                </span>
            {/if}
        {/if}
    </a>
{:else}
    <button
        {type}
        class="{baseClasses} {sizeClasses} {shapeClasses} {variantClasses} {darkClasses} {stateClasses} {widthClass} {className}"
        class:opacity-60={loading}
        aria-label={ariaLabel}
        {disabled}
        onclick={handleClick}
    >
        {#if loading}
            <span
                class="animate-spin w-4 h-4 border-2 border-current border-t-transparent rounded-full"
            ></span>
        {:else if icon && iconPosition === "only"}
            <span class="flex items-center justify-center w-5 h-5">
                {@html icon}
            </span>
        {:else if iconPosition === "only"}
            <span class="flex items-center justify-center">
                <slot />
            </span>
        {:else}
            {#if icon && iconPosition === "left"}
                <span class="flex items-center w-5 h-5">
                    {@html icon}
                </span>
            {/if}
            <span class="whitespace-nowrap overflow-hidden text-ellipsis">
                <slot />
            </span>
            {#if icon && iconPosition === "right"}
                <span class="flex items-center w-5 h-5">
                    {@html icon}
                </span>
            {/if}
        {/if}
    </button>
{/if}
