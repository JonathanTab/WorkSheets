# Worksheets

A project using vite + vitePWA + svelte + yJS.
A spreadsheet app with streamlined, offline tolerant usage.

## Development

### Building for Development
For regular development builds (fast builds):
```bash
npm run build
```

### Building for Production/PWA Deployment
To generate PWA assets and build for production:
```bash
npm run build:pwa
```

This will:
1. Generate all PWA assets (icons, splash screens, etc.)
2. Build the application with PWA features

### Asset Generation
PWA assets are generated separately to speed up development builds. Run this when you need to update icons or splash screens:
```bash
npm run generate-assets
```

**Note:** Generated PWA assets are gitignored. Only the source icon (`public/icon2048.png`) is committed to version control.
