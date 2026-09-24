// FAIL-CLOSED FX — aucun taux hardcodé 0.925 ; conversion uniquement si taux réel.
import { describe, it, expect, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

describe('FX fail-closed — pas de fallback 0.925', () => {
    it('aucune occurrence de 0.925 / USD_TO_EUR_FALLBACK_RATE dans src/', () => {
        const files = [
            'config.js', 'storage.js', 'api.js', 'dataManager.js',
            'HistoryCalculator.js', 'investmentsPage.js'
        ];
        for (const f of files) {
            const src = readFileSync(path.join(SRC, f), 'utf8');
            // Autoriser la mention dans les commentaires d'interdiction uniquement
            const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.includes('*'));
            const joined = codeLines.join('\n');
            expect(joined, f).not.toMatch(/USD_TO_EUR_FALLBACK_RATE/);
            expect(joined, f).not.toMatch(/\b0\.925\b/);
        }
    });

    it('actif USD sans taux FX → priceDataUnavailable, jamais de valeur inventée', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const storage = createFakeStorage({
            prices: {
                // Devise encore USD = conversion storage refusée faute de taux
                BKSY: { price: 10, currency: 'USD', previousClose: 9, lastUpdate: Date.now() }
            },
            conversionRate: null
        });
        const dm = new DataManager(storage, createFakeApi());
        const holdings = dm.calculateHoldings([
            purchase({ ticker: 'BKSY', currency: 'USD', price: 8, quantity: 10, date: '2024-01-01' })
        ]);

        expect(holdings).toHaveLength(1);
        expect(holdings[0].priceDataUnavailable).toBe(true);
        expect(holdings[0].currentValue).toBeNull();
        expect(holdings[0].currentPrice).toBeNull();
        warnSpy.mockRestore();
    });

    it('actif EUR sans taux FX → valorisation inchangée (pas besoin de FX)', () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: null
        });
        const dm = new DataManager(storage, createFakeApi());
        const holdings = dm.calculateHoldings([
            purchase({ ticker: 'AAPL', currency: 'EUR', price: 150, quantity: 2, date: '2024-01-01' })
        ]);

        expect(holdings[0].priceDataUnavailable).toBeFalsy();
        expect(holdings[0].currentValue).toBe(400);
    });

    it('taux FX réel présent → conversion USD OK', () => {
        const storage = createFakeStorage({
            prices: { BKSY: { price: 10, currency: 'USD', previousClose: 9, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const holdings = dm.calculateHoldings([
            purchase({ ticker: 'BKSY', currency: 'EUR', price: 8, quantity: 10, date: '2024-01-01' })
        ], null, null, { dynamicRate: 0.9, prices: new Map([['BKSY', { price: 10, currency: 'USD', previousClose: 9 }]]) });

        expect(holdings[0].priceDataUnavailable).toBeFalsy();
        expect(holdings[0].currentValue).toBeCloseTo(90, 5); // 10 * 10 * 0.9
    });
});
