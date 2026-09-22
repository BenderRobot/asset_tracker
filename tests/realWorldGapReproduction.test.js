// PERMANENT REGRESSION TEST — reproduces the EXACT reported production gap
// (Graph "Fin"/tooltip = 53 226,78€ vs KPI/table = 36 880,78€, écart de
// 16 346,00€) to the cent, and proves algebraically that the dividend-phantom-
// share bug in HistoryCalculator._buildLedger (see dividendPhantomShares.test.js)
// is BY ITSELF sufficient to produce a gap of exactly this magnitude.
//
// I do not have access to the user's real stored purchases/dividends (this is
// a static Firebase-hosted app; the actual transaction history lives only in
// that account's browser localStorage/Firestore, not in this repository) — so
// the position composition below is a MINIMAL CONSTRUCTED SCENARIO, deliberately
// solved to land on the exact two reported totals, not a claim about what the
// user's real portfolio actually holds. What this test DOES prove, honestly:
//   1. This exact bug class, at a plausible real-world scale (one ticker with
//      one historical dividend), is CAPABLE of producing a gap of exactly
//      16 346,00€ — the order of magnitude is not implausible.
//   2. With the fix applied (current src/HistoryCalculator.js), this exact
//      scenario produces ZERO gap — the two numbers reconcile to the cent.
//   3. If this exact bug (dividends misclassified as real buys of the
//      underlying ticker) is ever reintroduced, this test fails by reproducing
//      the reported symptom again — a live tripwire, not a static assertion.
//
// See the accompanying report for the diagnostic script the user can run
// against their REAL data to get the true per-ticker breakdown for their
// account — this test cannot substitute for that, and does not claim to.
import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
// dataManager.js imports HistoryCalculator via './HistoryCalculator.js?v=5'
// (a cache-busting query string) — Vite/Vitest treats that as a DISTINCT
// module record from a plain '../src/HistoryCalculator.js' import, so patching
// the class from an unsuffixed import would silently patch the wrong copy and
// have zero effect on what DataManager actually calls. Import with the exact
// same specifier dataManager.js uses to guarantee we patch the one instance in
// play.
import { HistoryCalculator } from '../src/HistoryCalculator.js?v=5';
import { parseDate } from '../src/utils.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

// Verbatim copy of _buildLedger's PRE-FIX classification (git history,
// HistoryCalculator.js before this session's fix) — used ONLY inside this
// test, monkey-patched onto the prototype for the duration of one call, to
// prove the magnitude of the regression this test guards against. NEVER
// reintroduced into src/.
function preFixBuildLedger(purchases, isSingleAsset) {
    const byTicker = new Map();
    let firstPurchaseDate = null;
    const addEntry = (t, entry) => {
        if (!byTicker.has(t)) byTicker.set(t, []);
        byTicker.get(t).push(entry);
        if (!firstPurchaseDate || entry.date < firstPurchaseDate) firstPurchaseDate = entry.date;
    };
    if (isSingleAsset) {
        const t = purchases[0].ticker.toUpperCase();
        purchases.forEach(p => addEntry(t, {
            date: parseDate(p.date), price: parseFloat(p.price), quantity: parseFloat(p.quantity),
            currency: p.currency || 'EUR', broker: p.broker || 'RV-CT'
        }));
    } else {
        purchases.forEach(p => {
            const type = (p.assetType || '').toLowerCase();
            // BUG (pre-fix) : ne reconnaît PAS 'dividend' comme du cash.
            const isCash = type === 'cash' || p.ticker.toUpperCase() === 'CASH' || p.ticker.toUpperCase() === 'EUR';
            const currency = p.currency || 'EUR';
            const t = isCash ? `CASH-${currency}` : p.ticker.toUpperCase();
            const broker = p.broker || 'RV-CT';
            if (isCash) {
                addEntry(t, { date: parseDate(p.date), price: 1.0, quantity: parseFloat(p.price) || 0, currency, broker });
            } else {
                addEntry(t, { date: parseDate(p.date), price: parseFloat(p.price), quantity: parseFloat(p.quantity), currency, broker });
            }
        });
    }
    byTicker.forEach(list => list.sort((a, b) => a.date - b.date));
    return { byTicker, firstPurchaseDate };
}

describe('REPRODUCTION RÉELLE — écart 53 226,78€ (graph) vs 36 880,78€ (KPI/table)', () => {
    // Scénario minimal : une position réelle sur "MEGA" (1 action à 17 000€,
    // le prix courant résolu), une seconde position "OTHER" pour compléter le
    // total, et UN SEUL dividende historique sur MEGA (654,00€ net) — reçu il y
    // a plusieurs mois, comme n'importe quel dividende trimestriel réel.
    const storage = createFakeStorage({
        prices: {
            MEGA: { price: 17000, currency: 'EUR', previousClose: 16800, lastUpdate: Date.now() },
            OTHER: { price: 19226.78, currency: 'EUR', previousClose: 19000, lastUpdate: Date.now() }
        },
        conversionRate: 0.9
    });
    const assetPurchases = [
        purchase({ ticker: 'MEGA', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' }),
        purchase({ ticker: 'OTHER', assetType: 'Stock', price: 15000, quantity: 1, date: '2024-01-01' })
    ];
    const cashPurchases = [
        purchase({ ticker: 'MEGA', assetType: 'Dividend', type: 'dividend', price: 654.00, quantity: 1, date: '2024-06-01' })
    ];

    it('AVANT le fix (classification pré-correction réintroduite localement) : le graphique affiche exactement 53 226,78€ quand holdings/cash affichent 36 880,78€', async () => {
        const dm = new DataManager(storage, createFakeApi());
        const original = HistoryCalculator.prototype._buildLedger;
        HistoryCalculator.prototype._buildLedger = preFixBuildLedger;
        try {
            const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
            const values = snapshot.todayGraphData.values;
            const buggyGraphValue = values[values.length - 1];
            const correctTotal = snapshot.summary.totalCurrentEUR + snapshot.cashReserve.total;

            expect(correctTotal).toBeCloseTo(36880.78, 2); // KPI/table — inchangé par le bug (calculateHoldings exclut déjà les dividendes)
            expect(buggyGraphValue).toBeCloseTo(53226.78, 2); // graphique — corrompu par l'action fantôme
            expect(buggyGraphValue - correctTotal).toBeCloseTo(16346.00, 2); // l'écart exact rapporté en production
        } finally {
            HistoryCalculator.prototype._buildLedger = original; // ne JAMAIS laisser fuiter vers un autre test
        }
    });

    it('APRÈS le fix (code actuel de src/HistoryCalculator.js) : graph.lastValue == holdings.totalValue + cash, à 0,01€ près — écart nul', async () => {
        const dm = new DataManager(storage, createFakeApi());
        const snapshot = await dm.buildTodaySnapshot(assetPurchases, cashPurchases);
        const values = snapshot.todayGraphData.values;
        const graphValue = values[values.length - 1];
        const holdingsPlusCash = snapshot.summary.totalCurrentEUR + snapshot.cashReserve.total;

        expect(graphValue).toBeCloseTo(36880.78, 2);
        expect(holdingsPlusCash).toBeCloseTo(36880.78, 2);
        expect(graphValue - holdingsPlusCash).toBeCloseTo(0, 6); // zéro, pas "proche de zéro à 150€ près"
    });
});
