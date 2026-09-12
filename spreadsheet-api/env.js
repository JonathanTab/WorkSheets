/**
 * env.js — load spreadsheet-api/.env into process.env.
 *
 * This is a module of its own, and a side-effect one at that, purely for
 * ordering. ESM evaluates imports in source order, so anything that reads
 * process.env at module scope — auth.js resolving INSTRUMENTA_AUTH_LIB, and the
 * config block in server.js — has to be imported *after* this, and previously
 * the loader lived inside server.js's body, which runs too late for any of
 * them. Import this first.
 *
 * Existing variables win, so the real environment (pm2, a shell export, a test
 * harness) overrides the file rather than the other way round.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir = path.dirname(fileURLToPath(import.meta.url));

try {
    const envText = readFileSync(path.join(__dir, '.env'), 'utf8');
    for (const line of envText.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
} catch { /* .env is optional */ }
