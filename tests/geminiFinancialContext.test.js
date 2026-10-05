import { describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

function manager({ prices = {}, conversionRate = 0.9 } = {}) {
    return new DataManager(createFakeStorage({ prices, conversionRate }), createFakeApi());
}

describe('contexte financier Gemini avancé', () => {
    it('ventile investi, valeur, plus-value et cash sans double comptage par courtier', () => {
        const dm = manager({ prices: { AAPL: { price: 150, currency: 'EUR', previousClose: 145 } } });
        const assets = [
            purchase({ ticker: 'AAPL', broker: 'A', price: 100, quantity: 2 }),
            purchase({ ticker: 'AAPL', broker: 'B', price: 120, quantity: 1 })
        ];
        const cash = [
            purchase({ ticker: 'EUR', assetType: 'Cash', broker: 'A', price: 50, quantity: 1 }),
            purchase({ ticker: 'EUR', assetType: 'Cash', broker: 'B', price: 10, quantity: 1 })
        ];
        const rows = dm.getPortfolioByBroker(assets, cash, new Map(), {
            dynamicRate: 0.9,
            prices: new Map([['AAPL', { price: 150, currency: 'EUR', previousClose: 145 }]])
        });

        const brokerA = rows.find(row => row.broker === 'A');
        const brokerB = rows.find(row => row.broker === 'B');
        expect(brokerA).toMatchObject({
            status: 'complete', invested: 200, currentValue: 300,
            unrealizedPnl: 100, cash: 50, totalValue: 350
        });
        expect(brokerB).toMatchObject({
            status: 'complete', invested: 120, currentValue: 150,
            unrealizedPnl: 30, cash: 10, totalValue: 160
        });
        expect(brokerA.weight).toBeCloseTo((350 / 510) * 100, 6);
        expect(rows.reduce((sum, row) => sum + row.totalValue, 0)).toBe(510);
    });

    it('conserve les sous-totaux connus quand le coût USD historique manque', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const dm = manager({ prices: { AAPL: { price: 150, currency: 'EUR' } } });
        const rows = dm.getPortfolioByBroker([
            purchase({ ticker: 'CW8', broker: 'A', currency: 'EUR', price: 100, quantity: 1 }),
            purchase({ ticker: 'AAPL', broker: 'A', currency: 'USD', price: 100, quantity: 1 })
        ], [], new Map(), {
            dynamicRate: 0.9,
            prices: new Map([
                ['CW8', { price: 110, currency: 'EUR' }],
                ['AAPL', { price: 150, currency: 'EUR' }]
            ])
        });

        expect(rows[0]).toMatchObject({
            status: 'partial', invested: null, knownInvested: 100,
            currentValue: null, knownCurrentValue: 110, totalValue: null
        });
        expect(rows[0].unavailable).toContain('Coût historique AAPL');
        warn.mockRestore();
    });

    it('normalise chaque mouvement avec action, montant natif et contre-valeur historique', () => {
        const dm = manager();
        const historicalFxMap = new Map([['2024-02-01', 1 / 0.9]]);
        const rows = dm.normalizeTransactionHistory([
            purchase({ ticker: 'AAPL', broker: 'A', currency: 'USD', price: 100, quantity: -2, date: '2024-02-01' }),
            purchase({ ticker: 'EUR', assetType: 'Cash', broker: 'A', currency: 'EUR', price: -50, quantity: 1, date: '2024-02-02' })
        ], historicalFxMap);

        const sale = rows.find(row => row.ticker === 'AAPL');
        const withdrawal = rows.find(row => row.ticker === 'EUR');
        expect(sale).toMatchObject({
            action: 'sell', nativeAmount: 200, conversionStatus: 'complete'
        });
        expect(sale.historicalFxRate).toBeCloseTo(0.9, 10);
        expect(sale.amountEUR).toBeCloseTo(180, 10);
        expect(withdrawal).toMatchObject({
            action: 'withdrawal', nativeAmount: 50, amountEUR: 50
        });
    });

    it('calcule le résultat réalisé seulement pour les actifs totalement vendus', () => {
        const dm = manager();
        const closed = dm.calculateClosedPositions([
            purchase({ ticker: 'AAPL', name: 'Apple', broker: 'A', price: 100, quantity: 2, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', name: 'Apple', broker: 'A', price: 150, quantity: -1, date: '2024-02-01' }),
            purchase({ ticker: 'AAPL', name: 'Apple', broker: 'A', price: 170, quantity: -1, date: '2024-03-01' }),
            purchase({ ticker: 'MSFT', name: 'Microsoft', broker: 'A', price: 200, quantity: 2, date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', name: 'Microsoft', broker: 'A', price: 250, quantity: -1, date: '2024-03-01' })
        ], new Map());

        expect(closed).toHaveLength(1);
        expect(closed[0]).toMatchObject({
            ticker: 'AAPL', status: 'complete', costBasisEUR: 200,
            proceedsEUR: 320, realizedPnlEUR: 120, realizedPnlPct: 60,
            firstPurchase: '2024-01-01', lastSale: '2024-03-01'
        });
    });

    it('refuse un résultat réalisé si une conversion historique manque', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const dm = manager();
        const [closed] = dm.calculateClosedPositions([
            purchase({ ticker: 'AAPL', currency: 'USD', price: 100, quantity: 1, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', currency: 'USD', price: 150, quantity: -1, date: '2024-02-01' })
        ], new Map());

        expect(closed).toMatchObject({
            status: 'unavailable', costBasisEUR: null,
            proceedsEUR: null, realizedPnlEUR: null
        });
        warn.mockRestore();
    });
});
