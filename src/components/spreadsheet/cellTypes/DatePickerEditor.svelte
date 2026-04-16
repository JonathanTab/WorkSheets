<script>
    /**
     * DatePickerEditor — custom date/time/datetime picker.
     *
     * Supports date, time, and datetime subFormats with calendar and time picker.
     *
     * Props:
     *   value        — raw stored value (ISO string or time string)
     *   subFormat    — 'date' (default) | 'time' | 'datetime'
     *   oncommit(v)  — called when value is finalized
     *   oncancel()   — called on Escape when popup is closed
     *   onchange(v)  — called on every keystroke (for formula-bar sync)
     *   ontabnext()  — Tab → next column
     *   ontabprev()  — Shift+Tab → prev column
     *   onrowcommit()— Enter in entry row → commit row
     *   autofocus    — focus on mount (default true)
     */
    import { onMount, tick } from "svelte";
    import { mobileState } from "../../../stores/mobileState.svelte.js";
    import {
        parseLocalDate,
        formatDate,
        dateToISO,
    } from "../../../stores/spreadsheet/cellTypes/types/date.js";

    let {
        value = "",
        subFormat = "date",
        oncommit = null,
        oncancel = null,
        onchange = null,
        ontabnext = null,
        ontabprev = null,
        onrowcommit = null,
        autofocus = true,
    } = $props();

    // ── Time helpers ──────────────────────────────────────────────────────────

    /** Parse "H:MM", "H:MM:SS", "H:MM AM/PM" → { h, mi, sc } or null */
    function parseTime(s) {
        const m = String(s ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?$/i);
        if (!m) return null;
        let h = parseInt(m[1], 10);
        const mi = parseInt(m[2], 10);
        const sc = m[3] ? parseInt(m[3], 10) : 0;
        const ap = m[4]?.toUpperCase();
        if (ap === 'AM') { if (h === 12) h = 0; }
        else if (ap === 'PM') { if (h !== 12) h += 12; }
        if (h > 23 || mi > 59 || sc > 59) return null;
        return { h, mi, sc };
    }

    /** Format as "h:mm AM/PM" */
    function fmtTime(h, mi) {
        const ap = h < 12 ? 'AM' : 'PM';
        const h12 = h % 12 || 12;
        return `${h12}:${String(mi).padStart(2, '0')} ${ap}`;
    }

    /** "HH:mm:ss" storage format */
    function storeTime(h, mi, sc = 0) {
        return `${String(h).padStart(2,'0')}:${String(mi).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
    }

    /** Parse stored value into { date, time } based on subFormat */
    function parseStored(v) {
        const s = String(v ?? '').trim();
        if (!s) return { date: null, time: null };
        if (subFormat === 'time') {
            return { date: null, time: parseTime(s) };
        }
        if (subFormat === 'datetime') {
            const m = s.match(/^(.+?)\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM))?)$/i);
            if (m) {
                return { date: parseLocalDate(m[1].trim()), time: parseTime(m[2].trim()) };
            }
            const tOnly = parseTime(s);
            if (tOnly) return { date: null, time: tOnly };
            return { date: parseLocalDate(s), time: null };
        }
        return { date: parseLocalDate(s), time: null };
    }

    /** Build display text from parsed components */
    function buildDisplay(date, timeH, timeM, hasTimeVal) {
        if (subFormat === 'time') {
            return hasTimeVal ? fmtTime(timeH, timeM) : '';
        }
        const datePart = formatDate(date);
        if (subFormat === 'datetime' && hasTimeVal) {
            return datePart ? `${datePart} ${fmtTime(timeH, timeM)}` : fmtTime(timeH, timeM);
        }
        return datePart;
    }

    /** Build the final storage value to commit */
    function buildCommitValue() {
        if (subFormat === 'time') {
            const t = parseTime(displayText);
            if (t) return storeTime(t.h, t.mi, t.sc);
            return displayText;
        }
        if (subFormat === 'datetime') {
            const p = parseStored(displayText);
            const d = p.date ?? selectedDate;
            const t = p.time ?? (hasTime && !p.date ? { h: pickerH, mi: pickerM, sc: 0 } : null);
            if (!d && !t) return displayText;
            if (!d) return storeTime(t.h, t.mi, t.sc);
            const datePart = dateToISO(d);
            if (!t) return datePart;
            return `${datePart} ${storeTime(t.h, t.mi, t.sc)}`;
        }
        const d = parseLocalDate(displayText);
        return d ? dateToISO(d) : displayText;
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /**
     * Returns true when `v` is a canonical stored-value string that should be
     * parsed and re-formatted for display.  Short "seed" strings typed by the
     * user to start an edit (e.g. "1", "12", "Jan") are NOT stored values and
     * should be shown as-is so the first typed character is preserved.
     */
    function looksLikeStoredValue(v) {
        const s = String(v ?? '').trim();
        if (!s) return true;                              // empty → parse normally
        if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;  // YYYY-MM-DD (ISO / datetime)
        if (/^\d{2}:\d{2}:\d{2}$/.test(s)) return true; // HH:mm:ss  (stored time)
        // Legacy full ISO strings ("2026-01-05T05:00:00.000Z") caught above
        return false;
    }

    let _stored = parseStored(value);
    let _useStoredDisplay = looksLikeStoredValue(value);

    let displayText = $state(
        _useStoredDisplay
            ? buildDisplay(_stored.date, _stored.time?.h ?? 0, _stored.time?.mi ?? 0, !!_stored.time)
            : String(value ?? '')   // raw seed text — show as typed, calendar still tracks parse
    );
    let selectedDate = $state(_stored.date);
    let viewYear = $state((_stored.date ?? new Date()).getFullYear());
    let viewMonth = $state((_stored.date ?? new Date()).getMonth());
    let focusedDay = $state(/** @type {number|null} */ (null));
    let showCalendar = $state(false);

    let pickerH = $state(_stored.time?.h ?? new Date().getHours());
    let pickerM = $state(_stored.time?.mi ?? 0);
    let hasTime = $state(!!_stored.time);
    let isTextEditing = $state(false);
    let focusFromPointer = $state(false);

    let _lastValue = $state(value);

    function syncFromValue(nextValue) {
        const p = parseStored(nextValue);
        selectedDate = p.date;
        viewYear = (p.date ?? new Date()).getFullYear();
        viewMonth = (p.date ?? new Date()).getMonth();
        focusedDay = null;
        showCalendar = false;
        pickerH = p.time?.h ?? new Date().getHours();
        pickerM = p.time?.mi ?? 0;
        hasTime = !!p.time;
        displayText = buildDisplay(p.date, pickerH, pickerM, hasTime);
    }

    $effect(() => {
        if (value !== _lastValue) {
            _lastValue = value;
            if (isTextEditing && document.activeElement === inputEl) return;
            syncFromValue(value);
        }
    });

    let calTop = $state(0);
    let calLeft = $state(0);
    let calMinW = $state(220);

    let inputEl = $state(/** @type {HTMLInputElement|null} */ (null));
    let calendarEl = $state(/** @type {HTMLElement|null} */ (null));

    const now = new Date();
    const todayY = now.getFullYear();
    const todayM = now.getMonth();
    const todayD = now.getDate();

    const MONTHS = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    const DAY_HDR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

    let cells = $derived.by(() => {
        const firstDow = new Date(viewYear, viewMonth, 1).getDay();
        const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
        const arr = /** @type {(number|null)[]} */ ([]);
        for (let i = 0; i < firstDow; i++) arr.push(null);
        for (let d = 1; d <= daysInMonth; d++) arr.push(d);
        return arr;
    });

    let showsCalendar = $derived(subFormat === 'date' || subFormat === 'datetime');
    let showsTime = $derived(subFormat === 'time' || subFormat === 'datetime');

    function isSelected(d) {
        return (
            d !== null &&
            selectedDate !== null &&
            selectedDate.getFullYear() === viewYear &&
            selectedDate.getMonth() === viewMonth &&
            selectedDate.getDate() === d
        );
    }

    function isToday(d) {
        return (
            d !== null &&
            viewYear === todayY &&
            viewMonth === todayM &&
            d === todayD
        );
    }

    // ── Calendar positioning ──────────────────────────────────────────────────

    function clamp(n, min, max) {
        return Math.min(Math.max(n, min), max);
    }

    function getVisibleViewportBounds(margin = 8) {
        const vv = window.visualViewport;
        const viewportTop = vv?.offsetTop ?? 0;
        const viewportLeft = vv?.offsetLeft ?? 0;
        const viewportWidth = vv?.width ?? window.innerWidth;
        const viewportBottomViaVv = viewportTop + (vv?.height ?? window.innerHeight);
        const keyboardTop =
            mobileState.isMobile && mobileState.isKeyboardOpen
                ? window.innerHeight - mobileState.keyboardHeight
                : viewportBottomViaVv;
        const viewportBottom = Math.max(
            viewportTop + margin,
            Math.min(viewportBottomViaVv, keyboardTop) - margin,
        );
        return {
            top: viewportTop + margin,
            left: viewportLeft + margin,
            right: viewportLeft + viewportWidth - margin,
            bottom: viewportBottom,
        };
    }

    function positionCalendar() {
        if (!inputEl) return;
        const r = inputEl.getBoundingClientRect();
        const bounds = getVisibleViewportBounds(8);
        const gap = 6;
        const popupRect = calendarEl?.getBoundingClientRect();
        const popupWidth = Math.max(calMinW, popupRect?.width ?? Math.max(240, r.width));
        const popupHeight = popupRect?.height ?? (showsTime ? 332 : 286);

        const spaceBelow = bounds.bottom - (r.bottom + gap);
        const spaceAbove = (r.top - gap) - bounds.top;
        const spaceRight = bounds.right - (r.right + gap);
        const spaceLeft = (r.left - gap) - bounds.left;

        let top = r.bottom + gap;
        let left = r.left;

        if (spaceBelow >= popupHeight) {
            top = r.bottom + gap;
        } else if (spaceAbove >= popupHeight) {
            top = r.top - popupHeight - gap;
        } else if (spaceRight >= popupWidth || spaceLeft >= popupWidth) {
            left = spaceRight >= spaceLeft ? r.right + gap : r.left - popupWidth - gap;
            top = clamp(r.top, bounds.top, Math.max(bounds.top, bounds.bottom - popupHeight));
        } else {
            top = spaceBelow >= spaceAbove ? r.bottom + gap : r.top - popupHeight - gap;
        }

        left = clamp(left, bounds.left, Math.max(bounds.left, bounds.right - popupWidth));
        top = clamp(top, bounds.top, Math.max(bounds.top, bounds.bottom - popupHeight));

        calTop = Math.round(top);
        calLeft = Math.round(left);
        calMinW = Math.max(220, Math.round(r.width));
    }

    async function openCalendar() {
        if (!inputEl) return;
        calMinW = Math.max(220, Math.round(inputEl.getBoundingClientRect().width));
        showCalendar = true;
        await tick();
        positionCalendar();
        if (
            selectedDate &&
            selectedDate.getFullYear() === viewYear &&
            selectedDate.getMonth() === viewMonth
        ) {
            focusedDay = selectedDate.getDate();
        } else {
            focusedDay = null;
        }
    }

    $effect(() => {
        const _kb = mobileState.keyboardHeight;
        const _open = mobileState.isKeyboardOpen;
        if (showCalendar) positionCalendar();
    });

    // ── Reset state ───────────────────────────────────────────────────────────

    function resetState() {
        displayText = '';
        selectedDate = null;
        pickerH = new Date().getHours();
        pickerM = 0;
        hasTime = false;
        focusedDay = null;
        showCalendar = false;
    }

    // ── Calendar actions ──────────────────────────────────────────────────────

    function pickDay(d) {
        if (!d) return;
        const date = new Date(viewYear, viewMonth, d);
        selectedDate = date;
        focusedDay = d;
        if (subFormat === 'datetime') {
            displayText = buildDisplay(date, pickerH, pickerM, hasTime);
        } else {
            displayText = formatDate(date);
            showCalendar = false;
            oncommit?.(dateToISO(date));
        }
    }

    function pickToday() {
        const date = new Date(todayY, todayM, todayD);
        selectedDate = date;
        viewYear = todayY;
        viewMonth = todayM;
        focusedDay = todayD;
        if (subFormat === 'datetime') {
            displayText = buildDisplay(date, pickerH, pickerM, hasTime);
        } else {
            displayText = formatDate(date);
            showCalendar = false;
            oncommit?.(dateToISO(date));
        }
    }

    // ── Time picker actions ───────────────────────────────────────────────────

    function applyTimePicker() {
        hasTime = true;
        displayText = buildDisplay(selectedDate, pickerH, pickerM, true);
        if (subFormat === 'time') {
            oncommit?.(storeTime(pickerH, pickerM));
        }
    }

    function adjustHour(delta) {
        pickerH = ((pickerH + delta) + 24) % 24;
        applyTimePicker();
    }

    function adjustMinute(delta) {
        pickerM = ((pickerM + delta) + 60) % 60;
        applyTimePicker();
    }

    function toggleAmPm() {
        pickerH = (pickerH + 12) % 24;
        applyTimePicker();
    }

    function pickNow() {
        const n = new Date();
        pickerH = n.getHours();
        pickerM = n.getMinutes();
        hasTime = true;
        displayText = buildDisplay(selectedDate, pickerH, pickerM, true);
        if (subFormat === 'time') {
            showCalendar = false;
            oncommit?.(storeTime(pickerH, pickerM));
        }
    }

    function handleDone() {
        showCalendar = false;
        oncommit?.(buildCommitValue());
    }

    // ── Month navigation ──────────────────────────────────────────────────────

    function prevMonth() {
        if (viewMonth === 0) {
            viewMonth = 11;
            viewYear--;
        } else viewMonth--;
        focusedDay = null;
    }

    function nextMonth() {
        if (viewMonth === 11) {
            viewMonth = 0;
            viewYear++;
        } else viewMonth++;
        focusedDay = null;
    }

    /** Move the keyboard-focused day by delta (handles month wrapping). */
    function moveFocused(delta) {
        let y = viewYear,
            m = viewMonth;
        let d = (focusedDay ?? selectedDate?.getDate() ?? 1) + delta;
        while (d < 1) {
            m--;
            if (m < 0) {
                m = 11;
                y--;
            }
            d += new Date(y, m + 1, 0).getDate();
        }
        while (d > new Date(y, m + 1, 0).getDate()) {
            d -= new Date(y, m + 1, 0).getDate();
            m++;
            if (m > 11) {
                m = 0;
                y++;
            }
        }
        viewYear = y;
        viewMonth = m;
        focusedDay = d;
    }

    // ── Event handlers ────────────────────────────────────────────────────────

    function handleInput(e) {
        const t = /** @type {HTMLInputElement} */ (e.target);
        displayText = t.value;
        _lastValue = t.value;
        isTextEditing = true;

        const hasDateSignal =
            /[\/\-\s]/.test(displayText) ||
            /[a-z]/i.test(displayText) ||
            /^\d{4}$/.test(displayText);

        if (subFormat === 'time') {
            const p = parseTime(displayText);
            if (p) { pickerH = p.h; pickerM = p.mi; hasTime = true; }
        } else if (subFormat === 'datetime') {
            const p = parseStored(displayText);
            if (p.date && hasDateSignal) {
                selectedDate = p.date;
                viewYear = p.date.getFullYear();
                viewMonth = p.date.getMonth();
            }
            if (p.time) {
                pickerH = p.time.h;
                pickerM = p.time.mi;
                hasTime = true;
            }
        } else {
            if (hasDateSignal) {
                const d = parseLocalDate(displayText);
                if (d) {
                    selectedDate = d;
                    viewYear = d.getFullYear();
                    viewMonth = d.getMonth();
                    focusedDay = d.getDate();
                }
            }
        }
        onchange?.(displayText);
    }

    function handleKeydown(e) {
        const key = e.key;

        if (key === "Escape") {
            e.stopPropagation();
            e.preventDefault();
            if (showCalendar) {
                showCalendar = false;
            } else {
                oncancel?.();
            }
            return;
        }

        if (key === "Enter") {
            e.stopPropagation();
            e.preventDefault();
            // For date-only: Enter on focused calendar day picks it
            if (showCalendar && focusedDay !== null && subFormat === 'date') {
                pickDay(focusedDay);
                onrowcommit?.();
                resetState();
            } else {
                showCalendar = false;
                oncommit?.(buildCommitValue());
                onrowcommit?.();
                resetState();
            }
            return;
        }

        if (key === "Tab") {
            e.stopPropagation();
            e.preventDefault();
            showCalendar = false;
            oncommit?.(buildCommitValue());
            if (e.shiftKey) {
                ontabprev?.();
            } else {
                ontabnext?.();
            }
            return;
        }

        if (key === "ArrowDown") {
            e.preventDefault();
            if (!showCalendar) {
                openCalendar();
            } else if (showsCalendar) {
                moveFocused(7);
            }
            return;
        }
        if (key === "ArrowUp" && showCalendar && showsCalendar) {
            e.preventDefault();
            moveFocused(-7);
            return;
        }
        if (key === "ArrowLeft" && showCalendar && showsCalendar) {
            e.preventDefault();
            moveFocused(-1);
            return;
        }
        if (key === "ArrowRight" && showCalendar && showsCalendar) {
            e.preventDefault();
            moveFocused(1);
            return;
        }

        if (key === ";" && (e.ctrlKey || e.metaKey)) {
            e.stopPropagation();
            e.preventDefault();
            pickToday();
            if (subFormat !== 'datetime') {
                onrowcommit?.();
                resetState();
            }
            return;
        }
    }

    // ── Outside-click to close ────────────────────────────────────────────────

    function handleDocMousedown(e) {
        if (!showCalendar) return;
        const target = /** @type {Node} */ (e.target);
        if (inputEl?.contains(target)) return;
        if (calendarEl?.contains(target)) return;
        showCalendar = false;
    }

    /** Allow parent components (e.g. TableEntryCell) to focus this editor. */
    export function focus() {
        inputEl?.focus();
        inputEl?.select();
    }

    function handleInputFocus() {
        isTextEditing = true;
        if ((mobileState.isMobile || focusFromPointer) && !showCalendar) openCalendar();
        focusFromPointer = false;
    }

    function handleInputMouseDown() {
        focusFromPointer = true;
    }

    function handleInputBlur() {
        isTextEditing = false;
    }

    onMount(() => {
        document.addEventListener("mousedown", handleDocMousedown, true);
        const repositionIfOpen = () => {
            if (showCalendar) positionCalendar();
        };
        window.addEventListener("resize", repositionIfOpen);
        window.addEventListener("scroll", repositionIfOpen, true);
        window.visualViewport?.addEventListener("resize", repositionIfOpen);
        window.visualViewport?.addEventListener("scroll", repositionIfOpen);
        if (autofocus && inputEl) {
            // Mobile: avoid forcing soft keyboard + viewport jump for date/time pickers.
            if (!mobileState.isMobile) {
                inputEl.focus();
                inputEl.select();
            }
            // Always open the calendar immediately so the picker is ready for
            // keyboard interaction without requiring a click first.
            openCalendar();
        }
        return () =>
            {
                document.removeEventListener("mousedown", handleDocMousedown, true);
                window.removeEventListener("resize", repositionIfOpen);
                window.removeEventListener("scroll", repositionIfOpen, true);
                window.visualViewport?.removeEventListener("resize", repositionIfOpen);
                window.visualViewport?.removeEventListener("scroll", repositionIfOpen);
            };
    });
</script>

<div class="dpw">
    <input
        bind:this={inputEl}
        type="text"
        class="date-input"
        placeholder={subFormat === 'time' ? '1:30 PM or 13:30' : subFormat === 'datetime' ? '01/05/2026 1:30 PM' : 'MM/DD/YYYY or Jan 5...'}
        value={displayText}
        oninput={handleInput}
        onkeydown={handleKeydown}
        onfocus={handleInputFocus}
        onblur={handleInputBlur}
        onmousedown={handleInputMouseDown}
        onclick={handleInputFocus}
        readonly={mobileState.isMobile}
        inputmode={mobileState.isMobile ? "none" : "text"}
        autocomplete="off"
        spellcheck="false"
    />
</div>

{#if showCalendar}
    <div
        bind:this={calendarEl}
        class="cal-portal"
        class:has-time={showsTime}
        style="top:{calTop}px; left:{calLeft}px; min-width:{calMinW}px;"
        onmousedown={(e) => e.preventDefault()}
        role="dialog"
        tabindex="-1"
        aria-label={subFormat === 'time' ? 'Time picker' : 'Date picker'}
    >
        {#if showsCalendar}
            <div class="cal-header">
                <button
                    class="cal-nav"
                    tabindex="-1"
                    onclick={prevMonth}
                    aria-label="Previous month">‹</button
                >
                <span class="cal-title">{MONTHS[viewMonth]} {viewYear}</span>
                <button
                    class="cal-nav"
                    tabindex="-1"
                    onclick={nextMonth}
                    aria-label="Next month">›</button
                >
            </div>

            <div class="cal-grid">
                {#each DAY_HDR as h}
                    <div class="cal-dh">{h}</div>
                {/each}
                {#each cells as d}
                    <button
                        class="cal-day"
                        class:sel={isSelected(d)}
                        class:tod={isToday(d)}
                        class:foc={focusedDay === d && d !== null}
                        class:emp={d === null}
                        tabindex="-1"
                        disabled={d === null}
                        onclick={() => pickDay(d)}
                        aria-label={d
                            ? `${MONTHS[viewMonth]} ${d}, ${viewYear}`
                            : ""}
                        aria-pressed={isSelected(d)}
                    >
                        {d ?? ""}
                    </button>
                {/each}
            </div>
        {/if}

        {#if showsTime}
            {#if showsCalendar}
                <div class="time-divider"></div>
            {/if}
            <div class="time-section">
                <div class="time-picker">
                    <div class="time-unit">
                        <button class="time-btn" tabindex="-1" onclick={() => adjustHour(1)}>▲</button>
                        <span class="time-val">{String(pickerH % 12 || 12).padStart(2,'0')}</span>
                        <button class="time-btn" tabindex="-1" onclick={() => adjustHour(-1)}>▼</button>
                    </div>
                    <span class="time-sep">:</span>
                    <div class="time-unit">
                        <button class="time-btn" tabindex="-1" onclick={() => adjustMinute(5)}>▲</button>
                        <span class="time-val">{String(pickerM).padStart(2,'0')}</span>
                        <button class="time-btn" tabindex="-1" onclick={() => adjustMinute(-5)}>▼</button>
                    </div>
                    <button class="ampm-btn" tabindex="-1" onclick={toggleAmPm}>
                        {pickerH < 12 ? 'AM' : 'PM'}
                    </button>
                </div>
                <button class="now-btn" tabindex="-1" onclick={pickNow}>Now</button>
            </div>
        {/if}

        <div class="cal-footer">
            {#if showsCalendar && subFormat !== 'datetime'}
                <button class="today-btn" tabindex="-1" onclick={pickToday}>Today</button>
            {/if}
            {#if subFormat === 'datetime'}
                <button class="today-btn" tabindex="-1" onclick={pickToday}>Today</button>
                <button class="done-btn" tabindex="-1" onclick={handleDone}>Done</button>
            {/if}
        </div>
    </div>
{/if}

<style>
    .dpw {
        position: relative;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
    }

    .date-input {
        flex: 1;
        min-width: 0;
        width: 100%;
        height: 100%;
        border: none;
        background: transparent;
        padding: 0 4px;
        font-size: 13px;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
        outline: none;
        min-width: 0;
        color: var(--cell-text, #1e293b);
        box-sizing: border-box;
    }

    .date-input::placeholder {
        color: var(--placeholder-color, #94a3b8);
        font-style: italic;
        font-size: 12px;
    }

    .date-input:focus {
        outline: 2px solid var(--editor-outline, #3b82f6);
        outline-offset: -2px;
        background: var(--input-bg, #ffffff);
    }

    /* ── Fixed-position calendar popup ──────────────────────────────────────── */
    .cal-portal {
        position: fixed;
        z-index: 9999;
        background: #ffffff;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0, 0, 0, 0.14);
        padding: 8px;
        user-select: none;
        max-height: min(420px, 78vh);
        overflow: auto;
    }

    .cal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
    }

    .cal-title {
        font-size: 12px;
        font-weight: 600;
        color: var(--cell-text, #1e293b);
        min-width: 110px;
        text-align: center;
    }

    .cal-nav {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px 6px;
        font-size: 18px;
        line-height: 1;
        color: var(--cell-text, #475569);
        border-radius: 4px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .cal-nav:hover {
        background: var(--cell-hover, #f1f5f9);
    }

    .cal-grid {
        display: grid;
        grid-template-columns: repeat(7, 28px);
        gap: 1px;
    }

    .cal-dh {
        text-align: center;
        font-size: 10px;
        font-weight: 600;
        color: var(--placeholder-color, #94a3b8);
        padding: 2px 0 4px;
        width: 28px;
    }

    .cal-day {
        width: 28px;
        height: 26px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        border: none;
        background: none;
        cursor: pointer;
        border-radius: 4px;
        color: var(--cell-text, #1e293b);
        padding: 0;
        transition: background 0.1s;
    }

    .cal-day:hover:not(:disabled):not(.sel) {
        background: var(--cell-hover, #f1f5f9);
    }

    .cal-day.emp {
        visibility: hidden;
        pointer-events: none;
    }

    .cal-day.sel {
        background: var(--editor-outline, #3b82f6);
        color: #ffffff;
        font-weight: 600;
    }

    .cal-day.tod:not(.sel) {
        background: #eff6ff;
        color: var(--editor-outline, #3b82f6);
        font-weight: 600;
    }

    .cal-day.foc:not(.sel) {
        outline: 2px solid var(--editor-outline, #3b82f6);
        outline-offset: -2px;
    }

    .cal-footer {
        margin-top: 6px;
        display: flex;
        justify-content: center;
    }

    .today-btn {
        background: none;
        border: 1px solid var(--cell-border, #e2e8f0);
        border-radius: 4px;
        padding: 3px 14px;
        font-size: 11px;
        cursor: pointer;
        color: var(--editor-outline, #3b82f6);
        font-weight: 500;
        font-family:
            system-ui,
            -apple-system,
            sans-serif;
    }

    .today-btn:hover {
        background: #eff6ff;
        border-color: var(--editor-outline, #3b82f6);
    }

    /* ── Time picker styles ──────────────────────────────────────────────────── */

    .cal-portal.has-time {
        min-width: 260px;
    }

    .time-divider {
        height: 1px;
        background: var(--cell-border, #e2e8f0);
        margin: 6px 0;
    }

    .time-section {
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-items: center;
    }

    .time-picker {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
    }

    .time-unit {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }

    .time-btn {
        width: 24px;
        height: 18px;
        padding: 0;
        border: 1px solid var(--cell-border, #e2e8f0);
        background: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        line-height: 1;
        color: var(--cell-text, #1e293b);
    }

    .time-btn:hover {
        background: var(--cell-hover, #f1f5f9);
    }

    .time-val {
        font-weight: 600;
        font-size: 13px;
        font-family: monospace;
        color: var(--cell-text, #1e293b);
        min-width: 32px;
        text-align: center;
    }

    .time-sep {
        font-weight: 600;
        font-size: 13px;
        color: var(--cell-text, #1e293b);
        margin: 0 2px;
    }

    .ampm-btn {
        padding: 3px 8px;
        border: 1px solid var(--cell-border, #e2e8f0);
        background: none;
        border-radius: 3px;
        cursor: pointer;
        font-size: 11px;
        font-weight: 500;
        color: var(--cell-text, #1e293b);
        margin-left: 4px;
    }

    .ampm-btn:hover {
        background: var(--cell-hover, #f1f5f9);
    }

    .now-btn {
        padding: 4px 12px;
        border: 1px solid var(--cell-border, #e2e8f0);
        background: none;
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        color: var(--editor-outline, #3b82f6);
        font-weight: 500;
    }

    .now-btn:hover {
        background: #eff6ff;
        border-color: var(--editor-outline, #3b82f6);
    }

    .done-btn {
        padding: 4px 12px;
        border: none;
        background: var(--editor-outline, #3b82f6);
        color: white;
        border-radius: 4px;
        font-size: 11px;
        cursor: pointer;
        font-weight: 500;
    }

    .done-btn:hover {
        background: #2563eb;
    }
</style>
