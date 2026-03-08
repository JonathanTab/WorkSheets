#!/usr/bin/env node
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = join(__dirname, '..')

console.log('Generating PWA assets...')

try {
    // Use the CLI tool with our configuration
    execSync(
        `npx @vite-pwa/assets-generator --config pwa-assets.config.js`,
        {
            cwd: rootDir,
            stdio: 'inherit'
        }
    )
    console.log('PWA assets generation completed!')
} catch (error) {
    console.error('Failed to generate PWA assets:', error.message)
    process.exit(1)
}