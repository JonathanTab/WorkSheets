<script>
    import { createEventDispatcher } from "svelte";
    const dispatch = createEventDispatcher();

    export let value = 0;
    export let max = 5;

    function handleClick(i) {
        dispatch("change", i + 1);
    }
</script>

<div class="rating-container">
    {#each Array(max) as _, i}
        <span
            class="star {i < value ? 'active' : ''}"
            on:mousedown|stopPropagation|preventDefault={() => handleClick(i)}
        >
            ★
        </span>
    {/each}
</div>

<style>
    .rating-container {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 2px;
        cursor: pointer;
    }

    .star {
        font-size: 16px;
        color: #ccc;
        transition: color 0.1s;
    }

    .star.active {
        color: #fbbc04;
    }

    .star:hover {
        transform: scale(1.2);
    }
</style>
