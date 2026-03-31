/**
 * App Types - Centralized definitions for document applications.
 *
 * This module provides a single source of truth for:
 * - App identifiers and metadata
 * - Mime type to app mappings
 * - Icons and display names
 * - Default titles for new documents
 */

// App identifiers
export const APP_SHEETS = 'sheets';
export const APP_DOCS = 'docs';
export const APP_SVG = 'svg';
export const APP_FILE = 'file'; // Generic blob file type

/**
 * @typedef {object} AppTypeDefinition
 * @property {string} id - App identifier (e.g., 'sheets', 'docs')
 * @property {string} name - Display name (e.g., 'Spreadsheet', 'Document')
 * @property {string} namePlural - Plural display name (e.g., 'Spreadsheets', 'Documents')
 * @property {string} icon - Icon name from the icons module
 * @property {string} defaultTitle - Default title for new documents
 * @property {string[]} mimeTypes - Associated mime types for this app
 * @property {string} routePrefix - URL route prefix (e.g., '/sheets/')
 * @property {string} color - Primary color for the app (CSS variable or hex)
 */

/**
 * App type definitions.
 * @type {Record<string, AppTypeDefinition>}
 */
export const APP_TYPES = {
    [APP_SVG]: {
        id: APP_SVG,
        name: 'Drawing',
        namePlural: 'Drawings',
        icon: 'penTool',
        defaultTitle: 'Untitled Drawing',
        mimeTypes: [
            'image/svg+xml',
        ],
        routePrefix: '/svg/',
        color: '#f97316', // Orange for SVG drawings
    },
    [APP_SHEETS]: {
        id: APP_SHEETS,
        name: 'Spreadsheet',
        namePlural: 'Spreadsheets',
        icon: 'spreadsheet',
        defaultTitle: 'Untitled Spreadsheet',
        mimeTypes: [
            'application/vnd.plaintab.spreadsheet',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-excel',
            'text/csv',
        ],
        routePrefix: '/sheets/',
        color: 'var(--color-primary)',
    },
    [APP_DOCS]: {
        id: APP_DOCS,
        name: 'Document',
        namePlural: 'Documents',
        icon: 'fileText',
        defaultTitle: 'Untitled Document',
        mimeTypes: [
            'application/vnd.plaintab.document',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/msword',
            'text/plain',
            'text/markdown',
        ],
        routePrefix: '/docs/',
        color: '#4285f4', // Blue for docs
    },
};

/**
 * Default app type when not specified.
 * @type {string}
 */
export const DEFAULT_APP = APP_SHEETS;

/**
 * Get app type definition by ID.
 * @param {string|null|undefined} appId
 * @returns {AppTypeDefinition}
 */
export function getAppType(appId) {
    return APP_TYPES[appId ?? DEFAULT_APP] ?? APP_TYPES[DEFAULT_APP];
}

/**
 * Get the default title for a new document of the given app type.
 * @param {string|null|undefined} appId
 * @returns {string}
 */
export function getDefaultTitle(appId) {
    return getAppType(appId).defaultTitle;
}

/**
 * Get the icon name for an app type.
 * @param {string|null|undefined} appId
 * @returns {string}
 */
export function getAppIcon(appId) {
    return getAppType(appId).icon;
}

/**
 * Get the display name for an app type.
 * @param {string|null|undefined} appId
 * @param {object} [options]
 * @param {boolean} [options.plural=false] - Use plural form
 * @returns {string}
 */
export function getAppName(appId, { plural = false } = {}) {
    const app = getAppType(appId);
    return plural ? app.namePlural : app.name;
}

/**
 * Determine app type from mime type.
 * @param {string|null|undefined} mimeType
 * @returns {string} App type ID
 */
export function getAppFromMimeType(mimeType) {
    if (!mimeType) return DEFAULT_APP;

    for (const [appId, definition] of Object.entries(APP_TYPES)) {
        if (definition.mimeTypes.includes(mimeType)) {
            return appId;
        }
    }

    // Fall back to content type prefix matching
    if (mimeType.startsWith('text/') || mimeType.includes('word')) {
        return APP_DOCS;
    }
    if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || mimeType === 'text/csv') {
        return APP_SHEETS;
    }

    return DEFAULT_APP;
}

/**
 * Get the route path for a file based on its app type.
 * @param {string} appId
 * @param {string} fileId
 * @returns {string}
 */
export function getFileRoute(appId, fileId) {
    const app = getAppType(appId);
    return `/worksheets${app.routePrefix}${fileId}`;
}

/**
 * Check if an app type is valid/supported.
 * @param {string|null|undefined} appId
 * @returns {boolean}
 */
export function isValidAppType(appId) {
    return appId != null && appId in APP_TYPES;
}

/**
 * Get all supported app type IDs.
 * @returns {string[]}
 */
export function getSupportedAppTypes() {
    return Object.keys(APP_TYPES);
}

/**
 * Mime type constants for internal use.
 */
export const MIME_TYPES = {
    // Internal mime types for Yjs documents
    SHEETS_YJS: 'application/vnd.plaintab.spreadsheet',
    DOCS_YJS: 'application/vnd.plaintab.document',

    // Common external formats
    XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    XLS: 'application/vnd.ms-excel',
    CSV: 'text/csv',
    DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    DOC: 'application/msword',
    TXT: 'text/plain',
    MD: 'text/markdown',

    // Image formats
    JPEG: 'image/jpeg',
    PNG: 'image/png',
    GIF: 'image/gif',
    WEBP: 'image/webp',
    SVG: 'image/svg+xml',
    BMP: 'image/bmp',
    ICO: 'image/x-icon',

    // Video formats
    MP4: 'video/mp4',
    WEBM: 'video/webm',
    OGG: 'video/ogg',
    QUICKTIME: 'video/quicktime',

    // Audio formats
    MP3: 'audio/mpeg',
    WAV: 'audio/wav',
    OGA: 'audio/ogg',
    FLAC: 'audio/flac',
    AAC: 'audio/aac',

    // PDF
    PDF: 'application/pdf',

    // Archives
    ZIP: 'application/zip',
    RAR: 'application/vnd.rar',
    SEVEN_Z: 'application/x-7z-compressed',
    TAR: 'application/x-tar',
    GZ: 'application/gzip',

    // Code files
    JAVASCRIPT: 'application/javascript',
    TYPESCRIPT: 'application/typescript',
    JSON: 'application/json',
    HTML: 'text/html',
    CSS: 'text/css',
    XML: 'application/xml',
};

/**
 * File category definitions for blob files.
 * @type {Record<string, {name: string, icon: string, mimeTypes: string[], color: string}>}
 */
export const FILE_CATEGORIES = {
    image: {
        name: 'Image',
        icon: 'fileImage',
        mimeTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp', 'image/x-icon'],
        color: '#10b981', // Green
    },
    video: {
        name: 'Video',
        icon: 'fileVideo',
        mimeTypes: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
        color: '#8b5cf6', // Purple
    },
    audio: {
        name: 'Audio',
        icon: 'fileAudio',
        mimeTypes: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac'],
        color: '#f59e0b', // Amber
    },
    pdf: {
        name: 'PDF',
        icon: 'filePdf',
        mimeTypes: ['application/pdf'],
        color: '#ef4444', // Red
    },
    archive: {
        name: 'Archive',
        icon: 'fileArchive',
        mimeTypes: ['application/zip', 'application/vnd.rar', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip'],
        color: '#6b7280', // Gray
    },
    code: {
        name: 'Code',
        icon: 'fileCode',
        mimeTypes: ['application/javascript', 'application/typescript', 'application/json', 'text/html', 'text/css', 'application/xml'],
        color: '#3b82f6', // Blue
    },
    document: {
        name: 'Document',
        icon: 'fileText',
        mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', 'text/plain', 'text/markdown'],
        color: '#4285f4', // Blue
    },
    spreadsheet: {
        name: 'Spreadsheet',
        icon: 'spreadsheet',
        mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv'],
        color: 'var(--color-primary)',
    },
    other: {
        name: 'File',
        icon: 'file',
        mimeTypes: [],
        color: '#6b7280', // Gray
    },
};

/**
 * Get file category from mime type.
 * @param {string|null|undefined} mimeType
 * @returns {{name: string, icon: string, mimeTypes: string[], color: string}}
 */
export function getFileCategory(mimeType) {
    if (!mimeType) return FILE_CATEGORIES.other;

    for (const [_, category] of Object.entries(FILE_CATEGORIES)) {
        if (category.mimeTypes.includes(mimeType)) {
            return category;
        }
    }

    // Fall back to prefix matching
    if (mimeType.startsWith('image/')) return FILE_CATEGORIES.image;
    if (mimeType.startsWith('video/')) return FILE_CATEGORIES.video;
    if (mimeType.startsWith('audio/')) return FILE_CATEGORIES.audio;
    if (mimeType.includes('pdf')) return FILE_CATEGORIES.pdf;
    if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar') || mimeType.includes('7z') || mimeType.includes('gzip')) return FILE_CATEGORIES.archive;

    return FILE_CATEGORIES.other;
}

/**
 * Get icon name for a file based on its properties.
 * @param {object} file - File object with app, mimeType, etc.
 * @returns {string} Icon name
 */
export function getFileIcon(file) {
    if (!file) return 'file';

    // Yjs documents have their own icons
    if (file.app === APP_SHEETS) return 'spreadsheet';
    if (file.app === APP_DOCS) return 'fileText';
    if (file.app === APP_SVG) return 'penTool';

    // Blob files use category icons, but SVG files get special treatment
    if (file.type === 'blob' || file.blobKey) {
        if (file.mimeType === 'image/svg+xml' || file.name?.toLowerCase().endsWith('.svg')) {
            return 'penTool';
        }
        const category = getFileCategory(file.mimeType);
        return category.icon;
    }

    // Fall back to app icon
    return getAppIcon(file.app);
}

/**
 * Check if a file is a blob file (uploaded binary).
 * @param {object} file - File object
 * @returns {boolean}
 */
export function isBlobFile(file) {
    return file?.type === 'blob' || file?.blobKey != null;
}

/**
 * Check if a file is previewable in browser.
 * @param {object} file - File object
 * @returns {boolean}
 */
export function isPreviewable(file) {
    if (!file) return false;

    const category = getFileCategory(file.mimeType);
    return ['image', 'video', 'audio', 'pdf'].includes(
        Object.keys(FILE_CATEGORIES).find(k => FILE_CATEGORIES[k] === category)
    );
}

/**
 * Get accepted file types for upload input.
 * @returns {string} Comma-separated list of accepted mime types
 */
export function getAcceptedFileTypes() {
    const types = [];
    for (const [_, category] of Object.entries(FILE_CATEGORIES)) {
        types.push(...category.mimeTypes);
    }
    // Add wildcards for categories
    types.push('image/*', 'video/*', 'audio/*');
    return types.join(',');
}
