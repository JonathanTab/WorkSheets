/**
 * YjsServerAPI - HTTP client for the Yjs persistence server's REST API.
 *
 * Handles: listing snapshots, creating manual snapshots, fetching snapshot
 * binary data, and preparing restores (which create a new room pre-loaded
 * with the snapshot state).
 *
 * The API URL is derived from the WebSocket URL:
 *   wss://server/path  →  https://server/path
 *   ws://server/path   →  http://server/path
 */
export class YjsServerAPI {
    /**
     * @param {string} wsUrl - The Yjs WebSocket server base URL (used to derive HTTP API URL).
     * @param {() => string|null} getApiKey - Returns current Bearer token.
     */
    constructor(wsUrl, getApiKey) {
        // Derive HTTP base URL from WS URL
        this.baseUrl = wsUrl
            .replace(/^wss:\/\//, 'https://')
            .replace(/^ws:\/\//, 'http://')
            .replace(/\/?$/, '/'); // ensure trailing slash
        this.getApiKey = getApiKey;
    }

    // -------------------------------------------------------
    // Internal
    // -------------------------------------------------------

    _authHeaders() {
        const key = this.getApiKey?.();
        return key ? { 'Authorization': `Bearer ${key}` } : {};
    }

    async _get(path, params = {}) {
        const url = new URL(path, this.baseUrl);
        for (const [k, v] of Object.entries(params)) {
            if (v != null) url.searchParams.set(k, v);
        }
        const res = await fetch(url.toString(), {
            credentials: 'same-origin',
            headers: this._authHeaders(),
        });
        return this._handleResponse(res);
    }

    async _post(path, body) {
        const url = new URL(path, this.baseUrl);
        const res = await fetch(url.toString(), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...this._authHeaders(),
            },
            body: JSON.stringify(body),
        });
        return this._handleResponse(res);
    }

    async _handleResponse(res) {
        if (res.status === 401) throw new Error('AUTH_EXPIRED');
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        return res;
    }

    // -------------------------------------------------------
    // Snapshots
    // -------------------------------------------------------

    /**
     * List snapshots for a room or file.
     * @param {{ roomId?: string, fileId?: string }} opts
     * @returns {Promise<SnapshotMeta[]>}
     */
    async listSnapshots({ roomId, fileId }) {
        const params = {};
        if (roomId) params.roomId = roomId;
        else if (fileId) params.fileId = fileId;
        const res = await this._get('api/snapshots', params);
        const data = await res.json();
        return data.snapshots ?? [];
    }

    /**
     * Create a manual snapshot for an active room.
     * @param {string} roomId
     * @param {string} [description]
     * @param {string|null} [appType]  'sheets' | 'docs' | 'svg'
     * @returns {Promise<{ id: string }>}
     */
    async createSnapshot(roomId, description, appType) {
        const res = await this._post('api/snapshots', {
            roomId,
            description: description ?? null,
            appType: appType ?? null,
        });
        return res.json();
    }

    /**
     * Get last-edit metadata for a file (who changed it and when).
     * @param {string} fileId
     * @returns {Promise<{ last_edit_at: number|null, last_edit_by: string|null }>}
     */
    async getFileMeta(fileId) {
        const res = await this._get(`api/files/${encodeURIComponent(fileId)}/meta`);
        return res.json();
    }

    /**
     * Get snapshot metadata.
     * @param {string} snapshotId
     * @returns {Promise<SnapshotMeta>}
     */
    async getSnapshotMeta(snapshotId) {
        const res = await this._get(`api/snapshot/${encodeURIComponent(snapshotId)}`);
        return res.json();
    }

    /**
     * Fetch the raw Yjs state for a snapshot (Uint8Array).
     * Apply it to a Y.Doc with Y.applyUpdate(doc, data) to reconstruct the doc.
     * @param {string} snapshotId
     * @returns {Promise<Uint8Array>}
     */
    async getSnapshotData(snapshotId) {
        const res = await this._get(`api/snapshot/${encodeURIComponent(snapshotId)}/data`);
        return new Uint8Array(await res.arrayBuffer());
    }

    /**
     * Ask the server to prepare a new room pre-loaded with a snapshot's state.
     * The caller must then update the file's roomId in storage.php.
     * @param {string} snapshotId
     * @returns {Promise<{ newRoomId: string, fileId: string }>}
     */
    async prepareRestore(snapshotId) {
        const res = await this._post('api/restore', { snapshotId });
        return res.json();
    }
}

/**
 * @typedef {object} SnapshotMeta
 * @property {string}  id
 * @property {string}  file_id
 * @property {string}  room_id
 * @property {number}  created_at  Unix ms timestamp
 * @property {'auto'|'manual'|'room_empty'} trigger
 * @property {string|null} created_by  comma-separated usernames
 * @property {string|null} description
 * @property {string|null} diff_json  generic structural diff vs previous snapshot (JSON string)
 * @property {string|null} app_type   'sheets' | 'docs' | 'svg'
 */
