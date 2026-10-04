// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { getPerformerRows, mountPerformerTable } from '../src/performerTable.js';

const assets = [
    { ticker: 'BETA', name: 'Beta', invested: 1000, gainEUR: 100, gainPct: 10 },
    { ticker: 'ALPHA', name: 'Alpha', invested: 100, gainEUR: 50, gainPct: 50 },
    { ticker: 'LOSS-A', name: 'Loss A', invested: 200, gainEUR: -80, gainPct: -40 },
    { ticker: 'LOSS-B', name: 'Loss B', invested: 1000, gainEUR: -50, gainPct: -5 },
    { ticker: 'FLAT', name: 'Flat', invested: 100, gainEUR: 0, gainPct: 0 },
    { ticker: 'UNKNOWN', name: 'Unknown', invested: 100, gainEUR: null, gainPct: null }
];

const visibleTickers = container => [...container.querySelectorAll('tbody tr:not(.performer-total-row) .performer-asset-ticker')]
    .map(element => element.textContent);

describe('table commune Top/Worst Performers', () => {
    let container;

    beforeEach(() => {
        document.body.innerHTML = '<div id="table"></div>';
        container = document.getElementById('table');
    });

    it('applique les mêmes filtres et tris financiers aux deux pages', () => {
        expect(getPerformerRows(assets, 'gainer').map(asset => asset.ticker)).toEqual(['BETA', 'ALPHA']);
        expect(getPerformerRows(assets, 'loser').map(asset => asset.ticker)).toEqual(['LOSS-A', 'LOSS-B']);
    });

    it('rend les trois colonnes triables et conserve la ligne de total', () => {
        mountPerformerTable(container, assets, 'gainer', { formatCurrency: value => `${value.toFixed(2)} €` });

        expect(visibleTickers(container)).toEqual(['BETA', 'ALPHA']);
        expect(container.querySelectorAll('th[data-sort]')).toHaveLength(3);
        expect(container.querySelector('th[data-sort="gainEUR"]').getAttribute('aria-sort')).toBe('descending');
        expect(container.querySelector('.performer-total-row').textContent).toContain('150.00 €');
        expect(container.querySelector('.performer-total-row').textContent).toContain('13.64%');

        // Nouveau critère : le premier clic trie les pourcentages du plus grand au plus petit.
        container.querySelector('th[data-sort="gainPct"]').click();
        expect(visibleTickers(container)).toEqual(['ALPHA', 'BETA']);
        expect(container.querySelector('th[data-sort="gainPct"]').getAttribute('aria-sort')).toBe('descending');

        // Second clic sur la même colonne inverse le sens.
        container.querySelector('th[data-sort="gainPct"]').click();
        expect(visibleTickers(container)).toEqual(['BETA', 'ALPHA']);
        expect(container.querySelector('th[data-sort="gainPct"]').getAttribute('aria-sort')).toBe('ascending');

        container.querySelector('th[data-sort="asset"]').click();
        expect(visibleTickers(container)).toEqual(['ALPHA', 'BETA']);
    });
});
