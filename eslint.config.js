import svelte from 'eslint-plugin-svelte';
import globals from 'globals';

export default [
    // Svelte parser support (base config — no extra rules, just parsing)
    ...svelte.configs['flat/base'],

    {
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },

    // ── Phase 8 rules ─────────────────────────────────────────────────────────
    // These are the three patterns the audit flagged. New code should not add
    // violations; existing violations should be fixed incrementally.

    {
        files: ['src/**/*.{js,svelte}'],
        rules: {
            // Ban raw console.* — use a centralised log wrapper instead.
            'no-console': 'warn',

            // Ban document.querySelector/getElementById inside Svelte files
            // and the JSON.parse(JSON.stringify(…)) deep-clone pattern.
            'no-restricted-syntax': [
                'warn',
                {
                    // JSON.parse(JSON.stringify(expr)) — the inner call is the
                    // direct callee argument of the outer call.
                    selector:
                        'CallExpression[callee.object.name="JSON"][callee.property.name="parse"] > CallExpression[callee.object.name="JSON"][callee.property.name="stringify"]',
                    message:
                        'Use structuredClone() or a dedicated deepClone utility instead of JSON.parse(JSON.stringify(…)).',
                },
                {
                    selector:
                        'CallExpression[callee.type="MemberExpression"][callee.object.name="document"][callee.property.name=/^(querySelector|getElementById)$/]',
                    message:
                        'Avoid document.querySelector/getElementById in Svelte components. Use bind:this or a Svelte action instead.',
                },
            ],
        },
    },

    // main.js legitimately uses querySelector for the app mount points.
    {
        files: ['src/main.js'],
        rules: { 'no-restricted-syntax': 'off' },
    },

    {
        ignores: ['dist/**', 'node_modules/**', 'scripts/**'],
    },
];
