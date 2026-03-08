<script>
    /** @type {string} */
    export let className = "";
</script>

<div class="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 {className}">
    <slot />
</div>
