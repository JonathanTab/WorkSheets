import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
    base: '/worksheets/',
    plugins: [svelte(), tailwindcss(), VitePWA({
        registerType: 'autoUpdate',
        injectRegister: 'inline',

        manifest: {
            name: 'Worksheets',
            short_name: 'worksheets',
            description: 'A simple spreadsheet app',
            theme_color: '#000C3F',
            background_color: '#000C3F',
            start_url: '/worksheets/',
            scope: '/worksheets/',
            icons: [
                {
                    src: '/pwa-64x64.png',
                    sizes: '64x64',
                    type: 'image/png'
                },
                {
                    src: '/pwa-192x192.png',
                    sizes: '192x192',
                    type: 'image/png'
                },
                {
                    src: '/pwa-512x512.png',
                    sizes: '512x512',
                    type: 'image/png'
                },
                {
                    src: '/maskable-icon-512x512.png',
                    sizes: '512x512',
                    type: 'image/png',
                    purpose: 'maskable'
                }
            ],
            apple: {
                icons: [
                    {
                        src: '/apple-touch-icon-180x180.png',
                        sizes: '180x180',
                        type: 'image/png'
                    }
                ]
            }
        },

        // PWA Assets integration
        pwaAssets: {
            config: 'pwa-assets.config.js',
            overrideManifestIcons: true,
            includeHtmlHeadLinks: true,
            injectThemeColor: true
        },

        workbox: {
            globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
            cleanupOutdatedCaches: true,
            clientsClaim: true,
            skipWaiting: true,
            runtimeCaching: [
                {
                    urlPattern: /\/api\/.*/i,
                    handler: 'NetworkFirst',
                    options: {
                        cacheName: 'api-cache',
                        expiration: {
                            maxEntries: 50,
                            maxAgeSeconds: 60 * 60 // 1 hour
                        }
                    }
                },
                {
                    urlPattern: /\.(?:js|css)$/,
                    handler: 'StaleWhileRevalidate',
                    options: {
                        cacheName: 'critical-assets',
                        expiration: {
                            maxEntries: 100,
                            maxAgeSeconds: 60 * 60 * 24 // 1 day
                        }
                    }
                },
                {
                    urlPattern: /\.(?:html|svg|png|ico)$/,
                    handler: 'CacheFirst',
                    options: {
                        cacheName: 'static-assets',
                        expiration: {
                            maxEntries: 100,
                            maxAgeSeconds: 60 * 60 * 24 * 7 // 1 week
                        }
                    }
                },
                {
                    urlPattern: /\.(?:json)$/,
                    handler: 'StaleWhileRevalidate',
                    options: {
                        cacheName: 'dynamic-content',
                        expiration: {
                            maxEntries: 50,
                            maxAgeSeconds: 60 * 60 * 24 * 7 // 1 week
                        }
                    }
                }
            ],
            offlineGoogleAnalytics: true
        },

        devOptions: {
            enabled: false,
            navigateFallback: 'index.html',
            suppressWarnings: true,
            type: 'module',
        },
    })],
})
