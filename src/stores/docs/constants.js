/**
 * Docs sub-app constants.
 *
 * SCHEMA_VERSION is the integer (stored as a string here for parity with the
 * spreadsheet sub-app, parsed to int wherever compared) describing the docs
 * Yjs doc shape this client knows. Bump it every time a shipping migration is
 * added to `docsSchema.migrate`. See WRITING-A-SUBAPP.md.
 */

export const DOCS_SCHEMA_VERSION = '1';

/**
 * Keys used inside the top-level `metadata` Y.Map.
 *  - SYS: nested Y.Map holding system fields (schemaVersion stamp). The generic
 *         lifecycle helper reads/stamps the version at metadata.sys.schemaVersion.
 */
export const DOCS_META_KEYS = Object.freeze({
    SYS: 'sys',
    SCHEMA_VERSION: 'schemaVersion',
    CREATED_AT: 'createdAt',
    UPDATED_AT: 'updatedAt',
    TITLE: 'title',
});

/** Default page-setup values applied to a freshly initialized document (mm). */
export const DEFAULT_PAGE_SETUP = Object.freeze({
    paperSize: 'letter',
    orientation: 'portrait',
    marginTop: 25.4,
    marginBottom: 25.4,
    marginLeft: 25.4,
    marginRight: 25.4,
});
