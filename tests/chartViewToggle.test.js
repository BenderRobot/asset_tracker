// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountViewToggle } from '../src/chartViewToggle.js';

describe('mountViewToggle', () => {
    let container;
    beforeEach(() => {
        document.body.innerHTML = '<div id="view-toggle"></div>';
        container = document.getElementById('view-toggle');
    });

    it('portfolio: € / % switch, performance selected by default', () => {
        mountViewToggle(container, 'portfolio', vi.fn());
        const buttons = [...container.querySelectorAll('.toggle-btn')];

        expect(container.dataset.mode).toBe('portfolio');
        expect(buttons.map(b => b.textContent.trim())).toEqual(['€', '%']);
        expect(buttons.map(b => b.getAttribute('aria-label'))).toEqual(['Valeur (€)', 'Performance (%)']);
        expect(container.querySelector('.toggle-btn.active').dataset.view).toBe('performance');
        expect(container.querySelector('.toggle-group').dataset.active).toBe('1');
    });

    it('switches view, moves the thumb and notifies once', () => {
        const onChange = vi.fn();
        mountViewToggle(container, 'portfolio', onChange);
        const [value, perf] = container.querySelectorAll('.toggle-btn');

        value.click();
        expect(onChange).toHaveBeenCalledWith('global');
        expect(value.getAttribute('aria-pressed')).toBe('true');
        expect(perf.classList.contains('active')).toBe(false);
        expect(container.querySelector('.toggle-group').dataset.active).toBe('0');

        value.click(); // already selected: no redundant re-render
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('asset: a click on the inner icon still selects its button', () => {
        const onChange = vi.fn();
        mountViewToggle(container, 'asset', onChange);
        expect(container.querySelector('.toggle-btn.active').dataset.view).toBe('unit');

        container.querySelector('[data-view="global"]').click();
        container.querySelector('[data-view="unit"] i').click();

        expect(onChange).toHaveBeenLastCalledWith('unit');
        expect(container.querySelector('.toggle-btn.active').dataset.view).toBe('unit');
    });
});
