import * as Y from 'yjs';

/**
 * SchemaManager - Handles document schema initialization and data migration.
 *
 * This class is responsible for ensuring that a Y.Doc is correctly initialized
 * with its expected shared types, and for migrating data between different
 * schema versions when necessary.
 */
export class SchemaManager {
    /**
     * @param {import('../types').SchemaDefinition[]} schemas - Registered schema versions.
     */
    constructor(schemas) {
        this.schemas = new Map(schemas.map(s => [s.version, s]));
        this.versions = schemas.map(s => s.version);
    }

    /**
     * @param {string} version
     * @returns {import('../types').SchemaDefinition|null}
     */
    getSchema(version) {
        return this.schemas.get(version) || null;
    }

    /**
     * Finds the most recent available version that can serve as a migration source.
     *
     * @param {string} targetVersion - The version we want to reach.
     * @param {Object.<string, string>} availableVersions - Map of version -> roomId for a doc.
     * @returns {string|null} The version string to migrate from, or null if no source found.
     */
    findMigrationSource(targetVersion, availableVersions) {
        const targetIndex = this.versions.indexOf(targetVersion);
        if (targetIndex <= 0) return null;

        // Search backwards from the target version
        for (let i = targetIndex - 1; i >= 0; i--) {
            const ver = this.versions[i];
            if (availableVersions[ver]) {
                return ver;
            }
        }
        return null;
    }

    /**
     * Performs initial schema setup on a Y.Doc (e.g. creating default shared types).
     *
     * This method is idempotent - the schema's initialize function should use
     * ydoc.get() to retrieve shared types, which returns existing types if they
     * already exist. This ensures that calling initialize multiple times is safe.
     *
     * Note: We intentionally do NOT check ydoc.store.clients.size because:
     * 1. A fresh Y.Doc always has at least one client entry (the local client)
     * 2. This makes the check always true, even for empty documents
     * 3. The idempotent design of schema.initialize() handles re-initialization
     *
     * @param {string} version
     * @param {import('yjs').Doc} ydoc
     */
    initialize(version, ydoc) {
        const schema = this.getSchema(version);
        if (schema?.initialize) {
            console.log('[SchemaManager] Initializing document with schema version:', version);
            schema.initialize(ydoc);
        }
    }

    /**
     * Migrates data from an old document to a new one.
     *
     * First, it copies the raw state update from the old doc to the new doc.
     * Then, it runs the specific `migrate` function defined in the schema if it exists.
     *
     * @param {string} targetVersion
     * @param {import('yjs').Doc} oldDoc
     * @param {import('yjs').Doc} newDoc
     */
    async migrate(targetVersion, oldDoc, newDoc) {
        const schema = this.getSchema(targetVersion);

        // Clone state: encode old, apply to new
        const update = Y.encodeStateAsUpdate(oldDoc);
        Y.applyUpdate(newDoc, update);

        if (schema?.migrate) {
            await schema.migrate(newDoc);
        }
    }
}
