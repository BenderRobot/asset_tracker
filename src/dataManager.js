// ========================================
// dataManager.js - (v8 - Ajout support Indices)
// ========================================

import { USD_TO_EUR_FALLBACK_RATE, YAHOO_MAP, PRICE_PROXY_URL } from './config.js';
import { parseDate } from './utils.js';
import { HistoryCalculator } from './HistoryCalculator.js?v=5';
import { db, auth } from './firebaseConfig.js';
import {
    getIntervalForPeriod,
    getLabelFormat,
    getLastTradingDay,
    isCryptoTicker,
    formatTicker,
    findClosestPrice,
    resolveHistoricalUsdToEurRate
} from './MarketUtils.js';

export class DataManager {
    constructor(storage, api) {
        this.storage = storage;
        this.api = api;
        this.historyCalculator = new HistoryCalculator(storage, api);
    }

    // === HELPERS DELEGATION (Compatibilité Legacy) ===
    isCryptoTicker(ticker) { return isCryptoTicker(ticker); }
    formatTicker(ticker) { return formatTicker(ticker); }
    getIntervalForPeriod(days) { return getIntervalForPeriod(days); }
    getLastTradingDay(date) { return getLastTradingDay(date); }

    // SINGLE SOURCE OF TRUTH : convertit le détail par ticker calculé par le moteur du
    // graphique (HistoryCalculator.calculateGenericHistory) en la map attendue par
    // calculateHoldings ({ yesterdayClose, todayValueOfYesterdayHoldings, currency }).
    // Fonction pure, pas d'I/O : ne fait que réexposer des valeurs déjà résolues.
    buildYesterdayCloseMapFromGraphData(graphData) {
        const map = new Map();
        const perTicker = graphData && graphData.perTickerYesterdayClose;
        if (!perTicker) return map;
        perTicker.forEach((entry, ticker) => {
            if (entry.yesterdayCloseTotal === null || entry.yesterdayCloseTotal === undefined) return;
            map.set(ticker, {
                yesterdayClose: entry.yesterdayCloseTotal,
                todayValueOfYesterdayHoldings: entry.todayValueOfYesterdayHoldingsTotal ?? null,
                currency: entry.currency
            });
        });
        return map;
    }

    // Calcule yesterdayClose de tous les actifs en passant par le même moteur que le
    // graphique (calculateGenericHistory), pour garantir la cohérence avec le KPI "VAR TODAY".
    async calculateAllAssetsYesterdayClose(assetPurchases) {
        if (!assetPurchases || assetPurchases.length === 0) return new Map();
        console.log(`[calculateAllAssetsYesterdayClose] Calculating via graph engine for ${assetPurchases.length} purchases`);
        const graphData = await this.calculateGenericHistory(assetPurchases, 1, false);
        const yesterdayCloseMap = this.buildYesterdayCloseMapFromGraphData(graphData);
        console.log(`[calculateAllAssetsYesterdayClose] Completed. Map size: ${yesterdayCloseMap.size}`);
        return yesterdayCloseMap;
    }

    calculateCashReserve(allPurchases) {
        // Include Dividends in Cash Reserve calculation
        // CRITICAL FIX: Exclude sale transactions (negative quantity assets)
        // Sale creates 2 lines: 1) asset with qty=-1000, 2) cash with price=+75€
        // We only want the cash line, not the asset sale line
        const cashMovements = allPurchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            const isCashOrDiv = type === 'cash' || type === 'dividend' || p.type === 'dividend';

            // If it's a cash/dividend type, include it
            if (isCashOrDiv) return true;

            // Otherwise, exclude it (it's a sale transaction with negative quantity)
            return false;
        });

        const byBroker = {};
        let total = 0;
        cashMovements.forEach(move => {
            // Même valeur par défaut que _buildPositionsByBrokerTicker ('RV-CT', pas
            // 'Unknown') : sinon un mouvement de cash sans broker explicite (ex: import
            // manuel) atterrit sous une clé différente de celle utilisée pour agréger
            // les positions du même courtier par défaut, et validatePortfolioConsistency
            // ne peut plus faire correspondre son cash à son broker.
            const broker = move.broker || 'RV-CT';
            if (!byBroker[broker]) byBroker[broker] = 0;
            const amount = (move.price || 0) * (move.quantity || 1);
            byBroker[broker] += amount;
            total += amount;
        });
        return { total, byBroker };
    }

    // SINGLE SOURCE OF TRUTH pour un taux de change HISTORIQUE (date -> taux),
    // par opposition à getConversionRate() qui ne donne que le taux courant.
    // Ne pas fusionner les deux : un dividende versé il y a 6 mois doit être
    // converti au taux de CE jour-là, pas au taux d'aujourd'hui.
    // Utilisé par DividendManager pour convertir les dividendes USD -> EUR.
    async fetchHistoricalFxRateMap(pair = 'EURUSD=X', rangeYears = 5) {
        const rates = new Map();
        try {
            const ctrl = new AbortController();
            const timeoutId = setTimeout(() => ctrl.abort(), 15000);
            const url = `${PRICE_PROXY_URL}?symbol=${encodeURIComponent(pair)}&type=STOCK&range=${rangeYears}y&interval=1d`;
            const res = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timeoutId));
            if (!res.ok) return rates;

            const data = await res.json();
            const result = data.chart?.result?.[0];
            const timestamps = result?.timestamp;
            const quotes = result?.indicators?.quote?.[0]?.close;

            if (timestamps && quotes) {
                timestamps.forEach((ts, i) => {
                    if (quotes[i]) {
                        const date = new Date(ts * 1000).toISOString().split('T')[0];
                        rates.set(date, quotes[i]);
                    }
                });
            }
        } catch (e) {
            console.warn('[fetchHistoricalFxRateMap] Rate fetch failed:', e.name === 'AbortError' ? 'timeout' : e.message);
        }
        return rates;
    }

    // SINGLE SOURCE OF TRUTH pour la map de taux USD/EUR HISTORIQUES utilisée pour
    // figer le coût EUR d'un ACHAT USD à SA date de transaction (jamais au taux
    // courant — voir _resolveHistoricalUsdToEurRate ci-dessous et invariant 9 :
    // une variation du taux courant ne doit jamais modifier rétroactivement
    // l'investi historique). Mémoïsée par plage d'années couverte (1h de cache) ;
    // ne fait AUCUN appel réseau si le portefeuille ne contient aucun achat USD.
    async getHistoricalFxMap(purchases) {
        const usdBuyDates = (purchases || [])
            .filter(p => p.currency === 'USD' && p.quantity > 0 && p.date)
            .map(p => new Date(p.date))
            .filter(d => !isNaN(d.getTime()));

        if (usdBuyDates.length === 0) return new Map();

        const oldest = new Date(Math.min(...usdBuyDates.map(d => d.getTime())));
        const yearsNeeded = Math.min(20, Math.max(1, Math.ceil((Date.now() - oldest.getTime()) / (365 * 86400 * 1000)) + 1));

        if (this._historicalFxMapCache
            && this._historicalFxMapCache.rangeYears >= yearsNeeded
            && (Date.now() - this._historicalFxMapCache.fetchedAt) < 3600000) {
            return this._historicalFxMapCache.map;
        }

        const map = await this.fetchHistoricalFxRateMap('EURUSD=X', yearsNeeded);
        this._historicalFxMapCache = { map, rangeYears: yearsNeeded, fetchedAt: Date.now() };
        return map;
    }

    // Lecture SYNCHRONE de la dernière map FX historique déjà résolue (voir
    // getHistoricalFxMap ci-dessus) — pour les rendus synchrones (ex: sous-lignes
    // d'achat d'investmentsPage.js) qui ne peuvent pas attendre un nouvel appel
    // réseau. Retourne une Map vide tant qu'aucun appel async n'a encore résolu de
    // map pour cette session : le taux courant reste alors utilisé en repli
    // explicite (voir resolveHistoricalUsdToEurRate), jamais un taux inventé.
    getCachedHistoricalFxMap() {
        return this._historicalFxMapCache?.map || new Map();
    }

    // Thin wrapper — la logique elle-même vit dans MarketUtils.js
    // (resolveHistoricalUsdToEurRate) pour être partagée avec HistoryCalculator.js
    // sans deux implémentations indépendantes de la même règle.
    _resolveHistoricalUsdToEurRate(dateInput, historicalFxMap, fallbackRate, context = {}) {
        return resolveHistoricalUsdToEurRate(dateInput, historicalFxMap, fallbackRate, context);
    }

    // SINGLE SOURCE OF TRUTH pour l'accroissement immobilier (intérêts simples),
    // utilisé par calculateHoldings, calculateEnrichedPurchases et realEstateApp.js.
    // Formule : Investi * (Taux/100) * (Jours détenus / 365).
    calculateRealEstateAccrual(purchase, asOfDate = new Date()) {
        const yieldPct = purchase.yield || 0;
        const startDate = new Date(purchase.date);
        const daysHeld = Math.max(0, (asOfDate - startDate) / (1000 * 60 * 60 * 24));
        const invested = purchase.price * purchase.quantity;
        const accrued = invested * (yieldPct / 100) * (daysHeld / 365);
        return { invested, accrued, currentValue: invested + accrued, daysHeld };
    }

    // SINGLE SOURCE OF TRUTH pour le ledger de positions : construit des
    // positions ISOLÉES par (courtier, ticker) — jamais fusionnées entre
    // courtiers avant qu'une vente ne s'applique.
    //
    // BUG FOUND (architectural, confirmé) : l'ancien calculateHoldings
    // fusionnait directement par ticker seul. Une vente chez UN courtier
    // réduisait alors le coût de revient au prorata de la quantité FUSIONNÉE
    // (tous courtiers confondus), pas seulement celle de ce courtier. Exemple
    // réel : 10 AAPL @100€ chez A + 10 AAPL @200€ chez B (30€/action de coût
    // moyen fusionné sur 20 titres = 3000€), puis vente des 10 AAPL de A. Le
    // modèle fusionné réduisait l'investi de 50% (ratio = 10 vendus / 20
    // détenus) → 1500€ restants, alors que les 10 actions RÉELLEMENT encore
    // détenues (chez B, jamais touchées) avaient coûté 2000€ — un écart de
    // 500€ sur ce seul exemple, qui se répercutait autant sur le total
    // portefeuille que sur la ventilation par courtier (elles partagent la
    // même erreur, donc "les sommes tombaient juste" n'aurait rien prouvé).
    //
    // Fix : chaque (courtier, ticker) a sa propre quantité et son propre coût
    // de revient, mis à jour uniquement par LES ACHATS/VENTES DE CE COURTIER.
    // calculateHoldings (vue par ticker) et calculateByBroker (vue par
    // courtier) sont désormais deux agrégations DIFFÉRENTES des MÊMES
    // positions — jamais deux calculs indépendants — donc la somme des
    // courtiers égale le total du portefeuille par construction algébrique,
    // et le coût de revient de chaque courtier est réellement le sien.
    _buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap = null) {
        const sorted = [...assetPurchases].sort((a, b) => new Date(a.date) - new Date(b.date));
        const positions = new Map(); // key: `${broker}::${ticker}`

        sorted.forEach(p => {
            const ticker = p.ticker.toUpperCase();
            const broker = p.broker || 'RV-CT';
            const key = `${broker}::${ticker}`;
            if (!positions.has(key)) {
                positions.set(key, {
                    ticker, broker,
                    name: p.name,
                    assetType: p.assetType || 'Stock',
                    quantity: 0,
                    invested: 0,
                    purchases: []
                });
            }
            const pos = positions.get(key);
            const currency = p.currency || 'EUR';

            if (p.quantity > 0) {
                // ACHAT — le coût EUR est figé au taux du JOUR DE L'ACHAT (invariant 9),
                // jamais au taux courant : voir _resolveHistoricalUsdToEurRate.
                const rate = currency === 'USD'
                    ? this._resolveHistoricalUsdToEurRate(p.date, historicalFxMap, dynamicRate, { ticker, broker })
                    : 1;
                pos.quantity += p.quantity;
                pos.invested += p.price * p.quantity * rate;
            } else {
                // VENTE — n'impacte QUE la position de ce courtier pour ce ticker
                const sellQty = Math.abs(p.quantity);
                const currentQty = pos.quantity;

                if (currentQty > 0) {
                    const ratio = sellQty / currentQty;
                    pos.invested -= (pos.invested * ratio);
                    pos.quantity -= sellQty;
                } else {
                    pos.quantity -= sellQty;
                }

                if (pos.quantity <= 0.0001) {
                    pos.quantity = 0;
                    pos.invested = 0;
                }
            }
            pos.purchases.push(p);
        });

        return [...positions.values()];
    }

    // Enrichit une position déjà agrégée (quantité + coût de revient) avec le
    // prix de marché courant : currentValue, gainEUR, gainPct, avgPrice,
    // dayChange. SEULE implémentation de cette logique — réutilisée à la fois
    // pour la vue par ticker (calculateHoldings, ci-dessous) et par courtier
    // (calculateByBroker), pour que les deux restent cohérentes par
    // construction plutôt que deux copies de la même formule.
    // `resolvedPrices` (optionnel) : Map ticker -> {price, currency, previousClose,
    // lastUpdate} déjà résolue par HistoryCalculator pour CE MÊME instant (voir
    // buildTodaySnapshot ci-dessous). Quand elle est fournie, on l'utilise à la
    // place d'une nouvelle lecture de storage.getCurrentPrice — sinon Total Value
    // (ici) et le dernier point du graphique (HistoryCalculator) peuvent lire le
    // prix "courant" à deux instants légèrement différents et donc deux valeurs
    // différentes pour le même ticker au même instant affiché (c'est la cause
    // racine de l'incohérence Fin/Total Value/tooltip — voir audit).
    _enrichAggregatedPosition(ticker, data, dynamicRate, yesterdayCloseMap, resolvedPrices = null) {
        const d = resolvedPrices?.get(ticker) || this.storage.getCurrentPrice(ticker) || {};
        const currency = d.currency || 'EUR';

        // currentRate convertit le prix de marché courant pour les actifs USD
        // (ex: BKSY) — data.invested est déjà en EUR (converti achat par achat).
        const currentRate = (currency === 'USD') ? dynamicRate : 1;
        const previousClose = d.previousClose;

        let currentPrice = d.price;
        let currentValue = null;
        let investedEUR = data.invested;

        // DIAGNOSTIC — deux cas distincts, le premier bien plus grave que le
        // second :
        //
        // 1. AUCUN prix du tout (currentPrice absent) : ce titre est compté
        //    dans investedEUR (ci-dessous, inconditionnel) mais contribue 0 à
        //    currentValue/gainEUR — son Total Return est donc amputé de la
        //    TOTALITÉ de son montant investi, pas juste de son gain. C'est
        //    exactement ce qui arrive à un projet immobilier/crowdfunding mal
        //    étiqueté (assetType ≠ "Real Estate" exactement, ex. après un
        //    import CSV — voir csvWorker.js) dont le nom de projet se
        //    retrouve traité comme un ticker boursier introuvable (aucun prix
        //    ne pourra jamais se résoudre pour "Foncière Redland").
        // 2. Prix présent mais pas "frais" au sens de HistoryCalculator.js
        //    (qui ne réutilise le prix live pour le dernier point du jour que
        //    s'il a moins de 10 minutes, sinon retombe sur la bougie intraday
        //    la plus récente — cette fonction-ci n'a pas accès aux bougies,
        //    elle ne PEUT PAS appliquer la même règle) : écart plus faible,
        //    de l'ordre du prix, pas de l'investi entier.
        //
        // Permet d'identifier PRÉCISÉMENT quel(s) titre(s) expliquent un
        // écart entre une page utilisant calculateHoldings (Analytics,
        // Achats) et le Dashboard/Investments (moteur graphique), au lieu de
        // deviner sur le total global.
        if (data.assetType !== 'Real Estate') {
            if (!(currentPrice > 0)) {
                console.error(`[calculateHoldings] AUCUN PRIX pour "${ticker}" (assetType="${data.assetType}") — ${investedEUR.toFixed(2)}€ investis comptés dans le total mais 0€ de valeur de marché : le Total Return de cette page est amputé de ${investedEUR.toFixed(2)}€ à cause de ce seul titre. Si "${ticker}" est en réalité un projet immobilier/crowdfunding, corrige son Type d'actif (page Achats) sur exactement "Real Estate".`);
            } else {
                const ageMin = d.lastUpdate ? (Date.now() - d.lastUpdate) / 60000 : null;
                if (ageMin === null || ageMin > 10) {
                    console.warn(`[calculateHoldings] Prix possiblement périmé pour ${ticker} : ${ageMin === null ? 'jamais mis à jour' : ageMin.toFixed(1) + ' min'} — le Dashboard (moteur graphique) peut avoir choisi un prix différent pour ce même titre à cet instant.`);
                }
            }
        }

        // === SPECIAL LOGIC: REAL ESTATE ===
        // Real Estate assets don't have a market price. We calculate value based on linear interest.
        if (data.assetType === 'Real Estate') {
            let totalREValue = 0;
            let totalREInvested = 0;

            data.purchases.forEach(p => {
                // BUG DE CONCEPTION DOCUMENTÉ (audit invariants, non corrigé faute de
                // spécification produit) : contrairement aux actions/ETF/crypto, une
                // "vente" (quantité négative) sur une ligne Real Estate n'est PAS
                // réduite proportionnellement au coût de revient (voir
                // _buildPositionsByBrokerTicker) — calculateRealEstateAccrual applique
                // sa formule d'intérêts simples telle quelle à une quantité négative.
                // Le résultat n'est pas garanti cohérent avec l'invariant
                // currentValue - invested = return pour ce ticker. Un projet
                // immobilier n'est normalement jamais revendu par fraction dans ce
                // produit (durée figée, pas de marché secondaire) — ce garde-fou sert
                // à détecter le cas s'il survient plutôt que d'afficher un chiffre
                // silencieusement faux.
                if (p.quantity < 0) {
                    console.warn(`[RealEstate] Vente détectée sur "${ticker}" (broker ${p.broker}) — le modèle Real Estate ne réduit pas proportionnellement le coût de revient comme pour un actif coté. Vérifier manuellement "Investi"/"Valeur actuelle" pour ce ticker.`);
                }
                const { invested: pInvested, currentValue: pCurrentValue } = this.calculateRealEstateAccrual(p);
                totalREInvested += pInvested;
                totalREValue += pCurrentValue;
            });

            investedEUR = totalREInvested;
            currentValue = totalREValue;
            if (data.quantity > 0) {
                currentPrice = currentValue / data.quantity;
            }
        } else {
            currentValue = currentPrice ? currentPrice * data.quantity * currentRate : null;
        }

        const avgPriceEUR = (data.quantity > 0) ? investedEUR / data.quantity : 0;

        const currentValueEUR = currentValue ?? null;
        const gainEUR = currentValueEUR !== null ? currentValueEUR - investedEUR : null;
        const gainPct = investedEUR > 0 && gainEUR !== null ? (gainEUR / investedEUR) * 100 : null;

        let dayChange = null;
        let dayPct = null;
        let usedYesterdayCloseMap = false;

        // LOGIQUE CORRIGÉE : Utiliser yesterdayCloseMap en priorité.
        // HistoryCalculator calcule finement la vraie clôture de la veille (ou le prix à minuit pour les cryptos)
        // en gérant les fallbacks Binance. yesterdayCloseMap contient la VALEUR TOTALE (prix * qty).
        if (yesterdayCloseMap && yesterdayCloseMap.has(ticker) && yesterdayCloseMap.get(ticker) !== null) {
            const mapEntry = yesterdayCloseMap.get(ticker);
            const yesterdayTotal = (typeof mapEntry === 'object') ? mapEntry.yesterdayClose : mapEntry;
            const todayYestQty = (typeof mapEntry === 'object') ? mapEntry.todayValueOfYesterdayHoldings : null;

            if (yesterdayTotal > 0 && currentValueEUR !== null) {
                const referenceCurrentValue = (todayYestQty !== null && todayYestQty > 0)
                    ? todayYestQty
                    : currentValueEUR;
                dayChange = referenceCurrentValue - yesterdayTotal;
                dayPct = (dayChange / yesterdayTotal) * 100;
                usedYesterdayCloseMap = true;
            } else if (yesterdayTotal === 0) {
                dayChange = 0;
                dayPct = 0;
                usedYesterdayCloseMap = true;
            }
        }

        // FALLBACK : Si yesterdayCloseMap n'a rien trouvé, on utilise storage.previousClose
        if (!usedYesterdayCloseMap && currentPrice && currentPrice > 0) {
            const effectivePreviousClose = (previousClose && previousClose > 0) ? previousClose : currentPrice;

            if (effectivePreviousClose !== currentPrice) {
                dayPct = ((currentPrice - effectivePreviousClose) / effectivePreviousClose) * 100;
                dayChange = (currentPrice - effectivePreviousClose) * data.quantity * currentRate;
            } else {
                dayChange = 0;
                dayPct = 0;
            }
        }

        return {
            ticker,
            name: data.name,
            assetType: data.assetType,
            quantity: data.quantity,
            avgPrice: avgPriceEUR,
            invested: investedEUR,
            currentPrice: currentPrice ? currentPrice * currentRate : null,
            currentValue: currentValueEUR,
            gainEUR,
            gainPct,
            dayChange,
            dayPct,
            weight: 0,
            purchases: data.purchases
        };
    }

    // SINGLE SOURCE OF TRUTH pour l'investi par courtier SANS valeur de marché
    // (pas d'appel réseau) — agrège les MÊMES positions (broker,ticker) que
    // calculateHoldings, jamais une resommation indépendante des transactions
    // brutes. Utilisée par assistantApp.js à la place de son ancienne boucle
    // `+= p.price * p.quantity` qui ne gérait ni la conversion FX, ni la
    // réduction proportionnelle du coût de revient sur une vente (voir audit).
    getInvestedByBroker(assetPurchases, historicalFxMap = null) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap)
            .filter(pos => (pos.quantity || 0) > 0.0001);

        const byBroker = new Map();
        positions.forEach(pos => {
            if (!byBroker.has(pos.broker)) {
                byBroker.set(pos.broker, { broker: pos.broker, invested: 0, transactionsCount: 0, assets: new Set() });
            }
            const entry = byBroker.get(pos.broker);
            entry.invested += pos.invested;
            entry.transactionsCount += pos.purchases.length;
            entry.assets.add(pos.ticker);
        });
        return [...byBroker.values()];
    }

    // `priceSnapshot` (optionnel) : { dynamicRate, prices } déjà résolu par
    // buildTodaySnapshot() ci-dessous, pour que Total Value (ici) et le dernier
    // point du graphique (HistoryCalculator) partagent EXACTEMENT le même taux de
    // change et les mêmes prix "courants" — jamais deux lectures indépendantes de
    // storage à deux instants différents pour le même rendu. Sans snapshot fourni
    // (compatibilité des appelants existants), le comportement est inchangé :
    // lecture directe de storage à l'instant de l'appel.
    calculateHoldings(assetPurchases, yesterdayCloseMap = null, historicalFxMap = null, priceSnapshot = null) {
        const dynamicRate = priceSnapshot?.dynamicRate ?? (this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE);
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap);

        // Agrégation par TICKER (une ligne par actif, tous courtiers
        // confondus) — même vue qu'avant pour le tableau/les résumés, mais
        // calculée en sommant des positions par courtier déjà correctement
        // isolées, au lieu de fusionner dès le départ.
        const byTicker = new Map();
        positions.forEach(pos => {
            if (!byTicker.has(pos.ticker)) {
                byTicker.set(pos.ticker, { name: pos.name, assetType: pos.assetType, quantity: 0, invested: 0, purchases: [] });
            }
            const agg = byTicker.get(pos.ticker);
            agg.quantity += pos.quantity;
            agg.invested += pos.invested;
            agg.purchases.push(...pos.purchases);
        });
        byTicker.forEach(agg => agg.purchases.sort((a, b) => new Date(a.date) - new Date(b.date)));

        return Array.from(byTicker.entries()).map(([ticker, data]) =>
            this._enrichAggregatedPosition(ticker, data, dynamicRate, yesterdayCloseMap, priceSnapshot?.prices)
        );
    }

    calculateSummary(holdings) {
        let totalInvestedEUR = 0;
        let totalCurrentEUR = 0;
        let totalDayChangeEUR = 0;
        const assetTotalPerformances = [];
        const assetDayPerformances = [];

        const sectorStats = {};

        holdings.forEach(asset => {
            totalInvestedEUR += asset.invested || 0;
            totalCurrentEUR += asset.currentValue || 0;
            totalDayChangeEUR += asset.dayChange || 0;

            const type = asset.assetType || 'Other';
            if (!sectorStats[type]) {
                sectorStats[type] = { value: 0, name: type };
            }
            sectorStats[type].value += (asset.currentValue || 0);

            if (asset.currentValue !== null) {
                assetTotalPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    gainPct: asset.gainPct || 0,
                    gain: asset.gainEUR || 0,
                    currentValue: asset.currentValue,
                    currentPrice: asset.currentPrice
                });

                assetDayPerformances.push({
                    ticker: asset.ticker,
                    name: asset.name,
                    dayPct: asset.dayPct || 0,
                    dayChange: asset.dayChange || 0
                });
            }
        });

        let bestSector = { name: '-', value: 0, pct: 0 };
        if (totalCurrentEUR > 0) {
            let maxVal = -1;
            Object.values(sectorStats).forEach(s => {
                if (s.value > maxVal) {
                    maxVal = s.value;
                    bestSector = {
                        name: s.name,
                        value: s.value,
                        pct: (s.value / totalCurrentEUR) * 100
                    };
                }
            });
        }

        const gainTotal = totalCurrentEUR - totalInvestedEUR;
        const gainPct = totalInvestedEUR > 0 ? (gainTotal / totalInvestedEUR) * 100 : 0;

        const totalPreviousCloseEUR = totalCurrentEUR - totalDayChangeEUR;
        const dayChangePct = totalPreviousCloseEUR > 0
            ? (totalDayChangeEUR / totalPreviousCloseEUR) * 100
            : 0;

        const sortedTotal = assetTotalPerformances.sort((a, b) => b.gainPct - a.gainPct);
        const bestAsset = sortedTotal.length > 0 ? sortedTotal[0] : null;
        const worstAsset = sortedTotal.length > 0 ? sortedTotal[sortedTotal.length - 1] : null;

        const sortedDay = assetDayPerformances.sort((a, b) => b.dayPct - a.dayPct);
        const bestDayAsset = sortedDay.length > 0 ? sortedDay[0] : null;
        const worstDayAsset = sortedDay.length > 0 ? sortedDay[sortedDay.length - 1] : null;

        return {
            totalInvestedEUR,
            totalCurrentEUR,
            totalDayChangeEUR,
            gainTotal,
            gainPct,
            dayChangePct,
            bestAsset,
            worstAsset,
            bestDayAsset,
            worstDayAsset,
            // SINGLE SOURCE OF TRUTH pour les cartes "Top Gainer/Top Loser" (top/bottom
            // 3), pour que dashboardApp.js n'ait plus besoin de re-trier holdings lui-même.
            topPerformers: sortedTotal.slice(0, 3),
            worstPerformers: sortedTotal.slice(-3).reverse(),
            topSector: bestSector,
            assetsCount: holdings.length,
            movementsCount: holdings.reduce((sum, h) => sum + h.purchases.length, 0)
        };
    }

    calculateEnrichedPurchases(filteredPurchases, historicalFxMap = null) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

        return filteredPurchases.map(p => {
            if (p.assetType === 'Cash') {
                return {
                    ...p,
                    currency: 'EUR',
                    currentPriceOriginal: null,
                    buyPriceOriginal: p.price,
                    currentPriceEUR: null,
                    investedEUR: null,
                    currentValueEUR: null,
                    gainEUR: p.price,
                    gainPct: null
                };
            }

            // === SPECIAL LOGIC: REAL ESTATE ===
            if (p.assetType === 'Real Estate') {
                const { invested, accrued, currentValue: currentVal } = this.calculateRealEstateAccrual(p);

                return {
                    ...p,
                    assetType: 'Real Estate',
                    broker: p.broker,
                    currency: p.currency || 'EUR',
                    currentPriceOriginal: currentVal / p.quantity, // Simulated unit price
                    buyPriceOriginal: p.price,
                    currentPriceEUR: currentVal / p.quantity,
                    investedEUR: invested,
                    currentValueEUR: currentVal,
                    gainEUR: accrued,
                    gainPct: (accrued / invested) * 100
                };
            }

            const t = p.ticker.toUpperCase();
            const d = this.storage.getCurrentPrice(t) || {};
            const assetCurrency = d.currency || p.currency || 'EUR';
            const currentPriceOriginal = d.price ?? null;
            const buyPriceOriginal = p.price;

            // currentPriceOriginal is already in EUR — storage.js converts USD→EUR at storage time
            const currentPriceEUR = currentPriceOriginal ?? null;
            // buyPriceOriginal is in p.currency (original purchase currency, never converted by storage).
            // Figé au taux DE CETTE TRANSACTION (invariant 9) — jamais au taux courant,
            // sinon "Investi" bouge tout seul quand le taux change sans nouvelle transaction.
            const buyRate = p.currency === 'USD'
                ? this._resolveHistoricalUsdToEurRate(p.date, historicalFxMap, dynamicRate, { ticker: t, broker: p.broker })
                : 1;
            const buyPriceEUR = buyPriceOriginal * buyRate;

            const investedEUR = buyPriceEUR * p.quantity;
            const currentValueEUR = currentPriceEUR ? currentPriceEUR * p.quantity : null;
            const gainEUR = currentValueEUR !== null ? currentValueEUR - investedEUR : null;
            const gainPct = investedEUR > 0 && gainEUR !== null ? (gainEUR / investedEUR) * 100 : null;

            return {
                ...p,
                assetType: p.assetType || 'Stock',
                broker: p.broker || 'RV-CT',
                currency: assetCurrency,
                currentPriceOriginal,
                buyPriceOriginal,
                currentPriceEUR,
                investedEUR,
                currentValueEUR,
                gainEUR,
                gainPct
            };
        });
    }

    // === CACHE MANAGEMENT FOR FAST LOADING ===

    /**
     * Load cached portfolio data from Firestore
     * @returns {Object|null} Cached data or null if not available/fresh
     */
    /**
     * Load cached portfolio data (Priority: LocalStorage -> Firestore)
     * @returns {Object|null} Cached data or null if not available/fresh
     */
    async loadCachedData() {
        const CACHE_KEY = 'portfolio_snapshot_cache';
        const MAX_AGE = 3600000; // 1 hour

        // 1. Try LocalStorage FIRST (Fastest, Offline-capable)
        try {
            const localRaw = localStorage.getItem(CACHE_KEY);
            if (localRaw) {
                const localCache = JSON.parse(localRaw);
                const age = Date.now() - localCache.timestamp;
                if (age < MAX_AGE) {
                    console.log(`[Cache] ✅ Loaded from LocalStorage (age: ${Math.round(age / 1000)}s)`);
                    return localCache.data;
                }
            }
        } catch (e) {
            console.warn('[Cache] LocalStorage read failed:', e);
        }

        // 2. Fallback to Firestore (if online & user logged in)
        const user = auth.currentUser;
        if (!user) return null;

        try {
            const cacheDoc = await db.collection('users')
                .doc(user.uid)
                .collection('cache')
                .doc('portfolioSnapshot')
                .get();

            if (cacheDoc.exists) {
                const cached = cacheDoc.data();
                const normalizedTs = cached.timestamp?.toMillis ? cached.timestamp.toMillis() : cached.timestamp;
                const cacheAge = Date.now() - normalizedTs;

                if (cacheAge < MAX_AGE) {
                    console.log(`[Cache] ✅ Loaded from Firestore (age: ${Math.round(cacheAge / 1000)}s)`);
                    try {
                        localStorage.setItem(CACHE_KEY, JSON.stringify({ ...cached, timestamp: normalizedTs }));
                    } catch (e) { }
                    return cached.data;
                } else {
                    console.log(`[Cache] ⏰ Firestore Cache expired (age: ${Math.round(cacheAge / 1000)}s)`);
                }
            }
        } catch (error) {
            console.warn('[Cache] Firestore load failed:', error);
        }

        return null;
    }

    /**
     * Save portfolio snapshot (Dual Write: LocalStorage + Firestore)
     * @param {Object} data - Full report data to cache
     */
    async saveCacheSnapshot(data) {
        const CACHE_KEY = 'portfolio_snapshot_cache';
        const payload = {
            data: data,
            timestamp: Date.now(),
            version: '1.0'
        };

        // 1. Save to LocalStorage (Always works, synchronous)
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
            console.log('[Cache] 💾 Snapshot saved to LocalStorage');
        } catch (e) {
            console.error('[Cache] LocalStorage save failed (Quota?):', e);
        }

        // 2. Save to Firestore (Best effort with TIMEOUT)
        // We use a timeout because Firestore SDK hangs indefinitely on "Quota Exceeded" retries
        const user = auth.currentUser;
        if (user) {
            try {
                const firestoreWrite = db.collection('users')
                    .doc(user.uid)
                    .collection('cache')
                    .doc('portfolioSnapshot')
                    .set(payload);

                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Firestore write timed out (Quota/Network)')), 2000)
                );

                await Promise.race([firestoreWrite, timeout]);
                console.log('[Cache] ☁️ Snapshot saved to Firestore');
            } catch (error) {
                // Do NOT throw. Just log warning. This prevents UI blocking.
                console.warn('[Cache] ⚠️ Firestore save failed/skipped:', error.message);
            }
        }
    }

    generateFullReport(purchases, yesterdayCloseMap = null, historicalFxMap = null) {
        // Exclude Dividends from Asset Holdings
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
        });
        // Include Dividends in Cash Purchases (so they appear in Cash Reserve, if logic supports it)
        const cashPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type === 'cash' || type === 'dividend' || p.type === 'dividend';
        });

        let holdings = this.calculateHoldings(assetPurchases, yesterdayCloseMap, historicalFxMap);

        // CRITICAL FIX: Filter out zero-quantity holdings (fully sold assets)
        // This prevents sold assets from appearing in analytics and causing errors
        holdings = holdings.filter(h => (h.quantity || 0) > 0.0001);

        // Analytics deliberately includes Real Estate in its headline Total
        // Return (unlike Dashboard/Investments) — it's the one page meant to
        // show the WHOLE portfolio in one number. Reverted the exclusion I
        // added here earlier; see calculateHoldings's diagnostic logging
        // instead for the actual ~285-300€ gap this page can still show vs
        // Dashboard's own Total Return (a stock-side price-source difference,
        // not a Real Estate scope issue — see notes in _enrichAggregatedPosition).
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases);

        const dividendsReceived = cashPurchases
            .filter(p => (p.assetType || '').toLowerCase() === 'dividend' || p.type === 'dividend')
            .reduce((sum, p) => sum + (p.price || 0) * (p.quantity || 1), 0);

        // Calculate performance before creating summary to get winRate
        const performance = this.analyzePerformance(holdings);

        holdings.forEach(asset => {
            asset.weight = summary.totalCurrentEUR > 0 ? (asset.currentValue / summary.totalCurrentEUR) * 100 : 0;
        });
        return {
            summary: {
                totalValue: summary.totalCurrentEUR,
                totalInvested: summary.totalInvestedEUR,
                totalGain: summary.gainTotal,
                totalGainPct: summary.gainPct,
                dayChange: summary.totalDayChangeEUR,
                dayChangePct: summary.dayChangePct,
                cashReserve: cashReserve.total,
                dividendsReceived,
                winRate: performance.winRate  // Add winRate to summary
            },
            diversification: this.calculateDiversification(holdings),
            performance: performance,  // Use already calculated performance
            risk: this.calculateRisk(holdings),
            assets: holdings,
            generatedAt: new Date().toISOString()
        };
    }

    // Net quantity of each ticker held THROUGH each broker (buys minus sells,
    // counting only that broker's own purchases) — the basis used below to
    // split a merged, portfolio-wide holding's gain/invested/dayChange across
    // the brokers that actually hold it.
    _brokerQuantitiesByTicker(assetPurchases) {
        const map = new Map(); // ticker -> Map(broker -> netQty)
        assetPurchases.forEach(p => {
            const ticker = p.ticker.toUpperCase();
            const broker = p.broker || 'RV-CT';
            if (!map.has(ticker)) map.set(ticker, new Map());
            const brokerMap = map.get(ticker);
            brokerMap.set(broker, (brokerMap.get(broker) || 0) + (parseFloat(p.quantity) || 0));
        });
        return map;
    }

    // SINGLE SOURCE OF TRUTH pour la ventilation par courtier — Total Value /
    // Investi / Rendement total (utilisée par la modale "Détail — Total
    // Value", voir ui.js).
    //
    // BUG FOUND (confirmé, deux fois, corrigés) :
    // 1. L'immobilier ('real estate') était inclus ici alors que
    //    historicalChart.js l'EXCLUT de l'agrégat "Total Return" (son
    //    update(), filtre `type !== 'real estate'`) — exclu ici aussi.
    // 2. (architectural) Une v1 recalculait chaque courtier INDÉPENDAMMENT
    //    (calculateHoldings sur les seuls achats de ce courtier) ; une v2
    //    répartissait ensuite un total déjà fusionné au prorata de la
    //    quantité — les deux souffrent de la MÊME racine : calculateHoldings
    //    fusionnait le coût de revient par ticker AVANT qu'une vente d'un
    //    courtier ne s'applique, donc une vente chez un courtier pouvait
    //    réduire le coût de revient reconstitué d'un AUTRE courtier qui
    //    n'avait rien vendu (voir _buildPositionsByBrokerTicker ci-dessus).
    //
    // Fix définitif : ne calcule plus rien ici. Agrège directement les
    // positions (courtier, ticker) déjà correctement isolées — LA MÊME
    // source que calculateHoldings (vue par ticker) — juste groupées par
    // courtier au lieu du ticker. Les deux vues sont deux agrégations
    // différentes des mêmes positions, jamais deux calculs séparés : la somme
    // des courtiers égale le total du portefeuille par construction, ET le
    // coût de revient de chaque courtier est réellement le sien.
    //
    // BUG FOUND (confirmé, un 3e niveau) : même avec le coût de revient
    // (invested) désormais correct par courtier, la VALEUR DE MARCHÉ
    // courante restait calculée différemment d'ici (storage.getCurrentPrice
    // brut, sans condition) et de l'agrégat affiché ailleurs dans l'app
    // (historicalChart.js → HistoryCalculator, qui ne réutilise le prix
    // "live" pour le dernier point du jour QUE s'il a moins de 10 minutes,
    // sinon retombe sur la dernière bougie intraday déjà récupérée). Sur un
    // titre dont le snapshot live n'a pas été rafraîchi depuis >10 min au
    // moment du calcul, les deux méthodes peuvent choisir un prix différent
    // — confirmé comme cause d'un écart de ~300€ sur ce portefeuille (la
    // page filtrée sur un courtier, qui passe par HistoryCalculator, et la
    // modale, qui ne l'utilisait pas, ne choisissaient pas le même prix pour
    // le même titre au même instant).
    //
    // Fix : recalculer le rendement PAR COURTIER en relançant EXACTEMENT le
    // même moteur (calculateHistory → HistoryCalculator) que l'agrégat — pas
    // storage.getCurrentPrice en direct. Contrairement à Var Today (voir
    // calculateDayChangeByBroker plus bas, qui NE PEUT PAS faire ça à cause
    // du rescaling non-linéaire du TWR), Total Value est une simple somme
    // prix × quantité : linéaire, donc un rejeu par courtier se recompose
    // exactement en le total du portefeuille. Async (un appel réseau par
    // courtier) — ne se déclenche qu'à l'ouverture de la modale (voir ui.js).
    async calculateReturnByBroker(purchases) {
        const brokers = [...new Set(purchases.map(p => p.broker || 'RV-CT'))];
        const historicalFxMap = await this.getHistoricalFxMap(purchases);

        const results = await Promise.all(brokers.map(async (broker) => {
            const brokerPurchases = purchases.filter(p => (p.broker || 'RV-CT') === broker);
            const assetPurchases = brokerPurchases.filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
            });
            const cashPurchases = brokerPurchases.filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type === 'cash' || type === 'dividend' || p.type === 'dividend';
            });

            const cashReserve = this.calculateCashReserve(cashPurchases);
            const cash = cashReserve.total;

            if (assetPurchases.length === 0) {
                return { broker, invested: 0, totalReturn: 0, totalReturnPct: 0, totalValue: cash, cash };
            }

            // Coût de revient : synchrone, déjà correct (positions isolées
            // par courtier, voir _buildPositionsByBrokerTicker ci-dessus).
            const holdings = this.calculateHoldings([...assetPurchases], null, historicalFxMap).filter(h => (h.quantity || 0) > 0.0001);
            const invested = holdings.reduce((s, h) => s + (h.invested || 0), 0);

            // Valeur de marché : LE MÊME appel que historicalChart.js fait
            // pour l'agrégat portefeuille (this.dataManager.calculateHistory),
            // juste restreint aux achats de ce courtier.
            const graphData = await this.calculateHistory([...assetPurchases, ...cashPurchases], 1);
            const values = graphData?.values;
            let totalValue = null;
            if (values) {
                for (let i = values.length - 1; i >= 0; i--) {
                    if (values[i] !== null && values[i] !== undefined && !isNaN(values[i])) { totalValue = values[i]; break; }
                }
            }
            if (totalValue === null) {
                // Repli si le graphique n'a rien retourné (ex: marché fermé
                // sans historique disponible) plutôt que de perdre ce courtier.
                totalValue = holdings.reduce((s, h) => s + (h.currentValue || 0), 0) + cash;
            }

            const totalReturn = totalValue - cash - invested;
            return {
                broker,
                invested,
                totalReturn,
                totalReturnPct: invested > 0 ? (totalReturn / invested) * 100 : 0,
                totalValue,
                cash
            };
        }));

        return results.sort((a, b) => b.totalValue - a.totalValue);
    }

    // SINGLE SOURCE OF TRUTH pour la variation du jour par courtier — même
    // principe que calculateByBroker ci-dessus (répartition d'un calcul
    // fusionné, pas un recalcul indépendant par courtier), appliqué à la
    // variation du jour plutôt qu'au rendement total.
    //
    // Une première version relançait le moteur TWR (calculateHistory) une
    // fois PAR courtier — en apparence plus rigoureux, mais souffre du même
    // problème que calculateByBroker v1 dès qu'un titre est partagé entre
    // courtiers (l'ancrage TWR ne se répartit pas linéairement). Remplacé par
    // calculateAllAssetsYesterdayClose() — LE MÊME calcul déjà utilisé pour la
    // colonne "Day P&L" du tableau des positions — appelé UNE SEULE FOIS pour
    // tout le portefeuille, puis réparti par courtier au prorata de la
    // quantité, exactement comme ci-dessus. Async (un seul appel réseau,
    // partagé) — ne se déclenche qu'à l'ouverture de la modale (voir ui.js).
    async calculateDayChangeByBroker(purchases) {
        const brokers = [...new Set(purchases.map(p => p.broker || 'RV-CT'))];
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
        });
        if (assetPurchases.length === 0) return brokers.map(broker => ({ broker, dayChange: 0, dayChangePct: 0 }));

        const yesterdayCloseMap = await this.calculateAllAssetsYesterdayClose(assetPurchases);
        const holdings = this.calculateHoldings([...assetPurchases], yesterdayCloseMap).filter(h => (h.quantity || 0) > 0.0001);
        const qtyByTickerByBroker = this._brokerQuantitiesByTicker(assetPurchases);

        const perBroker = new Map(brokers.map(b => [b, { dayChange: 0, yesterdayValue: 0 }]));
        holdings.forEach(h => {
            if (h.dayChange == null) return;
            const brokerQtys = qtyByTickerByBroker.get(h.ticker) || new Map();
            const totalQty = [...brokerQtys.values()].reduce((s, q) => s + q, 0);
            if (Math.abs(totalQty) < 0.000001) return;
            const yesterdayValue = (h.currentValue || 0) - h.dayChange;
            brokerQtys.forEach((qty, broker) => {
                const entry = perBroker.get(broker);
                if (!entry) return;
                const fraction = qty / totalQty;
                entry.dayChange += h.dayChange * fraction;
                entry.yesterdayValue += yesterdayValue * fraction;
            });
        });

        return brokers.map(broker => {
            const entry = perBroker.get(broker);
            return {
                broker,
                dayChange: entry.dayChange,
                dayChangePct: entry.yesterdayValue > 0 ? (entry.dayChange / entry.yesterdayValue) * 100 : 0
            };
        });
    }

    calculateDiversification(holdings) {
        const herfindahl = holdings.reduce((sum, asset) => sum + Math.pow(asset.weight / 100, 2), 0);
        const effectiveAssets = herfindahl > 0 ? 1 / herfindahl : 0;
        const maxDiversity = holdings.length;
        const diversityScore = maxDiversity > 0 ? (effectiveAssets / maxDiversity) * 100 : 0;
        return { herfindahl: herfindahl.toFixed(4), effectiveAssets: effectiveAssets.toFixed(2), diversityScore: diversityScore.toFixed(1), totalAssets: holdings.length, recommendation: this.getDiversificationAdvice(diversityScore, holdings.length) };
    }
    getDiversificationAdvice(score, assetCount) {
        if (assetCount < 5) return 'Portfolio très concentré.';
        if (score < 30) return 'Diversification faible.';
        if (score < 60) return 'Diversification moyenne.';
        if (score < 80) return 'Bonne diversification.';
        return 'Excellente diversification.';
    }
    analyzePerformance(holdings) {
        const sorted = [...holdings].sort((a, b) => b.gainPct - a.gainPct);
        const winners = sorted.filter(a => a.gainPct > 0);
        const losers = sorted.filter(a => a.gainPct < 0);
        const avgGain = holdings.length > 0 ? holdings.reduce((sum, a) => sum + (a.gainPct || 0), 0) / holdings.length : 0;
        const winRate = holdings.length > 0 ? (winners.length / holdings.length) * 100 : 0;
        return { topPerformers: sorted.slice(0, 3), worstPerformers: sorted.slice(-3).reverse(), winners: winners.length, losers: losers.length, avgGain: avgGain.toFixed(2), winRate: winRate.toFixed(1), summary: 'Performance analysée' };
    }
    calculateRisk(holdings) {
        if (holdings.length === 0) return { volatility: '0.00', maxDrawdown: '0.00', riskLevel: 'N/A', recommendation: 'Aucune donnée.' };
        const returns = holdings.map(a => a.gainPct || 0);
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);
        const maxDrawdown = Math.min(...returns.map(r => Math.min(r, 0)));
        return { volatility: volatility.toFixed(2), maxDrawdown: maxDrawdown.toFixed(2), riskLevel: volatility < 15 ? 'Faible' : 'Élevé', recommendation: 'Risque calculé' };
    }

    // === DIAGNOSTIC — LECTURE SEULE, NE MODIFIE JAMAIS LES DONNÉES ===
    //
    // Vérifie les invariants comptables du cahier des charges à partir des MÊMES
    // positions (broker,ticker) que calculateHoldings/calculateSummary — jamais un
    // recalcul séparé. Permet de diagnostiquer immédiatement un futur écart plutôt
    // que de deviner sur les totaux affichés. `assetPurchases`/`cashPurchases` sont
    // déjà le sous-ensemble pertinent (après filtres broker/ticker/type éventuels —
    // voir investmentsPage.getFilteredPurchasesFromPage) : le retour reflète alors
    // les invariants POUR CE SOUS-ENSEMBLE, pas nécessairement le portefeuille entier.
    validatePortfolioConsistency(assetPurchases, cashPurchases = [], historicalFxMap = null, tolerance = 0.01) {
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;

        const holdings = this.calculateHoldings(assetPurchases, null, historicalFxMap)
            .filter(h => (h.quantity || 0) > 0.0001);
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases || []);

        // Ventilation par courtier : ré-agrège les positions déjà isolées par
        // _buildPositionsByBrokerTicker (même source que calculateHoldings), jamais
        // un second calcul indépendant — la valeur de marché de chaque position
        // vient de _enrichAggregatedPosition, la MÊME fonction que calculateHoldings
        // utilise pour la vue par ticker.
        const positions = this._buildPositionsByBrokerTicker(assetPurchases, dynamicRate, historicalFxMap)
            .filter(pos => (pos.quantity || 0) > 0.0001);

        const byBrokerMap = new Map();
        positions.forEach(pos => {
            if (!byBrokerMap.has(pos.broker)) {
                byBrokerMap.set(pos.broker, { broker: pos.broker, invested: 0, currentValue: 0, return: 0, cash: 0 });
            }
            const entry = byBrokerMap.get(pos.broker);
            const enriched = this._enrichAggregatedPosition(pos.ticker, pos, dynamicRate, null);
            entry.invested += pos.invested || 0;
            entry.currentValue += enriched.currentValue || 0;
            entry.return += (enriched.currentValue || 0) - (pos.invested || 0);
        });

        // Inclut les courtiers qui ne détiennent QUE du cash (aucune position actif).
        Object.keys(cashReserve.byBroker || {}).forEach(broker => {
            if (!byBrokerMap.has(broker)) {
                byBrokerMap.set(broker, { broker, invested: 0, currentValue: 0, return: 0, cash: 0 });
            }
        });
        byBrokerMap.forEach((entry, broker) => {
            entry.cash = (cashReserve.byBroker || {})[broker] || 0;
            entry.totalValue = entry.currentValue + entry.cash;
        });

        const byBroker = [...byBrokerMap.values()];
        const sum = (key) => byBroker.reduce((s, b) => s + (b[key] || 0), 0);

        const global = {
            invested: summary.totalInvestedEUR || 0,
            currentValue: summary.totalCurrentEUR || 0,
            return: summary.gainTotal || 0,
            cash: cashReserve.total || 0,
            totalValue: (summary.totalCurrentEUR || 0) + (cashReserve.total || 0)
        };

        const differences = {
            // Invariants 1-3 : global vs somme des courtiers.
            invested: global.invested - sum('invested'),
            currentValue: global.currentValue - sum('currentValue'),
            return: global.return - sum('return'),
            cash: global.cash - sum('cash'),
            totalValue: global.totalValue - sum('totalValue'),
            // Invariant 4 : return === currentValue - invested.
            returnVsValueMinusInvested: global.return - (global.currentValue - global.invested),
            // Invariant 6 : totalValue === invested + return + cash.
            totalValueVsInvestedPlusReturnPlusCash: global.totalValue - (global.invested + global.return + global.cash)
        };

        const valid = Object.values(differences).every(d => Math.abs(d) <= tolerance);

        return { global, byBroker, differences, valid };
    }

    async calculateHistory(purchases, days) {
        const assetPurchases = purchases.filter(p => {
            const type = (p.assetType || 'Stock').toLowerCase();
            return type !== 'dividend' && p.type !== 'dividend';
        });
        return this.calculateGenericHistory(assetPurchases, days, false);
    }

    async calculateAssetHistory(ticker, days) {
        const purchases = this.storage.getPurchases()
            .filter(p => p.ticker.toUpperCase() === ticker.toUpperCase())
            .filter(p => {
                const type = (p.assetType || 'Stock').toLowerCase();
                return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend';
            });
        if (purchases.length === 0) return { labels: [], invested: [], values: [], yesterdayClose: null, unitPrices: [], purchasePoints: [], twr: [] };
        return this.calculateGenericHistory(purchases, days, true);
    }

    // === NOUVEAU : Calcul pour un Indice pur (Pour le Dashboard) ===
    async calculateIndexData(ticker, days) {
        const interval = getIntervalForPeriod(days);

        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));
        const endTs = Math.floor(todayUTC.getTime() / 1000);

        let startTs;
        if (days === 1) {
            startTs = endTs - (24 * 60 * 60) - (2 * 60 * 60);
        } else if (days === 7) {
            startTs = endTs - (7 * 24 * 60 * 60);
        } else if (days === 30) {
            startTs = endTs - (30 * 24 * 60 * 60);
        } else if (days === 90) {
            startTs = endTs - (90 * 24 * 60 * 60);
        } else if (days === 365) {
            startTs = endTs - (365 * 24 * 60 * 60);
        } else {
            startTs = endTs - (365 * 24 * 60 * 60);
        }

        const hist = await this.getHistoryWithCache(ticker, startTs, endTs, interval);

        const sortedTs = Object.keys(hist).map(Number).sort((a, b) => a - b);
        const labels = [];
        const values = [];
        const labelFn = getLabelFormat(days);

        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const startOfDayTs = startOfDay.getTime();

        const filteredTs = (days === 1)
            ? sortedTs.filter(ts => ts >= startOfDayTs)
            : sortedTs;

        filteredTs.forEach(ts => {
            labels.push(labelFn(ts));
            values.push(hist[ts]);
        });

        const priceData = this.storage.getCurrentPrice(ticker);
        const trueYesterdayClose = priceData?.previousClose || null;

        return {
            labels: labels,
            values: values,
            invested: [],
            unitPrices: values,
            purchasePoints: [],
            truePreviousClose: trueYesterdayClose // IMPORTANT : Exposed for ChartKPIManager
        }
    }

    // === SMART SYNC (Délégué) ===
    async getHistoryWithCache(ticker, startTs, endTs, interval) {
        return this.historyCalculator.getHistoryWithCache(ticker, startTs, endTs, interval);
    }

    // `dynamicRateOverride`/`historicalFxMapOverride` : quand fournis (voir
    // buildTodaySnapshot ci-dessous), on saute la résolution habituelle et on
    // utilise EXACTEMENT le taux déjà figé par l'appelant pour ce rendu — pour
    // que le graphique et calculateHoldings ne puissent jamais lire le taux
    // courant à deux instants différents.
    async calculateGenericHistory(purchases, days, isSingleAsset = false, dynamicRateOverride = null, historicalFxMapOverride = null) {
        // Le coût de revient du graphique (tooltip "Investi") doit être figé au même
        // taux historique que calculateHoldings pour la même transaction — sinon le
        // tooltip peut afficher un "Investi" différent du KPI "Investi" affiché juste
        // au-dessus, pour la même date, à cause du seul taux de change (invariant 9).
        const historicalFxMap = historicalFxMapOverride ?? await this.getHistoricalFxMap(purchases);
        return this.historyCalculator.calculateGenericHistory(purchases, days, isSingleAsset, historicalFxMap, dynamicRateOverride);
    }

    // ============================================================
    // SINGLE SOURCE OF TRUTH — SNAPSHOT FINANCIER "MAINTENANT"
    // ============================================================
    //
    // Cause racine (audit) : Total Value/Fin du graphique/tooltip du dernier
    // point/Clôture hier/Var Today étaient chacun capables de lire
    // storage.getCurrentPrice()/getConversionRate() à un instant légèrement
    // différent — HistoryCalculator (le graphique) et calculateHoldings (Total
    // Value) sont deux moteurs distincts qui, jusqu'ici, résolvaient chacun sa
    // propre idée de "maintenant". Un prix live rafraîchi entre les deux
    // lectures (ou un ticker dont le live est périmé >10min pour l'un mais pas
    // pour l'autre) produisait deux valorisations différentes du MÊME instant —
    // c'est ce qui rendait "Fin"/le tooltip du dernier point incohérents avec
    // la carte "Total Value"/"Var Today", même si chaque nombre pris
    // isolément était calculé correctement.
    //
    // Fix structurel : UNE seule fonction construit "l'état financier
    // maintenant" pour toute l'UI. Elle résout le graphique EN PREMIER — lui
    // seul sait retomber sur la dernière bougie si le prix live d'un ticker
    // est périmé (>10min), au lieu de fabriquer un faux dernier point — PUIS
    // réutilise EXACTEMENT les prix et le taux de change que le graphique
    // vient de résoudre (HistoryCalculator expose son propre "resolvedPrices",
    // construit à partir de ce qu'il a réellement utilisé pour son dernier
    // point) pour calculer holdings/summary/cash. Il n'existe plus de second
    // jeu de données pour le même instant : Total Value EST, par construction
    // algébrique, la valeur du dernier point du graphique "aujourd'hui".
    //
    // `snapshotStartedAt` est capturé AVANT tout await : un appelant peut s'en
    // servir pour ignorer un résultat plus ancien arrivé après un plus récent
    // (voir portfolioKPIs.updateFromGraph et historicalChart.js::update()).
    async buildTodaySnapshot(assetPurchases, cashPurchases = []) {
        const snapshotStartedAt = Date.now();
        const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || USD_TO_EUR_FALLBACK_RATE;
        const historicalFxMap = await this.getHistoricalFxMap(assetPurchases);

        const todayGraphData = await this.calculateGenericHistory(
            [...assetPurchases, ...cashPurchases], 1, false, dynamicRate, historicalFxMap
        );

        const holdings = this.calculateHoldings(assetPurchases, null, historicalFxMap, {
            dynamicRate, prices: todayGraphData.resolvedPrices
        });
        const summary = this.calculateSummary(holdings);
        const cashReserve = this.calculateCashReserve(cashPurchases);

        return { snapshotStartedAt, dynamicRate, historicalFxMap, todayGraphData, holdings, summary, cashReserve };
    }
}
