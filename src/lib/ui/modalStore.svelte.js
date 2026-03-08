export const modalStack = $state([]);

export function openModal(component, props = {}) {
    const id = crypto.randomUUID();
    modalStack.push({ id, component, props, closing: false });
    return id;
}

export function closeModal(id) {
    const modal = modalStack.find(m => m.id === id);
    if (modal) modal.closing = true;
}

export function closeTopModal() {
    if (modalStack.length) closeModal(modalStack[modalStack.length - 1].id);
}

export function closeAllModals() {
    modalStack.length = 0;
}

export function pruneClosed() {
    for (let i = modalStack.length - 1; i >= 0; i--) {
        if (modalStack[i].closing) modalStack.splice(i, 1);
    }
}
