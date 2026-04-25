/**
 * mobileState — reactive singleton for mobile/touch detection.
 * Import directly in components; no prop drilling needed.
 */

class MobileState {
    isMobile = $state(false);
    isKeyboardOpen = $state(false);
    keyboardHeight = $state(0);
    /** Visual-viewport-only keyboard height — correct for positioning `position:fixed` elements above the keyboard. On Android (window-resize keyboard) this is 0 so fixed elements don't get incorrectly lifted. */
    viewportKeyboardHeight = $state(0);
    #baselineInnerHeight = 0;
    #isTextInputFocused = false;

    constructor() {
        if (typeof window === "undefined") return;

        // Match the same query used in component CSS
        const mq = window.matchMedia("(max-width: 600px)");
        this.isMobile = mq.matches;
        mq.addEventListener("change", (e) => {
            this.isMobile = e.matches;
            this.refreshKeyboardMetrics();
        });

        this.#baselineInnerHeight = window.innerHeight;

        const onViewportResize = () => this.refreshKeyboardMetrics();
        const onViewportScroll = () => this.refreshKeyboardMetrics();
        const onWindowResize = () => this.refreshKeyboardMetrics();
        const onFocusIn = (e) => {
            const t = e.target;
            this.#isTextInputFocused = this.#isEditableTarget(t);
            this.refreshKeyboardMetrics();
        };
        const onFocusOut = () => {
            this.#isTextInputFocused = false;
            // Delay lets iOS finish viewport settling after blur.
            setTimeout(() => this.refreshKeyboardMetrics(), 60);
        };

        window.addEventListener("resize", onWindowResize);
        document.addEventListener("focusin", onFocusIn, true);
        document.addEventListener("focusout", onFocusOut, true);

        // Track soft keyboard height via visualViewport when available.
        if (window.visualViewport) {
            window.visualViewport.addEventListener("resize", onViewportResize);
            // Some iOS builds emit viewport scroll changes without a resize.
            window.visualViewport.addEventListener("scroll", onViewportScroll);
            // iOS sometimes scrolls the page body when an input is focused while the
            // keyboard is open, which disrupts `position:fixed` elements. Force it back.
            window.visualViewport.addEventListener("scroll", () => {
                if (this.isKeyboardOpen && window.scrollY !== 0) {
                    window.scrollTo(0, 0);
                }
            });
        }

        this.refreshKeyboardMetrics();
    }

    #isEditableTarget(target) {
        if (!(target instanceof HTMLElement)) return false;
        if (target.isContentEditable) return true;
        if (target.tagName === "TEXTAREA") return true;
        if (target.tagName !== "INPUT") return false;
        const input = /** @type {HTMLInputElement} */ (target);
        if (input.disabled || input.readOnly) return false;
        const type = (input.type || "text").toLowerCase();
        return !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color"].includes(type);
    }

    refreshKeyboardMetrics() {
        if (typeof window === "undefined") return;

        const vv = window.visualViewport;
        const vvHeight = vv?.height ?? window.innerHeight;
        const vvOffsetTop = vv?.offsetTop ?? 0;

        // Primary signal: viewport reduction relative to layout viewport.
        const fromViewport = Math.max(
            0,
            window.innerHeight - vvHeight - vvOffsetTop,
        );

        // Fallback signal: reduction from a rolling baseline innerHeight.
        const fromBaseline = Math.max(
            0,
            this.#baselineInnerHeight - window.innerHeight,
        );

        // Keep baseline current when keyboard is not expected.
        if (!this.#isTextInputFocused && fromViewport < 40) {
            this.#baselineInnerHeight = Math.max(
                this.#baselineInnerHeight,
                window.innerHeight,
            );
        }

        const rawKeyboard = Math.max(fromViewport, fromBaseline);
        const openThreshold = this.#isTextInputFocused ? 40 : 80;
        const isOpen = this.isMobile && rawKeyboard > openThreshold;

        this.keyboardHeight = isOpen ? Math.round(rawKeyboard) : 0;
        // viewportKeyboardHeight only reflects the visual-viewport shrink (iOS overlay keyboard).
        // On Android the window resizes instead, so fromViewport ≈ 0 and fixed elements don't
        // need lifting — the keyboard is already outside the shrunken window.
        this.viewportKeyboardHeight = isOpen ? Math.round(fromViewport) : 0;
        this.isKeyboardOpen = isOpen;
    }
}

export const mobileState = new MobileState();
