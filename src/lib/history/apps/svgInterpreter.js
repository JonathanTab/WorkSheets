import { registerDiffInterpreter } from '../diffInterpreters.js';

registerDiffInterpreter('svg', (diff) => {
    const entries = diff.entries ?? [];
    let added = 0, removed = 0, modified = 0;

    for (const e of entries) {
        // SVG elements are typically in a top-level Y.Array or Y.Map named 'elements'
        if (e.path?.[0] === 'elements' || e.path?.[1] === 'elements') {
            added    += e.added ?? 0;
            removed  += e.removed ?? 0;
            modified += e.modified ?? 0;
            if (e.delta > 0) added    += e.delta;
            if (e.delta < 0) removed  += -e.delta;
        }
    }

    if (added === 0 && removed === 0 && modified === 0) return { summary: 'No changes', changeCount: 0 };

    const parts = [];
    if (added > 0)    parts.push(`${added} shape${added !== 1 ? 's' : ''} added`);
    if (removed > 0)  parts.push(`${removed} shape${removed !== 1 ? 's' : ''} removed`);
    if (modified > 0) parts.push(`${modified} shape${modified !== 1 ? 's' : ''} modified`);

    const total = added + removed + modified;
    return { summary: parts.join(', '), changeCount: total };
});
