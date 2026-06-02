/**
 * HoramConnector — reads a horam Yjs doc and computes time totals.
 *
 * Horam doc structure:
 *   projects: Y.Array[ Y.Map{
 *     id: string,
 *     title: string,
 *     tags: Y.Array<string>,
 *     trackingSessions: Y.Array[ Y.Map{ tag, start, end, userId } ]
 *   }]
 */

import { loadHoramDoc, listHoramDocs } from './horamStorage.js';

/**
 * Return all projects from a horam doc as plain objects.
 * @param {import('yjs').Doc} ydoc
 * @returns {Array<{id:string, title:string, tags:string[], sessions:Array}>}
 */
export function extractProjects(ydoc) {
    const yProjects = ydoc.getArray('projects');
    return yProjects.toArray().map(p => ({
        id:       p.get('id'),
        title:    p.get('title') ?? '(untitled)',
        tags:     p.get('tags')?.toArray() ?? [],
        sessions: (p.get('trackingSessions')?.toArray() ?? []).map(s => ({
            tag:    s.get('tag')    ?? '',
            start:  s.get('start') ?? 0,
            end:    s.get('end')   ?? null,
            userId: s.get('userId') ?? '',
        })),
    }));
}

/**
 * Collect all unique tags that appear in trackingSessions across all projects.
 * @param {Array} projects  output of extractProjects()
 * @returns {string[]}
 */
export function collectSessionTags(projects) {
    const tags = new Set();
    for (const p of projects) {
        for (const s of p.sessions) {
            if (s.tag) tags.add(s.tag);
        }
    }
    return [...tags].sort();
}

/**
 * Compute total tracked milliseconds per userId.
 *
 * Only completed sessions (end !== null) that overlap the given range are included.
 * Sessions are clamped to [startMs, endMs].
 *
 * @param {Array}    projects         output of extractProjects()
 * @param {number}   startMs          range start (epoch ms), inclusive
 * @param {number}   endMs            range end (epoch ms), inclusive
 * @param {string[]} excludedProjectIds
 * @param {string[]} excludedTags
 * @returns {Map<string, number>}  userId → milliseconds
 */
export function computeTotals(projects, startMs, endMs, excludedProjectIds = [], excludedTags = []) {
    const totals = new Map();

    for (const project of projects) {
        if (excludedProjectIds.includes(project.id)) continue;

        for (const session of project.sessions) {
            if (session.end === null) continue; // skip active/open session
            if (excludedTags.includes(session.tag)) continue;
            // Include session if it completed within [startMs, endMs].
            // Clamp the counted start so only time from period start onwards is counted
            // (handles sessions that began before the period).
            if (session.end < startMs || session.end > endMs) continue;

            const countedStart = Math.max(session.start, startMs);
            const duration     = Math.max(0, session.end - countedStart);

            totals.set(session.userId, (totals.get(session.userId) ?? 0) + duration);
        }
    }

    return totals;
}

/** ms → decimal hours, rounded to 2 dp */
export function msToHours(ms) {
    return Math.round((ms / 3_600_000) * 100) / 100;
}

/**
 * Load a horam doc and return its projects + available tags.
 * @param {string} docId
 * @returns {Promise<{ydoc, projects, sessionTags}>}
 */
export async function loadHoramDocData(docId) {
    const ydoc     = await loadHoramDoc(docId);
    const projects = extractProjects(ydoc);
    const sessionTags = collectSessionTags(projects);
    return { ydoc, projects, sessionTags };
}

/** List horam docs available to the current user. */
export { listHoramDocs };
