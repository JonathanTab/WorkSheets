<script>
    /** @type {Array<{id: string | number, content?: string}>} */
    export let items = [];
</script>

<ul class="flex flex-col gap-3">
    {#each items as item (item.id)}
        <li>{item.content || ""}<slot {item} /></li>
    {/each}
</ul>
