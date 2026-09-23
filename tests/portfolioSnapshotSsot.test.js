// PortfolioSnapshot — invariants obligatoires (audit architecture SSOT).
//
// Ces tests verrouillent la propriété centrale de la refonte : il n'existe
// qu'UN producteur (dataManager.buildPortfolioSnapshot, appelé exclusivement
// par buildTodaySnapshot / buildAssetPortfolioSnapshot / buildIndexSnapshot)
// pour les métriques financières canoniques du portefeuille, et ce producteur
// ne peut structurellement pas transformer un cash-flow (dépôt, retrait,
// achat, vente, dividende) en Day P&L — parce que dayPnl est TOUJOURS une
// somme de positions[].dayPnl, et le cash n'est jamais une position.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

const today = () => new Date().toISOString().slice(0, 10);

describe('Invariant A — snapshot.dayPnl === Σ positions[].dayPnl', () => {
    it('tient sur un portefeuille multi-tickers avec mouvements du jour', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                MSFT: { price: 300, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', price: 200, quantity: 3, date: today() }),
            purchase({ ticker: 'MSFT', price: 250, quantity: 2, date: '2024-01-01' })
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const ps = snapshot.portfolioSnapshot;

        const sumPositionsDayPnl = ps.positions.reduce((s, p) => s + p.dayPnl, 0);
        expect(ps.dayPnl).toBeCloseTo(sumPositionsDayPnl, 9);
    });
});

describe('Invariant B — snapshot.totalValue === Σ positions.currentValue + cash', () => {
    it('tient avec du cash présent', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const cashPurchases = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        const ps = snapshot.portfolioSnapshot;

        const sumCurrentValue = ps.positions.reduce((s, p) => s + p.currentValue, 0);
        expect(ps.totalValue).toBeCloseTo(sumCurrentValue + ps.cash, 9);
        expect(ps.cash).toBeCloseTo(500, 2);
    });
});

describe('Invariant C — snapshot.totalReturn === Σ positions.totalReturn (définition actuelle : actifs seuls, cash exclu)', () => {
    it('tient et reste cohérent avec totalValue - invested - cash', async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const cashPurchases = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        const ps = snapshot.portfolioSnapshot;

        const sumPositionsReturn = ps.positions.reduce((s, p) => s + p.totalReturn, 0);
        expect(ps.totalReturn).toBeCloseTo(sumPositionsReturn, 9);
        // totalReturn est défini sur les ACTIFS SEULS (cash exclu, un dépôt
        // n'est jamais un "retour") : totalValue - cash - invested = totalReturn.
        expect(ps.totalValue - ps.cash - ps.invested).toBeCloseTo(ps.totalReturn, 9);
    });
});

describe('Invariant G — un cash-flow ne devient jamais du Day P&L', () => {
    it("achat aujourd'hui sur une position existante : dayPnl ignore la quantité achetée le jour même", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', price: 200, quantity: 3, date: today() })
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        expect(snapshot.portfolioSnapshot.dayPnl).toBeCloseTo((200 - 190) * 5, 2);
    });

    it("plusieurs achats du même ticker aujourd'hui : toujours ignorés par dayPnl", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', price: 195, quantity: 2, date: today() }),
            purchase({ ticker: 'AAPL', price: 198, quantity: 1, date: today() }),
            purchase({ ticker: 'AAPL', price: 200, quantity: 4, date: today() })
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        expect(snapshot.portfolioSnapshot.dayPnl).toBeCloseTo((200 - 190) * 5, 2);
    });

    it("vente partielle aujourd'hui : dayPnl reflète TOUTE la quantité détenue hier, pas seulement le reliquat", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 10, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', price: 200, quantity: -4, date: today() }) // vente de 4/10
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        // Les 10 titres ont bougé de 190 à 200 pendant la journée, avant même
        // la vente — le P&L du jour porte sur les 10, pas les 6 restants.
        expect(snapshot.portfolioSnapshot.dayPnl).toBeCloseTo((200 - 190) * 10, 2);
    });

    it("achat + vente le même jour sur le même ticker : dayPnl reste ancré sur la quantité d'hier", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 10, date: '2024-01-01' }),
            purchase({ ticker: 'AAPL', price: 198, quantity: 5, date: today() }),  // achat du jour
            purchase({ ticker: 'AAPL', price: 200, quantity: -3, date: today() })  // vente du jour
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        expect(snapshot.portfolioSnapshot.dayPnl).toBeCloseTo((200 - 190) * 10, 2);
    });

    it("dépôt de cash aujourd'hui : totalValue augmente, dayPnl reste rigoureusement inchangé", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const before = await dm.buildTodaySnapshot(assetPurchases, []);
        const depositToday = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 1000, quantity: 1, date: today() })];
        const after = await dm.buildTodaySnapshot(assetPurchases, depositToday);

        expect(after.portfolioSnapshot.dayPnl).toBeCloseTo(before.portfolioSnapshot.dayPnl, 9);
        expect(after.portfolioSnapshot.totalValue - before.portfolioSnapshot.totalValue).toBeCloseTo(1000, 2);
    });

    it("retrait de cash aujourd'hui : totalValue diminue, dayPnl reste rigoureusement inchangé", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const cashBefore = [purchase({ ticker: 'EUR', assetType: 'Cash', price: 2000, quantity: 1, date: '2024-01-01' })];

        const before = await dm.buildTodaySnapshot(assetPurchases, cashBefore);
        // Un retrait est une ligne de cash NÉGATIVE (voir calculateCashReserve).
        const withdrawalToday = [...cashBefore, purchase({ ticker: 'EUR', assetType: 'Cash', price: -300, quantity: 1, date: today() })];
        const after = await dm.buildTodaySnapshot(assetPurchases, withdrawalToday);

        expect(after.portfolioSnapshot.dayPnl).toBeCloseTo(before.portfolioSnapshot.dayPnl, 9);
        expect(after.portfolioSnapshot.totalValue - before.portfolioSnapshot.totalValue).toBeCloseTo(-300, 2);
    });

    it("dividende reçu aujourd'hui : totalValue/cash augmentent, dayPnl des positions reste inchangé", async () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const before = await dm.buildTodaySnapshot(assetPurchases, []);
        const dividendToday = [purchase({ ticker: 'EUR', assetType: 'Dividend', type: 'dividend', price: 42, quantity: 1, date: today() })];
        const after = await dm.buildTodaySnapshot(assetPurchases, dividendToday);

        expect(after.portfolioSnapshot.dayPnl).toBeCloseTo(before.portfolioSnapshot.dayPnl, 9);
        expect(after.portfolioSnapshot.cash - before.portfolioSnapshot.cash).toBeCloseTo(42, 2);
    });

    it('crypto à quantité très précise (9 décimales) : dayPnl et quantity ne sont jamais arrondis en interne', async () => {
        const preciseQty = 0.123456789;
        const storage = createFakeStorage({
            prices: { 'BTC-EUR': { price: 60000, currency: 'EUR', previousClose: 58000, lastUpdate: Date.now() } },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'BTC-EUR', assetType: 'Crypto', price: 40000, quantity: preciseQty, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const pos = snapshot.portfolioSnapshot.positions.find(p => p.ticker === 'BTC-EUR');

        expect(pos.quantity).toBe(preciseQty); // égalité EXACTE, pas juste "proche"
        expect(pos.dayPnl).toBeCloseTo((60000 - 58000) * preciseQty, 9);
    });
});

describe('Invariant H — traçabilité de snapshotId', () => {
    it('un snapshot porte un snapshotId non nul, et un snapshot filtré référence son parent', async () => {
        const storage = createFakeStorage({
            prices: {
                AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() },
                MSFT: { price: 300, currency: 'EUR', previousClose: 305, lastUpdate: Date.now() }
            },
            conversionRate: 0.9
        });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [
            purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' }),
            purchase({ ticker: 'MSFT', price: 250, quantity: 2, date: '2024-01-01' })
        ];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const ps = snapshot.portfolioSnapshot;
        expect(ps.snapshotId).toBeTruthy();

        const filtered = dm.deriveFilteredPortfolioSnapshot(ps, new Set(['AAPL']));
        expect(filtered.filteredFrom).toBe(ps.snapshotId);
        expect(filtered.positions.length).toBe(1);
        expect(filtered.dayPnl).toBeCloseTo(ps.positions.find(p => p.ticker === 'AAPL').dayPnl, 9);
    });

    it('deux appels successifs produisent des snapshotId différents (aucune réutilisation silencieuse)', async () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } }, conversionRate: 0.9 });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];

        const s1 = await dm.buildTodaySnapshot(assetPurchases, []);
        const s2 = await dm.buildTodaySnapshot(assetPurchases, []);
        expect(s1.portfolioSnapshot.snapshotId).not.toBe(s2.portfolioSnapshot.snapshotId);
    });
});

describe('Immutabilité — le PortfolioSnapshot ne peut pas être modifié après création', () => {
    it('Object.freeze empêche toute réécriture silencieuse des champs canoniques', async () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 200, currency: 'EUR', previousClose: 190, lastUpdate: Date.now() } }, conversionRate: 0.9 });
        const dm = new DataManager(storage, createFakeApi());
        const assetPurchases = [purchase({ ticker: 'AAPL', price: 150, quantity: 5, date: '2024-01-01' })];
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, []);
        const ps = snapshot.portfolioSnapshot;

        expect(Object.isFrozen(ps)).toBe(true);
        expect(Object.isFrozen(ps.positions)).toBe(true);
        expect(Object.isFrozen(ps.positions[0])).toBe(true);

        const originalDayPnl = ps.dayPnl;
        const originalQty = ps.positions[0].quantity;
        // Une écriture "silencieuse" (mode non strict, pas de try/catch) ne
        // doit produire AUCUN effet — c'est la garantie qu'aucune vue ne peut
        // corrompre la source canonique pour les autres lecteurs.
        try { ps.dayPnl = 999999; } catch (e) { /* strict mode : throw attendu, ok aussi */ }
        try { ps.positions[0].quantity = 999999; } catch (e) { /* idem */ }

        expect(ps.dayPnl).toBe(originalDayPnl);
        expect(ps.positions[0].quantity).toBe(originalQty);
    });
});
