import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import ModalRoot from './lib/ui/ModalRoot.svelte'

const app = mount(App, {
    target: document.getElementById('app'),
})

const modalRoot = mount(ModalRoot, {
    target: document.getElementById('modal-host'),
})

export default app
