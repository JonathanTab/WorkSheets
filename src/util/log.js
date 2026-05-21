/**
 * log.js — Application logger.
 *
 * - In development (import.meta.env.DEV): debug/info output is visible.
 * - In production: debug/info is a no-op; warn and error always emit.
 *
 * Usage:
 *   import { log } from '../util/log.js';
 *   log.debug('[MyModule] thing happened', value);
 *   log.warn('[MyModule] unexpected state', state);
 *   log.error('[MyModule] critical failure', err);
 *
 * This module exists so we can silence debug noise in production without
 * hunting down every `console.log` call. Replace raw `console.*` calls
 * in application code with `log.*`.
 */

const isDev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV;

export const log = {
    /** Debug output — only visible in dev mode. */
    debug: isDev ? console.log.bind(console) : () => {},
    /** Informational — only visible in dev mode. */
    info:  isDev ? console.info.bind(console) : () => {},
    /** Warnings — always visible. */
    warn:  console.warn.bind(console),
    /** Errors — always visible. */
    error: console.error.bind(console),
};
