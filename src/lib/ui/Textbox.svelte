<script>
    /** @type {string} */
    export let value = "";

    /** @type {string} */
    export let placeholder = "";

    /** @type {'text' | 'password' | 'email' | 'number' | 'search' | 'tel' | 'url'} */
    export let type = "text";

    /** @type {string} */
    export let className = "";

    /** @type {boolean} */
    export let disabled = false;
</script>

<input
    {type}
    bind:value
    {placeholder}
    {disabled}
    class="
        w-full
        bg-transparent
        text-text
        border 1px-border-separator
        rounded-lg
        px-3
        py-2
        placeholder:text-text-secondary
        focus:outline-none
        focus:ring-2
        focus:ring-primary
        disabled:opacity-50
        disabled:cursor-not-allowed
        {className}
    "
/>
