// Tests against the REAL DataManager engine (not a reimplementation of it),
// covering the invariants specified in the audit brief:
//
//   1. GLOBAL_INVESTED       = SUM(BROKER_INVESTED)
//   2. GLOBAL_CURRENT_VALUE  = SUM(BROKER_CURRENT_VALUE)
//   3. GLOBAL_RETURN         = SUM(BROKER_RETURN)
//   4. GLOBAL_RETURN         = GLOBAL_CURRENT_VALUE - GLOBAL_INVESTED
//   5. GLOBAL_TOTAL_VALUE    = GLOBAL_CURRENT_VALUE + GLOBAL_CASH
//   6. GLOBAL_TOTAL_VALUE    = GLOBAL_INVESTED + GLOBAL_RETURN + GLOBAL_CASH
//   7. GLOBAL_QUANTITY (per ticker) = SUM(BROKER_QUANTITY)
//   8. A sale at one broker never changes another broker's cost basis
//   9. A change in the CURRENT FX rate never retroactively changes an already
//      recorded EUR "invested" amount for a historical USD purchase
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, purchase } from './helpers.js';

const EPS = 0.01; // tolérance flottante, jamais utilisée pour masquer un écart réel

describe('Test 1 — deux brokers, même ticker (invariants 1-4)', () => {
    it('isole invested/currentValue/return par broker et les recompose exactement au global', () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 250, currency: 'EUR' } } });
        const dm = new DataManager(storage, null);

        const purchases = [
            purchase({ broker: 'A', ticker: 'AAPL', price: 100, quantity: 10 }),
            purchase({ broker: 'B', ticker: 'AAPL', price: 200, quantity: 10 })
        ];

        const result = dm.validatePortfolioConsistency(purchases, []);
        const A = result.byBroker.find(b => b.broker === 'A');
        const B = result.byBroker.find(b => b.broker === 'B');

        expect(A.invested).toBeCloseTo(1000, 2);
        expect(B.invested).toBeCloseTo(2000, 2);
        expect(A.currentValue).toBeCloseTo(2500, 2);
        expect(B.currentValue).toBeCloseTo(2500, 2);
        expect(A.return).toBeCloseTo(1500, 2);
        expect(B.return).toBeCloseTo(500, 2);

        expect(result.global.invested).toBeCloseTo(3000, 2);
        expect(result.global.currentValue).toBeCloseTo(5000, 2);
        expect(result.global.return).toBeCloseTo(2000, 2);
        expect(A.return + B.return).toBeCloseTo(result.global.return, 2);
        expect(result.valid).toBe(true);
    });
});

describe('Test 2 — vente chez A uniquement (invariant 8)', () => {
    it("la vente de A ne modifie jamais le coût de revient de B", () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 250, currency: 'EUR' } } });
        const dm = new DataManager(storage, null);

        const purchases = [
            purchase({ broker: 'A', ticker: 'AAPL', price: 100, quantity: 10, date: '2024-01-01' }),
            purchase({ broker: 'B', ticker: 'AAPL', price: 200, quantity: 10, date: '2024-01-01' }),
            purchase({ broker: 'A', ticker: 'AAPL', price: 999, quantity: -10, date: '2024-06-01' })
        ];

        const positions = dm._buildPositionsByBrokerTicker(purchases, 1, null);
        const A = positions.find(p => p.broker === 'A');
        const B = positions.find(p => p.broker === 'B');

        expect(A.quantity).toBeCloseTo(0, 6);
        expect(A.invested).toBeCloseTo(0, 6);
        expect(B.quantity).toBeCloseTo(10, 6);
        expect(B.invested).toBeCloseTo(2000, 2);

        const holdings = dm.calculateHoldings(purchases);
        const aapl = holdings.find(h => h.ticker === 'AAPL');
        expect(aapl.quantity).toBeCloseTo(10, 6);
        expect(aapl.invested).toBeCloseTo(2000, 2);
    });
});

describe('Test 3 — vente partielle chez A (invariant 8, cas proportionnel)', () => {
    it('réduit le coût de revient de A au prorata, sans toucher B', () => {
        const storage = createFakeStorage({ prices: { AAPL: { price: 250, currency: 'EUR' } } });
        const dm = new DataManager(storage, null);

        const purchases = [
            purchase({ broker: 'A', ticker: 'AAPL', price: 100, quantity: 10, date: '2024-01-01' }),
            purchase({ broker: 'B', ticker: 'AAPL', price: 200, quantity: 10, date: '2024-01-01' }),
            purchase({ broker: 'A', ticker: 'AAPL', price: 999, quantity: -5, date: '2024-06-01' })
        ];

        const positions = dm._buildPositionsByBrokerTicker(purchases, 1, null);
        const A = positions.find(p => p.broker === 'A');
        const B = positions.find(p => p.broker === 'B');

        expect(A.quantity).toBeCloseTo(5, 6);
        expect(A.invested).toBeCloseTo(500, 2);
        expect(B.quantity).toBeCloseTo(10, 6);
        expect(B.invested).toBeCloseTo(2000, 2);

        const holdings = dm.calculateHoldings(purchases);
        const aapl = holdings.find(h => h.ticker === 'AAPL');
        expect(aapl.quantity).toBeCloseTo(15, 6);
        expect(aapl.invested).toBeCloseTo(2500, 2);
    });
});

describe('Test 4 — FX USD historique (invariant 9)', () => {
    it("fige l'investi EUR au taux DU JOUR DE L'ACHAT, jamais au taux courant", () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 110, currency: 'USD' } },
            conversionRate: 0.85 // taux COURANT, différent du taux à l'achat
        });
        const dm = new DataManager(storage, null);

        const purchaseDate = '2024-03-15';
        const purchases = [
            purchase({ broker: 'A', ticker: 'AAPL', currency: 'USD', price: 100, quantity: 10, date: purchaseDate })
        ];

        // Taux EUR->USD figé pour la date d'achat (1 EUR = 1/0.92 USD, donc
        // USD->EUR = 0.92) — simule fetchHistoricalFxRateMap.
        const historicalFxMap = new Map([[purchaseDate, 1 / 0.92]]);

        const holdings = dm.calculateHoldings(purchases, null, historicalFxMap);
        const aapl = holdings.find(h => h.ticker === 'AAPL');

        // Investi figé au taux d'achat : 10 * 100 * 0.92 = 920€
        expect(aapl.invested).toBeCloseTo(920, 2);
        // Valeur actuelle au taux COURANT : 10 * 110 * 0.85 = 935€
        expect(aapl.currentValue).toBeCloseTo(935, 2);

        // Le taux courant change encore (ex: rafraîchi le lendemain) — l'investi
        // déjà comptabilisé ne doit PAS bouger.
        storage.getConversionRate = () => 0.70;
        const holdingsAfterFxMove = dm.calculateHoldings(purchases, null, historicalFxMap);
        const aaplAfter = holdingsAfterFxMove.find(h => h.ticker === 'AAPL');
        expect(aaplAfter.invested).toBeCloseTo(920, 2);
        // La valeur actuelle, elle, DOIT suivre le taux courant.
        expect(aaplAfter.currentValue).toBeCloseTo(770, 2);
    });

    it('repli explicite (loggé) sur le taux courant si aucune cotation historique n\'est disponible', () => {
        const storage = createFakeStorage({
            prices: { AAPL: { price: 100, currency: 'USD' } },
            conversionRate: 0.90
        });
        const dm = new DataManager(storage, null);
        const purchases = [
            purchase({ broker: 'A', ticker: 'AAPL', currency: 'USD', price: 100, quantity: 1, date: '2024-03-15' })
        ];

        // Map vide : aucune cotation nulle part -> repli sur le taux courant (0.90),
        // pas un taux inventé.
        const holdings = dm.calculateHoldings(purchases, null, new Map());
        const aapl = holdings.find(h => h.ticker === 'AAPL');
        expect(aapl.invested).toBeCloseTo(100 * 0.90, 2);
    });
});

describe('Test 5 — cash (pas de double comptage)', () => {
    it('agrège le cash par broker et au global sans compter deux fois une vente', () => {
        const storage = createFakeStorage({ prices: {} });
        const dm = new DataManager(storage, null);

        const cashPurchases = [
            purchase({ broker: 'A', ticker: 'EUR', assetType: 'Cash', price: 1000, quantity: 1 }),
            purchase({ broker: 'B', ticker: 'EUR', assetType: 'Cash', price: 500, quantity: 1 })
        ];

        const reserve = dm.calculateCashReserve(cashPurchases);
        expect(reserve.total).toBeCloseTo(1500, 2);
        expect(reserve.byBroker['A']).toBeCloseTo(1000, 2);
        expect(reserve.byBroker['B']).toBeCloseTo(500, 2);

        // Une vente crée 2 lignes distinctes (voir app.js::addPurchase) : l'actif
        // vendu (qty négative, assetType='Stock', EXCLU du cash) + une ligne cash
        // séparée (assetType='Cash', prix = produit de la vente). Le cash ne doit
        // augmenter QU'UNE fois du produit de la vente.
        const sellAssetLine = purchase({ broker: 'A', ticker: 'AAPL', assetType: 'Stock', price: 250, quantity: -10 });
        const sellCashLine = purchase({ broker: 'A', ticker: 'EUR', assetType: 'Cash', price: 2500, quantity: 1 });

        const reserveAfterSale = dm.calculateCashReserve([...cashPurchases, sellAssetLine, sellCashLine]);
        expect(reserveAfterSale.total).toBeCloseTo(1500 + 2500, 2);
        expect(reserveAfterSale.byBroker['A']).toBeCloseTo(1000 + 2500, 2);
    });
});

describe('Test 6 — invariants sur portefeuille aléatoire', () => {
    function randomPortfolio(seed) {
        // PRNG déterministe (mulberry32) — un échec de test doit être reproductible.
        let s = seed;
        const rand = () => {
            s |= 0; s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        const brokers = ['A', 'B', 'C'];
        const tickers = ['AAPL', 'MSFT', 'BTC-EUR'];
        const held = new Map(); // "broker::ticker" -> quantity currently held
        const purchases = [];
        const cashPurchases = [];
        let day = 0;

        for (let i = 0; i < 60; i++) {
            day += 1 + Math.floor(rand() * 5);
            const date = new Date(2023, 0, 1 + day).toISOString().slice(0, 10);
            const broker = brokers[Math.floor(rand() * brokers.length)];
            const ticker = tickers[Math.floor(rand() * tickers.length)];
            const key = `${broker}::${ticker}`;
            const currency = rand() < 0.3 ? 'USD' : 'EUR';
            const isDividend = rand() < 0.15;

            if (isDividend) {
                cashPurchases.push(purchase({
                    broker, ticker: 'EUR', assetType: 'Dividend', type: 'dividend',
                    price: 1 + rand() * 20, quantity: 1, date, currency: 'EUR'
                }));
                continue;
            }

            const currentQty = held.get(key) || 0;
            const isSell = currentQty > 0 && rand() < 0.35;

            if (isSell) {
                const sellQty = Math.min(currentQty, currentQty * (0.2 + rand() * 0.8));
                held.set(key, currentQty - sellQty);
                purchases.push(purchase({ broker, ticker, currency, price: 10 + rand() * 90, quantity: -sellQty, date }));
                cashPurchases.push(purchase({
                    broker, ticker: currency, assetType: 'Cash',
                    price: sellQty * (10 + rand() * 90), quantity: 1, date, currency
                }));
            } else {
                const buyQty = 1 + rand() * 10;
                held.set(key, currentQty + buyQty);
                purchases.push(purchase({ broker, ticker, currency, price: 10 + rand() * 90, quantity: buyQty, date }));
            }
        }

        return { purchases, cashPurchases };
    }

    for (let seed = 1; seed <= 10; seed++) {
        it(`portefeuille aléatoire #${seed} respecte tous les invariants`, () => {
            const { purchases, cashPurchases } = randomPortfolio(seed * 97 + 13);

            const storage = createFakeStorage({
                prices: {
                    AAPL: { price: 180, currency: 'EUR' },
                    MSFT: { price: 90, currency: 'USD' },
                    'BTC-EUR': { price: 55000, currency: 'EUR' }
                },
                conversionRate: 0.88
            });
            const dm = new DataManager(storage, null);

            // Taux historique volontairement DIFFÉRENT du taux courant (0.88), pour
            // que le test échoue s'il redevient possible qu'un des deux totaux (global
            // vs somme des brokers) applique une conversion différente à un même achat.
            const historicalFxMap = new Map();
            purchases.filter(p => p.currency === 'USD').forEach(p => historicalFxMap.set(p.date, 1 / 0.93));

            const result = dm.validatePortfolioConsistency(purchases, cashPurchases, historicalFxMap);

            for (const [key, diff] of Object.entries(result.differences)) {
                expect(Math.abs(diff), `${key} devrait être ~0, écart=${diff}`).toBeLessThanOrEqual(EPS);
            }
            expect(result.valid).toBe(true);

            // Invariant 7 : quantité globale par ticker = somme des quantités par broker.
            const holdings = dm.calculateHoldings(purchases, null, historicalFxMap).filter(h => h.quantity > 0.0001);
            const positions = dm._buildPositionsByBrokerTicker(purchases, 0.88, historicalFxMap).filter(p => p.quantity > 0.0001);
            holdings.forEach(h => {
                const sumQty = positions.filter(p => p.ticker === h.ticker).reduce((s, p) => s + p.quantity, 0);
                expect(sumQty).toBeCloseTo(h.quantity, 6);
            });
        });
    }
});
