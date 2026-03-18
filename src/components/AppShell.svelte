<script>
    import Home from "../views/Home.svelte";
    import UserAvatar from "./UserAvatar.svelte";
</script>

<div class="h-dvh w-dvw flex flex-col overscroll-none">
    <!-- Main content area -->
    <main class="flex-1 overflow-hidden">
        <Home />
    </main>
</div>

<!-- Avatar floats over all content, top-right corner -->
<div class="avatar-overlay">
    <UserAvatar />
</div>

<style>
    .avatar-overlay {
        position: fixed;
        top: 10px;
        right: 12px;
        z-index: 200;
    }
</style>
