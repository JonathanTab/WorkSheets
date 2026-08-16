import { forceUpdate } from '../schemaVersionGuard.js';
import { refresh } from '../icons/index.js';

/** Shared UserMenu item that checks for a new service worker and reloads. */
export const updateMenuItem = {
    label: 'Check for updates',
    icon: refresh,
    action: forceUpdate,
};
