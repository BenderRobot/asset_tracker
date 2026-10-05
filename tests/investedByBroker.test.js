import { describe, expect, it, vi } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeApi, createFakeStorage, purchase } from './helpers.js';

describe('DataManager.getInvestedByBroker', () => {
    it('marque le total comme indisponible et conserve séparément le sous-total connu si un FX historique manque', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const purchases = [
            purchase({ ticker: 'CW8', broker: 'Broker A', currency: 'EUR', price: 100, quantity: 1 }),
            purchase({ ticker: 'AAPL', broker: 'Broker A', currency: 'USD', price: 100, quantity: 1 }),
            purchase({ ticker: 'MC', broker: 'Broker B', currency: 'EUR', price: 200, quantity: 1 })
        ];

        const result = dm.getInvestedByBroker(purchases, new Map());
        const brokerA = result.find(entry => entry.broker === 'Broker A');
        const brokerB = result.find(entry => entry.broker === 'Broker B');

        expect(brokerA).toMatchObject({
            invested: null,
            knownInvested: 100,
            fxUnavailable: true,
            transactionsCount: 2
        });
        expect([...brokerA.unavailableAssets]).toEqual(['AAPL']);
        expect(brokerB).toMatchObject({
            invested: 200,
            knownInvested: 200,
            fxUnavailable: false,
            transactionsCount: 1
        });
        warn.mockRestore();
    });

    it('retourne un total complet quand toutes les conversions historiques sont disponibles', () => {
        const dm = new DataManager(createFakeStorage(), createFakeApi());
        const purchases = [
            purchase({ ticker: 'CW8', broker: 'Broker A', currency: 'EUR', price: 100, quantity: 1 }),
            purchase({ ticker: 'AAPL', broker: 'Broker A', currency: 'USD', price: 100, quantity: 1, date: '2024-01-01' })
        ];
        const historicalFxMap = new Map([['2024-01-01', 1 / 0.9]]);

        const [broker] = dm.getInvestedByBroker(purchases, historicalFxMap);

        expect(broker).toMatchObject({
            invested: 190,
            knownInvested: 190,
            fxUnavailable: false,
            transactionsCount: 2
        });
        expect([...broker.unavailableAssets]).toEqual([]);
    });
});
