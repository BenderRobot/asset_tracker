// ============================================================
// DIAGNOSTIC TEMPORAIRE — à retirer une fois l'audit du 16 346,00€ conclu.
// Extrait de src/dataManager.js (audit 2026-09-28) : ce code d'investigation
// n'est plus livré avec le moteur. Le dossier audit/ n'est pas publié sur
// Firebase Hosting ; l'outil se charge à la demande depuis un serveur local.
// ============================================================
// Rapprochement par ticker des "actions fantômes" créées par
// HistoryCalculator._buildLedger avant son fix (voir dividendPhantomShares.
// test.js / realWorldGapReproduction.test.js) — calculé sur les VRAIS achats
// du compte (dataManager.storage.getPurchases()), pas sur des données inventées.
// Lecture seule : ne modifie ni ne persiste rien. Usage depuis la console du
// navigateur, sur le Dashboard servi en local :
//   const { debugDividendPhantomGap } = await import('/audit/tools/debugDividendPhantomGap.js');
//   await debugDividendPhantomGap(dashboardApp.dataManager);
//
// Même URL de module que src/dataManager.js : le rejeu "avant
// correction" remplace temporairement HistoryCalculator.prototype._buildLedger
// et doit donc viser l'instance réellement utilisée par le moteur.
import { HistoryCalculator } from '../../src/HistoryCalculator.js';
import { parseDate } from '../../src/utils.js';

export async function debugDividendPhantomGap(dataManager) {
    const purchases = dataManager.storage.getPurchases();
    const marketPurchases = purchases.filter(p => p.assetType !== 'Real Estate');
    const assetPurchases = marketPurchases.filter(p => {
        const type = (p.assetType || 'Stock').toLowerCase();
        return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
    });
    const cashPurchases = marketPurchases.filter(p => {
        const type = (p.assetType || 'Stock').toLowerCase();
        return type === 'cash' || type === 'dividend' || p.type === 'dividend';
    });

    // "Après correction" : le code actuel, tel qu'il tourne réellement dans
    // cette session — donne aussi resolvedPrices, réutilisé ci-dessous pour
    // que "Prix final utilisé" soit EXACTEMENT le prix que le graphique et
    // les holdings utilisent déjà, pas une 3e lecture indépendante.
    const snapshotAfter = await dataManager.buildTodaySnapshot(assetPurchases, cashPurchases);
    const graphAfter = snapshotAfter.todayGraphData.values[snapshotAfter.todayGraphData.values.length - 1];
    const holdingsTotal = snapshotAfter.summary.totalCurrentEUR + snapshotAfter.cashReserve.total;

    // "Avant correction" : rejoue EXACTEMENT le même calcul en réintroduisant
    // temporairement la classification pré-fix de _buildLedger (copie
    // verbatim de la version d'avant ce fix — voir git history), puis la
    // restaure immédiatement, y compris si un throw survient.
    const preFixBuildLedger = function (purchasesArg, isSingleAsset) {
        const byTicker = new Map();
        let firstPurchaseDate = null;
        const addEntry = (t, entry) => {
            if (!byTicker.has(t)) byTicker.set(t, []);
            byTicker.get(t).push(entry);
            if (!firstPurchaseDate || entry.date < firstPurchaseDate) firstPurchaseDate = entry.date;
        };
        if (isSingleAsset) {
            const t = purchasesArg[0].ticker.toUpperCase();
            purchasesArg.forEach(p => addEntry(t, {
                date: parseDate(p.date), price: parseFloat(p.price), quantity: parseFloat(p.quantity),
                currency: p.currency || 'EUR', broker: p.broker || 'RV-CT'
            }));
        } else {
            purchasesArg.forEach(p => {
                const type = (p.assetType || '').toLowerCase();
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
    };

    const originalBuildLedger = HistoryCalculator.prototype._buildLedger;
    let graphBefore = null;
    try {
        HistoryCalculator.prototype._buildLedger = preFixBuildLedger;
        const snapshotBefore = await dataManager.buildTodaySnapshot(assetPurchases, cashPurchases);
        graphBefore = snapshotBefore.todayGraphData.values[snapshotBefore.todayGraphData.values.length - 1];
    } finally {
        HistoryCalculator.prototype._buildLedger = originalBuildLedger;
    }

    // --- Rapprochement par ticker ---
    const dividendsByTicker = new Map(); // ticker -> { count, phantomQty, amountSum }
    cashPurchases.forEach(p => {
        const type = (p.assetType || '').toLowerCase();
        const isDividend = type === 'dividend' || p.type === 'dividend';
        const isRealCashTicker = p.ticker.toUpperCase() === 'CASH' || p.ticker.toUpperCase() === 'EUR';
        if (!isDividend || isRealCashTicker) return;
        const ticker = p.ticker.toUpperCase();
        if (!dividendsByTicker.has(ticker)) dividendsByTicker.set(ticker, { count: 0, phantomQty: 0, amountSum: 0 });
        const entry = dividendsByTicker.get(ticker);
        entry.count += 1;
        entry.phantomQty += parseFloat(p.quantity) || 0;
        entry.amountSum += parseFloat(p.price) || 0;
    });

    const rows = [];
    let totalPhantomValue = 0;
    let totalDividendAmount = 0;
    dividendsByTicker.forEach((entry, ticker) => {
        const resolved = snapshotAfter.todayGraphData.resolvedPrices.get(ticker);
        const finalPrice = resolved?.price ?? null;
        const phantomValue = finalPrice != null ? entry.phantomQty * finalPrice : null;
        if (phantomValue != null) totalPhantomValue += phantomValue;
        totalDividendAmount += entry.amountSum;
        rows.push({
            Ticker: ticker,
            'Nb dividendes': entry.count,
            'Qté fantôme cumulée': entry.phantomQty,
            'Prix final utilisé': finalPrice,
            'Valeur fantôme finale (€)': phantomValue != null ? phantomValue.toFixed(2) : 'N/A (pas de resolvedPrice)',
            'Montant dividendes cumulé (€)': entry.amountSum.toFixed(2)
        });
    });

    console.table(rows);
    console.log(`[debugDividendPhantomGap] Σ valeur fantôme = ${totalPhantomValue.toFixed(2)}€, Σ dividendes (cash) = ${totalDividendAmount.toFixed(2)}€`);
    console.log(`[debugDividendPhantomGap] Écart PRÉDIT par les dividendes = ${(totalPhantomValue - totalDividendAmount).toFixed(2)}€`);
    console.log(`[debugDividendPhantomGap] Graphique AVANT correction (rejoué) = ${graphBefore?.toFixed(2)}€`);
    console.log(`[debugDividendPhantomGap] Graphique APRÈS correction (code actuel) = ${graphAfter?.toFixed(2)}€`);
    console.log(`[debugDividendPhantomGap] Holdings + cash (inchangé par le bug) = ${holdingsTotal.toFixed(2)}€`);
    console.log(`[debugDividendPhantomGap] Écart RÉEL observé (avant - holdings) = ${(graphBefore - holdingsTotal).toFixed(2)}€`);
    const predicted = totalPhantomValue - totalDividendAmount;
    const observed = graphBefore - holdingsTotal;
    const residual = observed - predicted;
    console.log(`[debugDividendPhantomGap] Résidu inexpliqué par les dividendes = ${residual.toFixed(2)}€ ${Math.abs(residual) <= 0.01 ? '(dividendes = cause UNIQUE)' : '(⚠️ AUTRE CAUSE PRÉSENTE — audit à poursuivre)'}`);

    return { rows, totalPhantomValue, totalDividendAmount, graphBefore, graphAfter, holdingsTotal, predicted, observed, residual };
}
