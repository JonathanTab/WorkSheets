import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import ModalRoot from './lib/ui/ModalRoot.svelte'
import { installScrollBench } from './stores/spreadsheet/perf/scrollBench.js'
import { syncServiceWorkerRegistration } from './lib/FileRegistry/offlineMode.js'

// Register the scripted scroll benchmark on window.__spreadsheetPerf so it's
// callable from DevTools: await window.__spreadsheetPerf.scrollBench()
installScrollBench()

// Only install the PWA service worker (and its caches) when offline mode is
// on; otherwise tear down any prior registration so the app always loads
// fresh from the network.
syncServiceWorkerRegistration()

const app = mount(App, {
    target: document.getElementById('app'),
})

const modalRoot = mount(ModalRoot, {
    target: document.getElementById('modal-host'),
})

export default app
