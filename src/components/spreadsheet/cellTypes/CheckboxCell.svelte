<script>
    import { createEventDispatcher } from "svelte";
    const dispatch = createEventDispatcher();

    export let value = false;

    function handleToggle() {
        dispatch("change", !value);
    }
</script>

<div
    class="checkbox-container"
    on:mousedown|stopPropagation|preventDefault={handleToggle}
>
    <div class="checkbox {value ? 'checked' : ''}">
        {#if value}
            <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                stroke="currentColor"
                stroke-width="3"
                fill="none"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
        {/if}
    </div>
</div>

<style>
    .checkbox-container {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        cursor: pointer;
    }

    .checkbox {
        width: 16px;
        height: 16px;
        border: 1px solid #ccc;
        border-radius: 2px;
        background: white;
        display: flex;
        align-items: center;
        justify-content: center;
        color: white;
        transition: all 0.1s;
    }

    .checkbox.checked {
        background: #1a73e8;
        border-color: #1a73e8;
    }

    .checkbox-container:hover .checkbox {
        border-color: #1a73e8;
    }
</style>
