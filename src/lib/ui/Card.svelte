<script>
    /** @type {string} */
    export let className = "";
    /** @type {import('svelte/elements').HTMLAttributes<HTMLElement>['onclick']} */
    export let onclick = undefined;
</script>

<article
    class="
    bg-[var(--system-background-secondary)]
    text-[var(--system-label)]
    rounded-xl
    shadow-sm
    border border-[var(--system-separator)]
    p-4
    {className}
"
    {onclick}
>
    <slot />
</article>
