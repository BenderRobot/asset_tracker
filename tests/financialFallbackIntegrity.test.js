// BUG FOUND (audit sécurité/intégrité, P1) : quand aucune vraie clôture veille
// n'était disponible pour un ticker (api.js::fetchPricesViaProxy), le code
// faisait `previousClose = currentPrice` — indiscernable ensuite d'une
// clôture réelle égale au prix courant. dataManager.js::_enrichAggregatedPosition
// transformait alors cette absence de donnée en un Day P&L de 0,00€/0,00%
// affiché comme un FAIT ("le titre n'a pas bougé aujourd'hui"), alors que la
// vérité est "on ne sait pas". Ce test vérifie que l'absence de previousClose
// produit désormais `dayChange: null, dayPct: null` ("indisponible" — déjà
// rendu comme tel par formatCurrency/formatPercent, voir utils.js), et que le
// cas légitime "previousClose réel == currentPrice" (vrai 0%) reste, lui,
// bien un 0% confirmé et non une valeur indisponible.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, purchase } from './helpers.js';

describe('Day P&L — une donnée indisponible ne doit jamais devenir un 0% fabriqué', () => {
    it('previousClose absent (previousCloseUnavailable) → dayChange/dayPct restent null, jamais 0', () => {
        const storage = createFakeStorage({
            prices: {
                // Reproduit exactement la forme produite par api.js quand
                // aucune vraie clôture veille n'a pu être déterminée.
                AAPL: { price: 200, currency: 'EUR', previousClose: null, previousCloseUnavailable: true, lastUpdate: Date.now() }
            }
        });
        const dm = new DataManager(storage, null);
        const purchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })];

        const holdings = dm.calculateHoldings(purchases);
        const aapl = holdings.find(h => h.ticker === 'AAPL');

        expect(aapl.dayChange).toBeNull();
        expect(aapl.dayPct).toBeNull();
    });

    it('previousClose réellement égal au prix courant → un vrai 0% confirmé (pas indisponible)', () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 200, lastUpdate: Date.now() }
            }
        });
        const dm = new DataManager(storage, null);
        const purchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })];

        const holdings = dm.calculateHoldings(purchases);
        const aapl = holdings.find(h => h.ticker === 'AAPL');

        expect(aapl.dayChange).toBe(0);
        expect(aapl.dayPct).toBe(0);
    });

    it('previousClose réel différent du prix courant → variation calculée normalement', () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 210, currency: 'EUR', previousClose: 200, lastUpdate: Date.now() }
            }
        });
        const dm = new DataManager(storage, null);
        const purchases = [purchase({ ticker: 'AAPL', assetType: 'Stock', price: 150, quantity: 10, date: '2024-01-01' })];

        const holdings = dm.calculateHoldings(purchases);
        const aapl = holdings.find(h => h.ticker === 'AAPL');

        expect(aapl.dayChange).toBeCloseTo(100, 6); // 10 * (210-200)
        expect(aapl.dayPct).toBeCloseTo(5, 6); // (210-200)/200 * 100
    });
});
