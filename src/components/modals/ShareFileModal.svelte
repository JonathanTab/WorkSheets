<script>
    import { storage } from "../../stores/storage.js";
    import { closeTopModal } from "../../lib/ui/modalStore.svelte.js";
    import Button from "../../lib/ui/Button.svelte";
    import ModalHeader from "../../lib/ui/ModalHeader.svelte";

    /** @type {{ file: import('../../lib/FileRegistry/FileRegistry.js').FileDescriptor }} */
    let { file } = $props();

    const trashSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    const checkSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
    const linkSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>`;

    // Live copy so we can show optimistic UI
    let currentFile = $state({ ...file });
    let allUsers = $state([]);
    let addUsername = $state("");
    let addPerm = $state("read");
    let addError = $state("");
    let saving = $state(false);
    let userSearch = $state("");

    // Load users once on mount
    $effect(() => {
        storage.users
            .list()
            .then((u) => {
                allUsers = u;
            })
            .catch(() => {});
        // Keep currentFile in sync with drive store
        const unsub = storage.drive.files.subscribe((files) => {
            const updated = files.find((f) => f.id === file.id);
            if (updated) currentFile = { ...updated };
        });
        return unsub;
    });

    let filteredUsers = $derived.by(() => {
        const q = userSearch.toLowerCase();
        const existing = new Set(
            currentFile.sharedWith?.map((s) => s.username) ?? [],
        );
        const me = storage._options?.getUsername?.() ?? "";
        return allUsers.filter(
            (u) =>
                u.username !== me &&
                !existing.has(u.username) &&
                (u.username.toLowerCase().includes(q) ||
                    u.displayName?.toLowerCase().includes(q)),
        );
    });

    function selectUser(username) {
        addUsername = username;
        userSearch = username;
    }

    async function addShare() {
        if (!addUsername.trim()) {
            addError = "Enter a username";
            return;
        }
        addError = "";
        saving = true;
        try {
            const perms = addPerm === "write" ? ["read", "write"] : ["read"];
            const updated = await storage.drive.shareFile(
                currentFile.id,
                addUsername.trim(),
                perms,
            );
            currentFile = { ...updated };
            addUsername = "";
            userSearch = "";
        } catch (e) {
            addError = e.message || "Failed to share";
        } finally {
            saving = false;
        }
    }

    async function revokeShare(username) {
        saving = true;
        try {
            const updated = await storage.drive.revokeFile(
                currentFile.id,
                username,
            );
            currentFile = { ...updated };
        } catch (e) {
            console.error("Revoke failed:", e);
        } finally {
            saving = false;
        }
    }

    async function togglePublicRead() {
        saving = true;
        try {
            const updated = await storage.drive.setFilePublic(
                currentFile.id,
                !currentFile.publicRead,
                currentFile.publicWrite,
            );
            currentFile = { ...updated };
        } finally {
            saving = false;
        }
    }

    async function togglePublicWrite() {
        saving = true;
        try {
            const updated = await storage.drive.setFilePublic(
                currentFile.id,
                currentFile.publicRead,
                !currentFile.publicWrite,
            );
            currentFile = { ...updated };
        } finally {
            saving = false;
        }
    }

    function copyLink() {
        const url = `${location.origin}${location.pathname}#${currentFile.id}`;
        navigator.clipboard?.writeText(url).catch(() => {});
    }

    function permLabel(share) {
        return share.permissions?.includes("write") ? "Can edit" : "Can view";
    }
</script>

<ModalHeader title={'Share "' + (currentFile.title || "Untitled") + '"'} />

<div class="share-modal">
    <!-- Current owner -->
    <div class="owner-row">
        <div class="avatar">{(currentFile.owner ?? "?")[0].toUpperCase()}</div>
        <div class="owner-info">
            <span class="owner-name">{currentFile.owner}</span>
            <span class="owner-badge">Owner</span>
        </div>
    </div>

    <!-- Existing shares -->
    {#if currentFile.sharedWith?.length > 0}
        <div class="section">
            <p class="section-label">Shared with</p>
            {#each currentFile.sharedWith as share (share.username)}
                <div class="share-row">
                    <div class="avatar sm">
                        {share.username[0].toUpperCase()}
                    </div>
                    <span class="share-user">{share.username}</span>
                    <span class="share-perm">{permLabel(share)}</span>
                    <button
                        class="revoke-btn"
                        title="Remove"
                        onclick={() => revokeShare(share.username)}
                        disabled={saving}
                    >
                        {@html trashSvg}
                    </button>
                </div>
            {/each}
        </div>
    {/if}

    <!-- Add share -->
    <div class="section">
        <p class="section-label">Add people</p>
        <div class="add-row">
            <div class="user-input-wrap">
                <input
                    class="user-input"
                    type="text"
                    placeholder="Search by username…"
                    bind:value={userSearch}
                    oninput={() => {
                        addUsername = userSearch;
                        addError = "";
                    }}
                />
                {#if userSearch && filteredUsers.length > 0}
                    <div class="user-dropdown">
                        {#each filteredUsers.slice(0, 6) as u (u.username)}
                            <button
                                class="user-option"
                                onclick={() => selectUser(u.username)}
                            >
                                <div class="avatar sm">
                                    {u.username[0].toUpperCase()}
                                </div>
                                <div>
                                    <div class="opt-name">
                                        {u.displayName || u.username}
                                    </div>
                                    {#if u.displayName}<div class="opt-sub">
                                            @{u.username}
                                        </div>{/if}
                                </div>
                            </button>
                        {/each}
                    </div>
                {/if}
            </div>
            <select class="perm-select" bind:value={addPerm}>
                <option value="read">Can view</option>
                <option value="write">Can edit</option>
            </select>
            <Button size="sm" loading={saving} onclick={addShare}>Share</Button>
        </div>
        {#if addError}
            <p class="error-msg">{addError}</p>
        {/if}
    </div>

    <div class="separator"></div>

    <!-- Public access -->
    <div class="section">
        <p class="section-label">Link sharing</p>
        <label class="toggle-row">
            <input
                type="checkbox"
                checked={currentFile.publicRead}
                onchange={togglePublicRead}
                disabled={saving}
            />
            <span>Anyone with the link can view</span>
        </label>
        {#if currentFile.publicRead}
            <label class="toggle-row">
                <input
                    type="checkbox"
                    checked={currentFile.publicWrite}
                    onchange={togglePublicWrite}
                    disabled={saving}
                />
                <span>Anyone with the link can edit</span>
            </label>
            <Button
                variant="secondary"
                size="sm"
                icon={linkSvg}
                iconPosition="left"
                onclick={copyLink}
            >
                Copy link
            </Button>
        {/if}
    </div>

    <div class="dialog-footer">
        <Button variant="secondary" onclick={closeTopModal}>Done</Button>
    </div>
</div>

<style>
    .share-modal {
        padding: 12px 16px 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        max-height: 70vh;
        overflow-y: auto;
    }

    .owner-row {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .avatar {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        background: var(--color-primary);
        color: white;
        font-weight: 600;
        font-size: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
    }

    .avatar.sm {
        width: 20px;
        height: 20px;
        font-size: 11px;
    }

    .owner-info {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .owner-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--color-text);
    }
    .owner-badge {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 5px;
        border-radius: 3px;
        background: var(--color-fill);
        color: var(--color-text-muted);
    }

    .section-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
        margin: 0 0 6px 0;
    }

    .share-row {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 0;
    }

    .share-user {
        flex: 1;
        font-size: 13px;
        color: var(--color-text);
    }
    .share-perm {
        font-size: 12px;
        color: var(--color-text-muted);
    }

    .revoke-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border: none;
        border-radius: 3px;
        background: transparent;
        color: var(--color-text-muted);
        cursor: pointer;
        padding: 0;
    }

    .revoke-btn :global(svg) {
        width: 12px;
        height: 12px;
    }
    .revoke-btn:hover {
        background: var(--color-fill);
        color: #ef4444;
    }
    .revoke-btn:disabled {
        opacity: 0.4;
        pointer-events: none;
    }

    .add-row {
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .user-input-wrap {
        position: relative;
        flex: 1;
    }

    .user-input {
        width: 100%;
        padding: 4px 8px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 13px;
        outline: none;
    }

    .user-input:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 2px var(--color-focus-ring);
    }

    .user-dropdown {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 0;
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: 4px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
        z-index: 100;
        overflow: hidden;
    }

    .user-option {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 6px 8px;
        border: none;
        background: transparent;
        cursor: pointer;
        text-align: left;
    }

    .user-option:hover {
        background: var(--color-fill);
    }

    .opt-name {
        font-size: 13px;
        color: var(--color-text);
        font-weight: 500;
    }
    .opt-sub {
        font-size: 11px;
        color: var(--color-text-muted);
    }

    .perm-select {
        padding: 4px 6px;
        border: 1px solid var(--color-border);
        border-radius: 4px;
        background: var(--color-surface);
        color: var(--color-text);
        font-size: 12px;
        cursor: pointer;
        outline: none;
    }

    .error-msg {
        font-size: 12px;
        color: #ef4444;
        margin: 4px 0 0 0;
    }

    .separator {
        height: 1px;
        background: var(--color-border);
    }

    .toggle-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        color: var(--color-text);
        cursor: pointer;
        padding: 3px 0;
    }

    .dialog-footer {
        display: flex;
        justify-content: flex-end;
        padding-top: 8px;
    }
</style>
