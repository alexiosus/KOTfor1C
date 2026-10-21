(function () {
    'use strict';
    const clips = new Map();
    const controls = new WeakMap();
    const selector = '.kot-button-caption, .menu-item > span:not(.codicon), .meta-chip-value, .meta-chip-label, .platform-selector-label, .infobase-item-name, .infobase-item-path, .outline-title, .outline-subtitle, .outline-value, .current-form-copy .meta-line, .window-title-btn, .catalog-picker-option-key, .catalog-picker-option-description, #profilePickerBtnLabel, #sortMenuLabel';
    let frame;
    let scrollFrame;
    let measureFrame;
    const visibleClips = new Set();
    const pendingMeasurements = new Set();
    const movingClips = new Set();
    function updateScrollFade(element, track, viewport = element.getBoundingClientRect(), text = track.getBoundingClientRect()) {
        element.classList.toggle('kot-text-scrolled', viewport.left - text.left > 1);
        element.classList.toggle('kot-text-more-right', text.right - viewport.right > 1);
    }
    function measure(element, track) {
        if (clips.get(element) !== track || !visibleClips.has(element)) { return; }
        pendingMeasurements.add(element);
        if (measureFrame === undefined) { measureFrame = requestAnimationFrame(flushMeasurements); }
    }
    function flushMeasurements() {
        measureFrame = undefined;
        const measurements = [];
        for (const element of pendingMeasurements) {
            const track = clips.get(element);
            if (!track || !visibleClips.has(element) || !element.getClientRects().length) { continue; }
            measurements.push({ element, track, distance: Math.max(0, track.scrollWidth - element.clientWidth),
                viewport: element.getBoundingClientRect(), text: track.getBoundingClientRect() });
        }
        pendingMeasurements.clear();
        // Read every visible caption before changing styles: alternating these forces a layout per row.
        for (const { element, track, distance, viewport, text } of measurements) {
            element.classList.toggle('kot-text-overflow', distance > 1);
            element.style.setProperty('--kot-text-distance', `${distance}px`);
            element.style.setProperty('--kot-text-duration', `${Math.max(1.2, distance / 45)}s`);
            updateScrollFade(element, track, viewport, text);
        }
    }
    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
        for (const entry of entries) {
            if (entry.isIntersecting) { visibleClips.add(entry.target); const track = clips.get(entry.target); if (track) { measure(entry.target, track); } }
            else { visibleClips.delete(entry.target); pendingMeasurements.delete(entry.target); }
        }
    }) : null;
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
        for (const entry of entries) { const track = clips.get(entry.target); if (track) { measure(entry.target, track); } }
    }) : null;
    function followScrollingText() {
        for (const element of movingClips) {
            const track = clips.get(element);
            if (track && document.body.contains(element)) { updateScrollFade(element, track); }
            else { movingClips.delete(element); }
        }
        scrollFrame = movingClips.size ? requestAnimationFrame(followScrollingText) : undefined;
    }
    function attach(element) {
        if (!(element instanceof HTMLElement)) { return; }
        let track = clips.get(element);
        if (!track || element.firstElementChild !== track) {
            if (element.children.length && !element.firstElementChild?.classList.contains('auto-scroll-track')) { return; }
            const text = element.textContent || '';
            track = document.createElement('span'); track.className = 'kot-text-track'; track.textContent = text;
            element.replaceChildren(track); element.classList.add('kot-text-clip');
            clips.set(element, track); resize?.observe(element);
            if (intersection) { intersection.observe(element); } else { visibleClips.add(element); }
            track.addEventListener('transitionstart', event => {
                if (event.propertyName !== 'transform') { return; }
                movingClips.add(element);
                if (scrollFrame === undefined) { scrollFrame = requestAnimationFrame(followScrollingText); }
            });
            for (const name of ['transitionend', 'transitioncancel']) {
                track.addEventListener(name, event => {
                    if (event.propertyName !== 'transform') { return; }
                    movingClips.delete(element); updateScrollFade(element, track);
                });
            }
        }
        measure(element, track);
    }
    function mirror(control) {
        if (controls.has(control) || control.type === 'hidden' || control.tagName === 'TEXTAREA' || control.tagName === 'SELECT') { return; }
        const wrapper = document.createElement('span'); wrapper.className = 'kot-control';
        const preview = document.createElement('span'); preview.className = 'kot-control-preview'; preview.setAttribute('aria-hidden', 'true');
        control.parentNode.insertBefore(wrapper, control); wrapper.append(control, preview); controls.set(control, preview);
        const sync = () => {
            const text = control.value;
            let track = clips.get(preview);
            if (!track) { preview.textContent = text; attach(preview); track = clips.get(preview); }
            else if (track.textContent !== text) { track.textContent = text; }
            wrapper.classList.toggle('is-readonly', control.readOnly); wrapper.classList.toggle('is-disabled', control.disabled);
            if (track) { measure(preview, track); }
        };
        for (const event of ['input', 'change', 'blur']) { control.addEventListener(event, sync); }
        sync();
    }
    function refresh(root = document.body, extraSelector = '') {
        if (!root) { return; }
        root.querySelectorAll('button').forEach(button => {
            for (const text of Array.from(button.childNodes)) {
                if (text.nodeType !== Node.TEXT_NODE || !text.textContent.trim()) { continue; }
                const caption = document.createElement('span'); caption.className = 'kot-button-caption'; caption.textContent = text.textContent.trim();
                button.replaceChild(caption, text); attach(caption);
            }
        });
        root.querySelectorAll(extraSelector || selector).forEach(attach);
        root.querySelectorAll('input.param-key, input.param-value').forEach(mirror);
        for (const [element, track] of clips) {
            if (!document.body.contains(element)) {
                resize?.unobserve(element); intersection?.unobserve(element); clips.delete(element); movingClips.delete(element);
                visibleClips.delete(element); pendingMeasurements.delete(element);
            }
            else { measure(element, track); }
        }
    }
    function schedule() {
        if (frame !== undefined) { return; }
        frame = requestAnimationFrame(() => { frame = undefined; refresh(); });
    }
    const observer = new MutationObserver(records => {
        if (records.some(record => !record.target.parentElement?.closest('.kot-text-track'))) { schedule(); }
    });
    function start() {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        document.body.addEventListener('mouseover', schedule, true);
        document.body.addEventListener('focusin', schedule, true);
        window.addEventListener('resize', schedule);
        schedule();
    }
    window.KotWebviewText = Object.freeze({ refresh });
    if (document.body) { start(); } else { document.addEventListener('DOMContentLoaded', start, { once: true }); }
}());
