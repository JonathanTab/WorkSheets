/**
 * OfflineMutationQueue - Queues metadata mutations when offline, replays when online.
 *
 * Supported mutation types:
 *   create_file, create_blob, rename_file, delete_file, restore_file, move_file, set_parent
 *   create_folder, rename_folder, delete_folder, move_folder
 *   record_open  (fire-and-forget; skipped on error without retry)
 *
 * Optimistic updates are applied by the caller before enqueueing.
 * On flush, mutations are replayed in createdAt order.
 * Leader election via Web Locks ensures only one tab/app flushes at a time.
 *
 * After a successful flush the 'flushed' BroadcastChannel message tells other
 * open apps to trigger a sync so their in-memory state reflects server truth.
 */
export class OfflineMutationQueue {
    /**
     * @param {object} opts
     * @param {string} opts.username
     * @param {import('./OfflineSyncStore.js').OfflineSyncStore} opts.store
     * @param {import('../api/StorageAPI.js').StorageAPI} opts.api
     * @param {(file: object) => void} opts.onFileUpdate   - called when server confirms a mutation
     * @param {(folder: object) => void} opts.onFolderUpdate
     */
    constructor({ username, store, api, onFileUpdate, onFolderUpdate }) {
        this._username      = username;
        this._store         = store;
        this._api           = api;
        this._onFileUpdate  = onFileUpdate;
        this._onFolderUpdate = onFolderUpdate;
        this._flushing      = false;

        this._channel = typeof BroadcastChannel !== 'undefined'
            ? new BroadcastChannel(`fileregistry_mutations_${username}`)
            : null;
    }

    // -------------------------------------------------------
    // Public API
    // -------------------------------------------------------

    /**
     * Persist a mutation for later replay.
     * The caller is responsible for applying an optimistic update before calling this.
     * @param {string} type - Mutation type string
     * @param {object} payload - Operation arguments
     * @returns {Promise<string>} mutation id
     */
    async enqueue(type, payload) {
        const mutation = {
            id:        crypto.randomUUID(),
            type,
            payload,
            createdAt: new Date().toISOString(),
            attempts:  0,
            lastError: null,
        };
        await this._store.addMutation(mutation);
        return mutation.id;
    }

    /**
     * Flush all pending mutations to the server in creation order.
     * Uses Web Locks so only one tab/app flushes at a time.
     * Safe to call multiple times concurrently.
     */
    async flush() {
        if (!navigator.onLine) return;
        if (this._flushing) return;
        this._flushing = true;

        const doFlush = async () => {
            const mutations = await this._store.getAllMutations();
            if (mutations.length === 0) return;

            let flushedAny = false;
            for (const m of mutations) {
                if (!navigator.onLine) break;
                try {
                    await this._replayMutation(m);
                    await this._store.removeMutation(m.id);
                    flushedAny = true;
                } catch (err) {
                    const updated = { ...m, attempts: m.attempts + 1, lastError: err.message };
                    await this._store.addMutation(updated);

                    if (err.message === 'AUTH_EXPIRED') break;

                    if (m.type === 'record_open') {
                        // Non-critical: skip without retry
                        await this._store.removeMutation(m.id);
                        continue;
                    }

                    if (m.type.startsWith('create_') && m.attempts < 3) {
                        // Creates are critical — stop and retry later
                        break;
                    }

                    // For non-create mutations on conflict/not-found errors: skip and continue
                    if (err.message.startsWith('HTTP_40') || err.message.includes('not found')) {
                        await this._store.removeMutation(m.id);
                        continue;
                    }

                    // Server error or network — stop for now
                    break;
                }
            }

            if (flushedAny) {
                this._channel?.postMessage({ type: 'flushed' });
            }
        };

        try {
            if ('locks' in navigator) {
                await navigator.locks.request(
                    `fileregistry_mutations_${this._username}`,
                    { ifAvailable: true },
                    async (lock) => {
                        if (!lock) return; // Another tab is already flushing
                        await doFlush();
                    }
                );
            } else {
                await doFlush();
            }
        } finally {
            this._flushing = false;
        }
    }

    /** @returns {Promise<boolean>} */
    async hasPending() {
        const all = await this._store.getAllMutations();
        return all.length > 0;
    }

    shutdown() {
        this._channel?.close();
        this._channel = null;
    }

    // -------------------------------------------------------
    // Internal
    // -------------------------------------------------------

    async _replayMutation(m) {
        const p = m.payload;
        let result;

        switch (m.type) {
            case 'create_file':
                result = await this._api.createFile(p);
                // Merge server-authoritative descriptor (timestamps, etc.)
                this._onFileUpdate(result);
                break;

            case 'create_blob': {
                // Step 1: create metadata on server (idempotent via client ID)
                const { blob: _ignored, ...fileOpts } = p;
                result = await this._api.createFile(fileOpts);
                // Step 2: upload the blob content from pending store
                const pending = await this._store.getPendingBlob(p.id);
                if (pending?.blob) {
                    await this._api.uploadBlob(result.id, pending.blob);
                    await this._store.removePendingBlob(p.id);
                }
                this._onFileUpdate(result);
                break;
            }

            case 'rename_file':
                result = await this._api.renameFile(p.id, p.title);
                this._onFileUpdate(result);
                break;

            case 'delete_file':
                await this._api.deleteFile(p.id);
                break;

            case 'restore_file':
                result = await this._api.restoreFile(p.id);
                this._onFileUpdate(result);
                break;

            case 'move_file':
                result = await this._api.moveFile(p.id, p.targetFolderId);
                this._onFileUpdate(result);
                break;

            case 'set_parent':
                result = await this._api.setParent(p.id, p.parentId);
                this._onFileUpdate(result);
                break;

            case 'create_folder':
                result = await this._api.createFolder(p);
                this._onFolderUpdate(result);
                break;

            case 'rename_folder':
                result = await this._api.renameFolder(p.id, p.name);
                this._onFolderUpdate(result);
                break;

            case 'delete_folder':
                await this._api.deleteFolder(p.id);
                break;

            case 'move_folder':
                result = await this._api.moveFolder(p.id, p.targetParentId);
                this._onFolderUpdate(result);
                break;

            case 'record_open':
                await this._api.recordOpen(p.fileId, p.appName);
                break;

            default:
                console.warn('[OfflineMutationQueue] Unknown mutation type:', m.type);
        }
    }
}
