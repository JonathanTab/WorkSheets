<script>
    /** @type {'info' | 'success' | 'warning' | 'danger'} */
    export let type = "info";

    /** @type {string} */
    export let className = "";

    // Alert variant classes using Tailwind
    $: variantClasses = {
        info: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
        success:
            "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
        warning:
            "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
        danger: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    }[type];
</script>

<div
    class="flex items-center gap-3 rounded-lg px-4 py-3 {variantClasses} {className}"
>
    <slot />
</div>
