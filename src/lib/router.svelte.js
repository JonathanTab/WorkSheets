import { APP_SHEETS, APP_DOCS, APP_SVG, DEFAULT_APP } from './appTypes.js';

/**
 * Client-side router for the /scriptorium/ SPA.
 *
 * Routes:
 *   /scriptorium/              → { view: 'browser' }
 *   /scriptorium/sheets/<id>   → { view: 'sheets', docId: '<id>' }
 *   /scriptorium/docs/<id>     → { view: 'docs',   docId: '<id>' }
 *   /scriptorium/svg/<id>      → { view: 'svg',    docId: '<id>' }
 *
 * view names match APP_SHEETS / APP_DOCS / APP_SVG constants from appTypes.js.
 */

const BASE = '/scriptorium';

function parsePath(pathname) {
    let path = pathname.startsWith(BASE)
        ? pathname.slice(BASE.length) || '/'
        : '/';

    if (!path.startsWith('/')) path = '/' + path;

    // strip trailing slash except root
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

    const sheetsMatch = path.match(/^\/sheets\/([^/?#]+)/);
    if (sheetsMatch) return { view: APP_SHEETS, docId: sheetsMatch[1] };

    const docsMatch = path.match(/^\/docs\/([^/?#]+)/);
    if (docsMatch) return { view: APP_DOCS, docId: docsMatch[1] };

    const svgMatch = path.match(/^\/svg\/([^/?#]+)/);
    if (svgMatch) return { view: APP_SVG, docId: svgMatch[1] };

    const folderMatch = path.match(/^\/drive\/folder\/([^/?#]+)/);
    if (folderMatch) return { view: 'browser', tab: 'drive', folderId: folderMatch[1] };

    if (path === '/drive') return { view: 'browser', tab: 'drive', folderId: null };
    if (path === '/recent') return { view: 'browser', tab: 'recent', folderId: null };
    if (path === '/shared') return { view: 'browser', tab: 'shared', folderId: null };
    if (path === '/trash') return { view: 'browser', tab: 'trash', folderId: null };

    return { view: 'browser', tab: 'recent', folderId: null };
}

let _route = $state(parsePath(window.location.pathname));

/**
 * The last file-manager location the user was at this session ({ tab, folderId }),
 * or null if they've never been in the browser (e.g. opened a file via deep link).
 * Used by goBack() to return to where the user came from. Not reactive — it isn't rendered.
 */
let _lastBrowserLocation = null;

/** Record the current route as the last browser location, if it is a browser view. */
function rememberBrowserLocation() {
    if (_route.view === 'browser') {
        _lastBrowserLocation = { tab: _route.tab ?? 'recent', folderId: _route.folderId ?? null };
    }
}

// Seed from the initial route (covers landing directly on a browser URL).
rememberBrowserLocation();

export const router = {
    get route() { return _route; },

    /** Navigate to a path relative to /scriptorium (e.g. '/sheets/abc123') */
    navigate(subpath, { replace = false } = {}) {
        const fullPath = BASE + subpath;
        if (replace) {
            history.replaceState({}, '', fullPath);
        } else {
            history.pushState({}, '', fullPath);
        }
        _route = parsePath(window.location.pathname);
        rememberBrowserLocation();
    },

    /**
     * Go back from a sub-app to the most sensible file-manager location.
     * Priority:
     *   1. The browser location the user navigated from this session (tab + folder).
     *   2. The folder the file lives in (drive root if it has no folder), when known.
     *   3. The recent-files home.
     * Any drive-folder target that no longer exists (e.g. deleted while editing) is
     * dropped to the drive root instead of leaving a stale, empty folder view.
     * @param {object} [opts]
     * @param {{ folderId?: string|null }} [opts.file] - the file being closed, if available
     * @param {(folderId: string) => boolean} [opts.folderExists] - predicate to validate a folder still exists
     */
    goBack({ file, folderExists } = {}) {
        // Drop a folder target to the drive root if it no longer exists.
        const resolveFolder = (folderId) =>
            folderId && folderExists && !folderExists(folderId) ? null : folderId;

        if (_lastBrowserLocation) {
            const { tab, folderId } = _lastBrowserLocation;
            this.navigateBrowser(tab, tab === 'drive' ? resolveFolder(folderId) : folderId);
        } else if (file) {
            this.navigateBrowser('drive', resolveFolder(file.folderId ?? null));
        } else {
            this.navigate('/recent');
        }
    },

    /** @deprecated Use goBack() instead */
    goHome() {
        this.goBack();
    },

    /** Open a spreadsheet document */
    openSheet(docId) {
        this.navigate(`/sheets/${docId}`);
    },

    /** Open a doc document */
    openDoc(docId) {
        this.navigate(`/docs/${docId}`);
    },

    /** Open an SVG drawing */
    openSvg(docId) {
        this.navigate(`/svg/${docId}`);
    },

    /** Navigate to a browser tab (recent, drive, shared, trash) with optional folder */
    navigateBrowser(tab, folderId = null) {
        if (tab === 'drive' && folderId) {
            this.navigate(`/drive/folder/${folderId}`);
        } else if (tab === 'drive') {
            this.navigate('/drive');
        } else if (tab === 'shared') {
            this.navigate('/shared');
        } else if (tab === 'trash') {
            this.navigate('/trash');
        } else {
            this.navigate('/recent');
        }
    },

    /** Open a file based on its app type */
    openFile(file) {
        const app = file.app ?? DEFAULT_APP;
        if (app === APP_DOCS) {
            this.openDoc(file.id);
        } else if (app === APP_SVG) {
            this.openSvg(file.id);
        } else {
            this.openSheet(file.id);
        }
    },
};

// Handle browser back/forward
window.addEventListener('popstate', () => {
    _route = parsePath(window.location.pathname);
    rememberBrowserLocation();
});
