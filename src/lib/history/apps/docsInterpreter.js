import { registerDiffInterpreter } from '../diffInterpreters.js';

registerDiffInterpreter('docs', (diff) => {
    const entries = diff.entries ?? [];
    let inserted = 0, deleted = 0;

    for (const e of entries) {
        if (e.type === 'text') {
            inserted += e.inserted ?? 0;
            deleted  += e.deleted  ?? 0;
        }
    }

    if (inserted === 0 && deleted === 0) return { summary: 'No changes', changeCount: 0 };

    const wordsAdded   = Math.round(inserted / 5);
    const wordsRemoved = Math.round(deleted / 5);
    const parts = [];
    if (wordsAdded > 0)   parts.push(`~${wordsAdded} word${wordsAdded !== 1 ? 's' : ''} added`);
    if (wordsRemoved > 0) parts.push(`~${wordsRemoved} word${wordsRemoved !== 1 ? 's' : ''} removed`);

    return { summary: parts.join(', '), changeCount: wordsAdded + wordsRemoved };
});
