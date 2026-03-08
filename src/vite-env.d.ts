/// <reference types="svelte" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/svelte" />

interface StorageDebug {
    toggle: () => void;
    on: () => void;
    off: () => void;
    dump: () => { files: unknown[]; folders: unknown[]; syncState: unknown; timestamp: string } | null;
    status: () => void;
}

declare global {
    interface Window {
        storageDebug: StorageDebug;
    }
}
