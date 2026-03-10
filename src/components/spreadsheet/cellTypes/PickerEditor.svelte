<script>
    import { createEventDispatcher } from "svelte";
    const dispatch = createEventDispatcher();

    export let value = "";
    export let type = "date"; // 'date' | 'time' | 'datetime-local'

    function handleChange(e) {
        dispatch("change", e.target.value);
    }

    function handleBlur() {
        dispatch("blur");
    }

    function handleKeydown(e) {
        if (e.key === "Enter" || e.key === "Tab") {
            dispatch("commit", value);
        }
        if (e.key === "Escape") {
            dispatch("cancel");
        }
    }
</script>

<input
    {type}
    class="picker-editor"
    {value}
    on:input={handleChange}
    on:blur={handleBlur}
    on:keydown={handleKeydown}
    autofocus
/>

<style>
    .picker-editor {
        width: 100%;
        height: 100%;
        border: none;
        outline: none;
        padding: 0 4px;
        font-family: inherit;
        font-size: inherit;
        box-sizing: border-box;
    }
</style>
