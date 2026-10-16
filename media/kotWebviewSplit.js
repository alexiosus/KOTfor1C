(function () {
    'use strict';

    function clampSize(size, available, minimum, otherMinimum) {
        const total = Math.max(0, available - 4);
        const low = Math.min(minimum, total / 2);
        const high = Math.max(low, total - Math.min(otherMinimum, total / 2));
        return Math.min(high, Math.max(low, size));
    }

    function attach(container, saved, onChange) {
        const separator = container?.querySelector(':scope > .kot-pane-resizer');
        if (!separator) { return null; }
        const after = container.dataset.kotSplit === 'after';
        const pane = after ? container.lastElementChild : container.firstElementChild;
        let sizes = Object.fromEntries(['x', 'y'].filter(axis => Number.isFinite(saved?.[axis]) && saved[axis] > 0).map(axis => [axis, saved[axis]]));
        let drag = null;

        function geometry() {
            const style = getComputedStyle(container);
            const axis = style.getPropertyValue('--kot-split-axis').trim() === 'y' ? 'y' : 'x';
            const available = axis === 'x' ? container.clientWidth : container.clientHeight;
            const minBefore = Number.parseFloat(style.getPropertyValue(`--kot-split-min-before-${axis}`)) || 160;
            const minAfter = Number.parseFloat(style.getPropertyValue(`--kot-split-min-after-${axis}`)) || 160;
            return { axis, available, minimum: after ? minAfter : minBefore, otherMinimum: after ? minBefore : minAfter };
        }

        function update() {
            const current = geometry();
            const property = current.axis === 'x' ? '--kot-split-width' : '--kot-split-height';
            if (Number.isFinite(sizes[current.axis])) {
                container.style.setProperty(property, `${clampSize(sizes[current.axis], current.available, current.minimum, current.otherMinimum)}px`);
            } else {
                container.style.removeProperty(property);
            }
            const bounds = pane.getBoundingClientRect();
            const size = current.axis === 'x' ? bounds.width : bounds.height;
            const clamped = clampSize(size, current.available, current.minimum, current.otherMinimum);
            if (Math.abs(clamped - size) > 1) { container.style.setProperty(property, `${clamped}px`); }
            const position = after ? current.available - 4 - clamped : clamped;
            separator.setAttribute('aria-orientation', current.axis === 'x' ? 'vertical' : 'horizontal');
            separator.setAttribute('aria-valuemin', String(Math.round(after ? current.available - 4 - clampSize(Infinity, current.available, current.minimum, current.otherMinimum) : clampSize(0, current.available, current.minimum, current.otherMinimum))));
            separator.setAttribute('aria-valuemax', String(Math.round(after ? current.available - 4 - clampSize(0, current.available, current.minimum, current.otherMinimum) : clampSize(Infinity, current.available, current.minimum, current.otherMinimum))));
            separator.setAttribute('aria-valuenow', String(Math.round(position)));
            return { ...current, size: clamped };
        }

        function move(size, current) {
            sizes[current.axis] = clampSize(size, current.available, current.minimum, current.otherMinimum);
            update();
        }

        separator.addEventListener('pointerdown', event => {
            if (event.button !== 0 || drag) { return; }
            event.preventDefault();
            const current = update();
            drag = { ...current, pointerId: event.pointerId, start: current.axis === 'x' ? event.clientX : event.clientY, saved: { ...sizes } };
            separator.setPointerCapture(event.pointerId);
            container.classList.add('kot-resizing-panes');
        });
        separator.addEventListener('pointermove', event => {
            if (!drag || event.pointerId !== drag.pointerId) { return; }
            const delta = (drag.axis === 'x' ? event.clientX : event.clientY) - drag.start;
            move(drag.size + (after ? -delta : delta), drag);
        });
        function finish(event) {
            if (!drag || event.pointerId !== drag.pointerId) { return; }
            if (event.type === 'pointercancel') { sizes = drag.saved; }
            const pointerId = drag.pointerId;
            drag = null;
            container.classList.remove('kot-resizing-panes');
            update();
            if (separator.hasPointerCapture?.(pointerId)) { separator.releasePointerCapture(pointerId); }
            if (event.type !== 'pointercancel') { onChange({ ...sizes }); }
        }
        for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) { separator.addEventListener(name, finish); }
        separator.addEventListener('keydown', event => {
            const current = update();
            const previous = current.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
            const next = current.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
            if (![previous, next, 'Home', 'End'].includes(event.key)) { return; }
            event.preventDefault();
            const delta = (event.key === previous ? -1 : 1) * (event.shiftKey ? 64 : 16) * (after ? -1 : 1);
            const size = event.key === 'Home' ? (after ? Infinity : 0) : event.key === 'End' ? (after ? 0 : Infinity) : current.size + delta;
            move(size, current);
            onChange({ ...sizes });
        });
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
        observer?.observe(container);
        window.addEventListener('resize', update);
        update();
        return Object.freeze({ update });
    }

    globalThis.KotWebviewSplit = Object.freeze({ attach, clampSize });
}());
