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

    // Base button styles - iOS style
    $: baseClasses = `
        inline-flex items-center justify-center gap-2
        font-semibold transition-all duration-200 ease-out
        select-none
        border-2 box-border relative overflow-hidden
        [-webkit-tap-highlight-color:transparent]
    `;

    // Size classes - matching iOS button dimensions
    $: sizeClasses = {
        sm: "h-8 px-4 text-[0.875em] min-w-[36px] rounded-lg",
        md: "h-10 px-4 text-[0.95em] min-w-[40px] rounded-[10px]",
        lg: "h-12 px-5 text-[1em] min-w-[44px] rounded-xl",
    }[size];

    // Shape classes
    $: shapeClasses = {
        default: "",
        round: "rounded-full aspect-square p-0 w-auto",
        pill: "rounded-full",
    }[shape];

    // Variant classes using Tailwind 4 theme variables - iOS style
    $: variantClasses = {
        primary: `
            bg-primary text-text-inverse
            border-primary
            shadow-[0_2px_8px_rgba(0,122,255,0.3)]
            hover:bg-[#0077ed] hover:border-[#0077ed]
            hover:shadow-[0_4px_12px_rgba(0,122,255,0.4)]
            active:bg-[#0066cc] active:border-[#0066cc]
        `,
        secondary: `
            bg-fill text-text
            border-border
            hover:bg-fill-secondary hover:border-border-strong
            active:bg-fill-tertiary
        `,
        ghost: `
            bg-transparent text-text-secondary
            border-transparent
            hover:bg-fill
            active:bg-fill-secondary
        `,
        danger: `
            bg-red-500 text-white
            border-red-500
            shadow-[0_2px_8px_rgba(239,68,68,0.3)]
            hover:bg-red-600 hover:border-red-600
            hover:shadow-[0_4px_12px_rgba(239,68,68,0.4)]
            active:bg-red-700 active:border-red-700
        `,
        success: `
            bg-green-500 text-white
            border-green-500
            shadow-[0_2px_8px_rgba(34,197,94,0.3)]
            hover:bg-green-600 hover:border-green-600
            hover:shadow-[0_4px_12px_rgba(34,197,94,0.4)]
            active:bg-green-700 active:border-green-700
        `,
        warning: `
            bg-orange-500 text-white
            border-orange-500
            shadow-[0_2px_8px_rgba(249,115,22,0.3)]
            hover:bg-orange-600 hover:border-orange-600
            hover:shadow-[0_4px_12px_rgba(249,115,22,0.4)]
            active:bg-orange-700 active:border-orange-700
        `,
    }[variant];

    // Dark mode adjustments
    $: darkClasses = {
        primary: `
            dark:bg-primary dark:border-primary
            dark:hover:bg-[#0077ed] dark:hover:border-[#0077ed]
        `,
        secondary: `
            dark:bg-fill dark:border-border
            dark:hover:bg-fill-secondary dark:hover:border-border-strong
        `,
        ghost: `
            dark:bg-transparent dark:border-transparent
            dark:hover:bg-fill
        `,
        danger: `
            dark:bg-red-600 dark:border-red-600
            dark:hover:bg-red-700 dark:hover:border-red-700
        `,
        success: `
            dark:bg-green-600 dark:border-green-600
            dark:hover:bg-green-700 dark:hover:border-green-700
        `,
        warning: `
            dark:bg-orange-500 dark:border-orange-500
            dark:hover:bg-orange-600 dark:hover:border-orange-600
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
