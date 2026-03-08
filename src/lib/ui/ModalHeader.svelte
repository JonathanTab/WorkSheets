<script>
    import { closeTopModal } from "./modalStore.svelte";

    let { title = "" } = $props();
</script>

<div
    class="flex justify-between items-center px-3 py-2 border-b border-separator bg-bg-secondary flex-shrink-0"
>
    <h2 class="m-0 text-2xl font-semibold text-text"><slot>{title}</slot></h2>
    <button
        class="bg-transparent border-none p-1 cursor-pointer text-text-secondary rounded-lg flex items-center justify-center hover:bg-fill-secondary transition-colors"
        onclick={closeTopModal}
        aria-label="Close modal"
    >
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
        >
            <path
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
                fill="currentColor"
            />
        </svg>
    </button>
</div>
