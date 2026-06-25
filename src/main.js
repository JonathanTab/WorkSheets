import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import ModalRoot from './lib/ui/ModalRoot.svelte'
import { installScrollBench } from './stores/spreadsheet/perf/scrollBench.js'

// Register the scripted scroll benchmark on window.__spreadsheetPerf so it's
// callable from DevTools: await window.__spreadsheetPerf.scrollBench()
installScrollBench()

const app = mount(App, {
    target: document.getElementById('app'),
})

const modalRoot = mount(ModalRoot, {
    target: document.getElementById('modal-host'),
})

export default app
