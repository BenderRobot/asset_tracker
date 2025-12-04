// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/historicalChart.js

// ========================================
// historicalChart.js - (v51 - Masquage Var Jour hors 1D)
// ========================================

import { eventBus } from './eventBus.js';

export class HistoricalChart {
    constructor(storage, dataManager, ui, investmentsPage) {
        this.storage = storage;
        this.dataManager = dataManager;
        this.ui = ui;
        this.investmentsPage = investmentsPage;

        this.chart = null;
        this.currentPeriod = 1;
        this.isLoading = false;
        this.currentMode = 'portfolio'; // 'portfolio', 'asset', ou 'index'
        this.selectedAssets = [];
        this.autoRefreshInterval = null;
        this.lastRefreshTime = null;
        this.lastYesterdayClose = null;
        this.customTitle = null;
        this.cached1DSummary = null; // Cache du summary 1D pour réutilisation
        this.cachedYesterdayCloseMap = null; // Cache du yesterdayCloseMap pour réutilisation
        this.cachedYesterdayCloseTimestamp = null; // Timestamp du cache
        this.YESTERDAY_CLOSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes en millisecondes

        this.filterManager = investmentsPage.filterManager;
        this.currentBenchmark = null;

        eventBus.addEventListener('showAssetChart', (e) => {
            // Mise à jour de l'état interne pour forcer la mise à jour par 'update'
            this.currentMode = 'asset';
            this.selectedAssets = [e.detail.ticker];
            this.update(true, false);
        });

        eventBus.addEventListener('clearAssetChart', () => {
            // Réinitialisation de l'état pour revenir au mode portefeuille/filtré
            this.currentMode = 'portfolio';
            this.selectedAssets = [];
            this.currentBenchmark = null;
            const benchmarkSelect = document.getElementById('benchmark-select');
            if (benchmarkSelect) benchmarkSelect.value = '';
            this.update(true, false);
        });
    }

    hexToRgba(hex, alpha) {
        let r = 0, g = 0, b = 0;
        if (hex.length === 4) {
            r = parseInt(hex[1] + hex[1], 16);
            g = parseInt(hex[2] + hex[2], 16);
            b = parseInt(hex[3] + hex[3], 16);
        } else if (hex.length === 7) {
            r = parseInt(hex.substring(1, 3), 16);
            g = parseInt(hex.substring(3, 5), 16);
            b = parseInt(hex.substring(5, 7), 16);
        }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    setupPeriodButtons() {
        document.querySelectorAll('.period-btn').forEach(btn => {
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);

            newBtn.addEventListener('click', (e) => {
                if (this.isLoading) return;
                const period = newBtn.dataset.period;

                document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
                newBtn.classList.add('active');

                this.currentPeriod = (period === 'all' ? 'all' : parseInt(period));
                this.changePeriod(this.currentPeriod);
            });
        });

        this.setupBenchmarkSelector();
    }

    setupBenchmarkSelector() {
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) {
            const newSelect = benchmarkSelect.cloneNode(true);
            benchmarkSelect.parentNode.replaceChild(newSelect, benchmarkSelect);
            newSelect.addEventListener('change', (e) => {
                this.currentBenchmark = e.target.value || null;
                this.update(true, false);
            });
        }
    }

    startAutoRefresh() {
        this.stopAutoRefresh();
        if (this.currentPeriod === 1) {
            setTimeout(() => {
                if (this.currentPeriod === 1) this.silentUpdate();
            }, 30000);
            this.autoRefreshInterval = setInterval(() => {
                if (this.currentPeriod === 1) this.silentUpdate();
            }, 5 * 60 * 1000);
        }
    }

    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    }

    async silentUpdate() {
        if (this.isLoading) return;
        const now = Date.now();
        if (this.lastRefreshTime && (now - this.lastRefreshTime) < 4 * 60 * 1000) return;

        this.lastRefreshTime = now;
        try {
            await this.update(false, true);
        } catch (error) {
            console.warn('Erreur refresh silencieux:', error);
        }
    }

    async loadPageWithCacheFirst() {
        return this.update(true, false);
    }

    async showIndex(ticker, name) {
        if (this.isLoading) return;
        await this.dataManager.api.fetchBatchPrices([ticker]);
        this.currentMode = 'index';
        this.selectedAssets = [ticker];
        this.customTitle = { label: name, icon: '🌎' };

        const headerControls = document.querySelector('.header-controls');
        if (headerControls && !document.getElementById('chart-back-btn')) {
            const btn = document.createElement('div');
            btn.id = 'chart-back-btn';
            btn.className = 'chart-reset-btn';
            btn.innerHTML = '<i class="fas fa-times"></i> Close';
            btn.onclick = () => {
                this.currentMode = 'portfolio';
                this.selectedAssets = [];
                this.customTitle = null;
                btn.remove();
                document.querySelectorAll('.market-card').forEach(c => c.classList.remove('active-index'));
                this.update(true, true);
            };
            headerControls.insertBefore(btn, headerControls.firstChild);
        }

        await this.update(true, true);
    }

    async showAssetChart(ticker, summary = null) {
        if (this.isLoading) return;
        this.currentMode = 'asset';
        this.selectedAssets = [ticker];

        const benchmarkWrapper = document.getElementById('benchmark-wrapper');
        if (benchmarkWrapper) benchmarkWrapper.style.display = 'none';

        await this.update(true, false);
    }

    async changePeriod(days) {
        if (this.isLoading) return;
        this.stopAutoRefresh();
        await this.update(true, true);
        this.startAutoRefresh();
    }

    syncSummaryWithChartData(summary, graphData) {
        const values = graphData.values;
        let lastValue = null;

        if (values && values.length > 0) {
            for (let i = values.length - 1; i >= 0; i--) {
                if (values[i] !== null && !isNaN(values[i])) {
                    lastValue = values[i];
                    break;
                }
            }
        }

        if (lastValue !== null) {
            summary.totalCurrentEUR = lastValue;
            summary.gainTotal = summary.totalCurrentEUR - summary.totalInvestedEUR;

            summary.gainPct = summary.totalInvestedEUR > 0
                ? (summary.gainTotal / summary.totalInvestedEUR) * 100
                : 0;

            // Utiliser this.lastYesterdayClose pour cohérence avec le graphique
            const referenceClose = this.lastYesterdayClose || graphData.yesterdayClose;
            if (referenceClose && referenceClose > 0) {
                summary.totalDayChangeEUR = summary.totalCurrentEUR - referenceClose;
                summary.dayChangePct = (summary.totalDayChangeEUR / referenceClose) * 100;
            }
        }

        return summary;
    }

    async update(showLoading = true, forceApi = true) {
        if (this.isLoading) return;
        const canvas = document.getElementById('historical-portfolio-chart');
        if (!canvas) return;

        this.isLoading = true;
        const loading = document.getElementById('chart-loading');
        const info = document.getElementById('chart-info');
        const benchmarkWrapper = document.getElementById('benchmark-wrapper');

        if (showLoading) {
            if (loading) loading.style.display = 'flex';
            if (info) info.style.display = 'none';
        }

        try {
            let graphData;
            let targetSummary = {};
            let targetHoldings = [];
            let targetCashReserve = { total: 0 };
            let titleConfig;
            let isSingleAsset = false;
            let isIndexMode = (this.currentMode === 'index');
            let currentTicker = null;


            if (this.currentMode === 'portfolio' && this.selectedAssets.length === 0) {
                this.lastYesterdayClose = null;
            }
            // === CAS 1 : MODE INDICE (MODIFIÉ pour récupérer le prix de clôture) ===
            if (isIndexMode && this.selectedAssets.length === 1) {
                isSingleAsset = true;
                currentTicker = this.selectedAssets[0];

                if (forceApi) {
                    this.lastRefreshTime = Date.now();
                    await this.dataManager.api.fetchBatchPrices([currentTicker]);
                }

                graphData = await this.dataManager.calculateIndexData(currentTicker, this.currentPeriod);

                // Récupération du previousClose pour le graphique principal (pour la ligne de référence)
                const currentPriceData = this.storage.getCurrentPrice(currentTicker);
                let indexPreviousClose = currentPriceData?.previousClose;

                // Si previousClose n'est pas disponible depuis l'API, calculer depuis les données historiques
                if (!indexPreviousClose && graphData && graphData.values.length > 0 && this.currentPeriod === 1) {
                    // Utiliser le premier prix de la journée comme référence de clôture
                    indexPreviousClose = graphData.values[0];
                    console.log(`[Index ${currentTicker}] previousClose from API: undefined, using first price:`, indexPreviousClose);
                }

                // IMPORTANT: Définir lastYesterdayClose AVANT de calculer targetSummary
                this.lastYesterdayClose = indexPreviousClose;
                console.log(`[Index ${currentTicker}] Setting lastYesterdayClose to:`, this.lastYesterdayClose);

                if (graphData && graphData.values.length > 0) {
                    const currentPrice = graphData.values[graphData.values.length - 1];
                    const startPrice = graphData.values[0];
                    const diff = currentPrice - startPrice;

                    targetSummary = {
                        totalCurrentEUR: currentPrice,
                        totalInvestedEUR: 0,
                        gainTotal: diff,
                        gainPct: startPrice > 0 ? (diff / startPrice) * 100 : 0,
                        // Utilise les vraies stats de la carte (basées sur indexPreviousClose)
                        totalDayChangeEUR: indexPreviousClose ? currentPriceData.price - indexPreviousClose : diff,
                        dayChangePct: indexPreviousClose > 0 ? ((currentPriceData.price - indexPreviousClose) / indexPreviousClose) * 100 : 0
                    };
                }

                titleConfig = {
                    mode: 'index',
                    label: this.customTitle ? this.customTitle.label : currentTicker,
                    icon: '🌎'
                };

                // === CAS 2 : MODE ACTIF UNIQUE ===
            } else if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
                isSingleAsset = true;
                currentTicker = this.selectedAssets[0];

                const targetAssetPurchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === currentTicker.toUpperCase());

                if (forceApi) {
                    this.lastRefreshTime = Date.now();
                    await this.dataManager.api.fetchBatchPrices([currentTicker]);
                }

                graphData = await this.dataManager.calculateAssetHistory(currentTicker, this.currentPeriod);

                // Créer yesterdayCloseMap pour cohérence avec le graphique
                const yesterdayCloseMap = new Map();

                // PRIORITÉ: Réutiliser le cache si disponible (pour cohérence avec le tableau)
                if (this.cachedYesterdayCloseMap && this.cachedYesterdayCloseMap.has(currentTicker.toUpperCase())) {
                    yesterdayCloseMap.set(currentTicker.toUpperCase(), this.cachedYesterdayCloseMap.get(currentTicker.toUpperCase()));
                    console.log(`[Reusing cached yesterdayClose for ${currentTicker}]`);
                }
                // Fallback: Utiliser graphData.yesterdayClose
                else if (graphData && graphData.yesterdayClose) {
                    yesterdayCloseMap.set(currentTicker.toUpperCase(), graphData.yesterdayClose);
                    console.log(`[Using graphData yesterdayClose for ${currentTicker}]`);
                }

                targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases, yesterdayCloseMap);
                targetSummary = this.dataManager.calculateSummary(targetHoldings);

                const name = targetAssetPurchases[0]?.name || currentTicker;
                titleConfig = {
                    mode: 'asset',
                    label: `${currentTicker} • ${name}`,
                    icon: this.dataManager.isCryptoTicker(currentTicker) ? '₿' : '📊'
                };

                // === CAS 3 : MODE PORTFOLIO GLOBAL / FILTRÉ ===
            } else {
                titleConfig = this.investmentsPage.getChartTitleConfig();
                const targetAllPurchases = this.getFilteredPurchasesFromPage(false);
                const targetAssetPurchases = targetAllPurchases.filter(p => p.assetType !== 'Cash');
                const targetCashPurchases = targetAllPurchases.filter(p => p.assetType === 'Cash');

                if (titleConfig.mode === 'asset') {
                    isSingleAsset = true;
                    currentTicker = this.filterManager.getSelectedTickers().values().next().value;
                }

                if (forceApi) {
                    const tickers = [...new Set(targetAssetPurchases.map(p => p.ticker.toUpperCase()))];
                    if (tickers.length > 0) await this.dataManager.api.fetchBatchPrices(tickers);
                }

                graphData = await this.dataManager.calculateHistory(targetAssetPurchases, this.currentPeriod);

                // Calculer yesterdayClose pour tous les actifs pour cohérence avec le graphique
                // SOLUTION FINALE: Utiliser les MÊMES données historiques que le graphique
                let yesterdayCloseMap;
                const now = Date.now();
                const cacheIsValid = this.cachedYesterdayCloseMap &&
                    this.cachedYesterdayCloseTimestamp &&
                    (now - this.cachedYesterdayCloseTimestamp) < this.YESTERDAY_CLOSE_CACHE_TTL;

                if (cacheIsValid) {
                    yesterdayCloseMap = this.cachedYesterdayCloseMap;
                } else {

                    // Utiliser les données historiques du graphique pour calculer yesterdayClose
                    yesterdayCloseMap = new Map();
                    const tickers = [...new Set(targetAssetPurchases.map(p => p.ticker.toUpperCase()))];
                    const historicalDataMap = graphData.historicalDataMap || new Map();

                    // Calculer la fin de la journée d'hier (23h59:59)
                    const displayStart = new Date();
                    displayStart.setHours(9, 0, 0, 0);
                    const yesterdayEnd = new Date(displayStart);
                    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
                    yesterdayEnd.setHours(23, 59, 59, 999);
                    const yesterdayEndTs = yesterdayEnd.getTime();

                    for (const ticker of tickers) {
                        // Calculer la quantité détenue hier
                        let qty = 0;
                        for (const purchase of targetAssetPurchases) {
                            if (purchase.ticker.toUpperCase() === ticker) {
                                // Convertir la date string en objet Date pour comparaison correcte
                                const purchaseDate = purchase.date instanceof Date ? purchase.date : new Date(purchase.date);

                                if (purchaseDate < displayStart) {
                                    qty += purchase.quantity;
                                }
                            }
                        }

                        if (qty > 0) {
                            const hist = historicalDataMap.get(ticker);
                            let yesterdayPrice = null;

                            // Extraire le dernier prix historique avant la fin d'hier
                            if (hist && Object.keys(hist).length > 0) {
                                const histArray = Object.keys(hist)
                                    .map(ts => ({
                                        timestamp: parseInt(ts),
                                        price: hist[ts]
                                    }))
                                    .filter(p => p.price !== null && p.timestamp <= yesterdayEndTs)
                                    .sort((a, b) => a.timestamp - b.timestamp);

                                if (histArray.length > 0) {
                                    yesterdayPrice = histArray[histArray.length - 1].price;
                                }
                            }

                            // Fallback: previousClose de l'API
                            if (!yesterdayPrice) {
                                const priceData = this.dataManager.storage.getCurrentPrice(ticker);
                                yesterdayPrice = priceData?.previousClose || priceData?.price;
                            }

                            if (yesterdayPrice && yesterdayPrice > 0) {
                                // Récupérer la devise de l'actif
                                const priceData = this.dataManager.storage.getCurrentPrice(ticker);
                                const currency = priceData?.currency || 'EUR';

                                // NOTE: Les prix sont déjà convertis en EUR dans storage.js et api.js
                                const yesterdayValue = yesterdayPrice * qty;
                                // Stocker la valeur ET la devise pour calcul correct du pourcentage
                                yesterdayCloseMap.set(ticker, { value: yesterdayValue, currency });
                            }
                        }
                    }

                    // Stocker dans le cache avec timestamp
                    this.cachedYesterdayCloseMap = yesterdayCloseMap;
                    this.cachedYesterdayCloseTimestamp = now;
                }

                targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases, yesterdayCloseMap);
                targetSummary = this.dataManager.calculateSummary(targetHoldings);
                targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);
            }

            if (benchmarkWrapper) benchmarkWrapper.style.display = (isSingleAsset || isIndexMode) ? 'none' : 'block';

            // Pour les modes portfolio/asset, utiliser yesterdayCloseMap pour cohérence avec le tableau
            // Pour les indices, on a déjà défini this.lastYesterdayClose plus haut
            if (!isIndexMode) {
                // Pour un actif unique, utiliser yesterdayCloseMap (cohérent avec le tableau)
                if (isSingleAsset && currentTicker && this.cachedYesterdayCloseMap && this.cachedYesterdayCloseMap.has(currentTicker)) {
                    const yesterdayData = this.cachedYesterdayCloseMap.get(currentTicker);
                    this.lastYesterdayClose = yesterdayData.value || yesterdayData;
                    console.log(`[VAR TODAY] Using yesterdayCloseMap for ${currentTicker}: ${this.lastYesterdayClose}`);
                } else {
                    // Pour le portfolio global, utiliser graphData.yesterdayClose
                    this.lastYesterdayClose = graphData.yesterdayClose;
                }
            }

            let benchmarkData = null;
            if (this.currentBenchmark && !isSingleAsset && !isIndexMode) {
                const { startTs, endTs } = this.getStartEndTs(this.currentPeriod);
                const interval = this.dataManager.getIntervalForPeriod(this.currentPeriod);
                benchmarkData = await this.dataManager.api.getHistoricalPricesWithRetry(this.currentBenchmark, startTs, endTs, interval);
            }

            if (!graphData || graphData.labels.length === 0) {
                this.showMessage('Pas de données disponibles pour cette période');
            } else {
                const chartStats = this.renderChart(canvas, graphData, targetSummary, titleConfig, benchmarkData, currentTicker);

                // --- MISE À JOUR DU HOLDING AVEC LES DONNÉES DU GRAPHIQUE ---
                // DÉSACTIVÉ: Ne pas écraser dayChange car il est déjà calculé correctement avec yesterdayCloseMap
                // Pour un actif individuel, mettre à jour dayChange avec les données du graphique
                /*
                if (isSingleAsset && currentTicker && chartStats && chartStats.historicalDayChange !== null) {
                    const holding = targetHoldings.find(h => h.ticker.toUpperCase() === currentTicker.toUpperCase());
                    if (holding) {
                        holding.dayChange = chartStats.historicalDayChange;
                        holding.dayPct = chartStats.historicalDayChangePct;
                    }
                }
                */

                // --- LOGIQUE DE RENDU DES KPI APRÈS LE GRAPHIQUE (MODIFIÉ) ---
                if (!isIndexMode && this.investmentsPage && this.investmentsPage.renderData) {

                    // SYNCHRONISER le summary avec les données du graphique UNIQUEMENT pour la période 1D
                    // Pour les autres périodes, on réutilise le summary 1D mis en cache
                    if (this.currentPeriod === 1) {
                        targetSummary = this.syncSummaryWithChartData(targetSummary, graphData);
                        // Sauvegarder le summary 1D pour réutilisation
                        this.cached1DSummary = { ...targetSummary };
                    } else if (this.cached1DSummary) {
                        // Réutiliser le summary 1D pour les autres périodes
                        targetSummary = { ...this.cached1DSummary };
                    }

                    // On passe chartStats uniquement si on est en 1D (le graphique est la source de vérité pour la variation intra-day)
                    const statsToPass = (this.currentPeriod === 1 && chartStats.historicalDayChange !== null) ? chartStats : null;

                    // Utilisation des données calculées dans le contexte approprié (targetHoldings, targetSummary)
                    this.investmentsPage.renderData(targetHoldings, targetSummary, targetCashReserve.total, statsToPass);
                }
                // --- FIN LOGIQUE DE RENDU DES KPI APRÈS LE GRAPHIQUE ---
            }

        } catch (error) {
            console.error('Erreur graphique (update):', error);
            this.showMessage('Erreur lors du calcul', 'error');
        } finally {
            if (showLoading && loading) loading.style.display = 'none';
            this.isLoading = false;
        }
    }

    getFilteredPurchasesFromPage(ignoreTickerFilter = false) {
        const searchQuery = this.investmentsPage.currentSearchQuery;
        let purchases = this.storage.getPurchases();

        if (searchQuery) {
            const q = searchQuery.toLowerCase();
            purchases = purchases.filter(p => p.ticker.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
        }
        if (!ignoreTickerFilter) {
            const selectedTickers = this.investmentsPage.filterManager.getSelectedTickers();
            if (selectedTickers.size > 0) {
                purchases = purchases.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
            }
        }
        if (this.investmentsPage.currentAssetTypeFilter) {
            purchases = purchases.filter(p => (p.assetType || 'Stock') === this.investmentsPage.currentAssetTypeFilter);
        }
        if (this.investmentsPage.currentBrokerFilter) {
            purchases = purchases.filter(p => (p.broker || 'RV-CT') === this.investmentsPage.currentBrokerFilter);
        }
        return purchases;
    }

    getStartEndTs(days) {
        const today = new Date();
        const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));
        let displayStartUTC;

        if (days === 1) {
            // Vérifier si le marché est fermé (weekend ou en dehors des heures de cotation)
            const dayOfWeek = today.getDay(); // 0 = dimanche, 6 = samedi
            const currentHour = today.getHours();

            // Déterminer l'heure d'ouverture selon le marché
            // Pour les indices US (^GSPC, ^IXIC), le marché ouvre à 15h30 heure française
            // Pour les indices EU (^FCHI, ^STOXX50E), le marché ouvre à 9h
            let marketOpenHour = 9; // Par défaut : marchés européens

            // Si on est en mode index, vérifier quel indice est affiché
            if (this.currentMode === 'index' && this.selectedAssets.length > 0) {
                const ticker = this.selectedAssets[0];
                const usIndices = ['^GSPC', '^IXIC']; // S&P 500, NASDAQ
                if (usIndices.includes(ticker)) {
                    marketOpenHour = 15.5; // 15h30 pour les marchés US
                }
            }

            // Si c'est le weekend OU si c'est avant l'ouverture du marché en semaine
            const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
            const isBeforeMarketOpen = (dayOfWeek >= 1 && dayOfWeek <= 5 && currentHour < marketOpenHour);

            if (isWeekend || isBeforeMarketOpen) {
                // Trouver le dernier jour de trading (vendredi si weekend, hier si avant 9h)
                let lastTradingDay = new Date(today);

                if (dayOfWeek === 0) { // Dimanche -> vendredi
                    lastTradingDay.setDate(lastTradingDay.getDate() - 2);
                } else if (dayOfWeek === 6) { // Samedi -> vendredi
                    lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                } else if (isBeforeMarketOpen) { // Avant 9h -> jour précédent
                    lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                    // Si le jour précédent est un weekend, reculer encore
                    if (lastTradingDay.getDay() === 0) { // Dimanche -> vendredi
                        lastTradingDay.setDate(lastTradingDay.getDate() - 2);
                    } else if (lastTradingDay.getDay() === 6) { // Samedi -> vendredi
                        lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                    }
                }

                displayStartUTC = new Date(Date.UTC(lastTradingDay.getFullYear(), lastTradingDay.getMonth(), lastTradingDay.getDate(), 0, 0, 0));
            } else {
                // Marché ouvert -> afficher aujourd'hui
                displayStartUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0));
            }
        } else if (days === 2) {
            const twoDaysAgo = new Date(today);
            twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
            displayStartUTC = new Date(Date.UTC(twoDaysAgo.getFullYear(), twoDaysAgo.getMonth(), twoDaysAgo.getDate(), 0, 0, 0));
        } else if (days === 'all') {
            const purchases = this.storage.getPurchases();
            let minDate = new Date();
            if (purchases.length > 0) {
                const dates = purchases.map(p => new Date(p.date));
                minDate = new Date(Math.min(...dates));
            } else {
                minDate.setFullYear(minDate.getFullYear() - 1);
            }
            displayStartUTC = new Date(Date.UTC(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()));
        } else {
            const localDisplay = new Date(today);
            localDisplay.setDate(localDisplay.getDate() - days);
            displayStartUTC = new Date(Date.UTC(localDisplay.getFullYear(), localDisplay.getMonth(), localDisplay.getDate()));
        }
        let dataStartUTC = new Date(displayStartUTC);
        dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - 5);
        const startTs = Math.floor(dataStartUTC.getTime() / 1000);
        const endTs = Math.floor(todayUTC.getTime() / 1000);
        return { startTs, endTs };
    }

    // benderrobot/asset_tracker/asset_tracker-48aae7831d42063dd2bce22ff4d9600aa4379c97/historicalChart.js

    renderChart(canvas, graphData, summary, titleConfig, benchmarkData = null, currentTicker = null) {
        if (this.chart) this.chart.destroy();
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const info = document.getElementById('chart-info');
        if (info) info.style.display = 'none';

        let vsYesterdayAbs = null;
        let vsYesterdayPct = null;
        let useTodayVar = false;

        // Titre & Icone
        const titleText = document.getElementById('chart-title-text');
        const titleIcon = document.getElementById('chart-title-icon');
        if (titleText && titleIcon && titleConfig) {
            titleText.textContent = titleConfig.label;
            titleIcon.textContent = titleConfig.icon;
            let color = '#3498db';
            if (titleConfig.icon === '₿') color = '#f1c40f';
            else if (titleConfig.icon === '📊') color = '#2ecc71';
            else if (titleConfig.icon === '🌍') color = '#8e44ad';
            else if (titleConfig.icon === '🏦') color = '#8b5cf6';
            else if (titleConfig.icon === '🌎') color = '#3b82f6';
            titleIcon.style.color = color;
        }

        const viewToggle = document.getElementById('view-toggle');
        const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';

        const isSingleAsset = (titleConfig && titleConfig.mode === 'asset');
        const isIndexMode = (titleConfig && titleConfig.mode === 'index');
        const isUnitView = isSingleAsset && activeView === 'unit';

        const displayValues = (isUnitView) ? graphData.unitPrices : graphData.values;

        const isPerformanceMode = (benchmarkData && !isUnitView && !isIndexMode);

        let avgPrice = 0;
        if (currentTicker && !isIndexMode) {
            const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === currentTicker.toUpperCase());
            let totalInvested = 0;
            let totalQty = 0;
            const dynamicRate = this.storage.getConversionRate('USD_TO_EUR') || 0.925;

            purchases.forEach(p => {
                // Appliquer la conversion de devise pour les achats en USD
                const currency = p.currency || 'EUR';
                const rate = currency === 'USD' ? dynamicRate : 1;
                totalInvested += (p.price * p.quantity * rate);
                totalQty += p.quantity;
            });
            avgPrice = totalQty > 0 ? totalInvested / totalQty : 0;
        }

        // Stats
        const finalYesterdayClose = (isUnitView || isIndexMode) ? this.lastYesterdayClose : this.lastYesterdayClose;
        const firstIndex = displayValues.findIndex(v => v !== null && !isNaN(v));
        let lastIndex = displayValues.length - 1;
        while (lastIndex >= 0 && (displayValues[lastIndex] === null || isNaN(displayValues[lastIndex]))) lastIndex--;

        let perfAbs = 0, perfPct = 0, priceStart = 0, priceEnd = 0, priceHigh = -Infinity, priceLow = Infinity;
        const decimals = (isUnitView || isIndexMode) ? 4 : 2;

        if (firstIndex >= 0 && lastIndex >= 0) {
            priceStart = displayValues[firstIndex];
            priceEnd = displayValues[lastIndex];
            perfAbs = priceEnd - priceStart;

            if (!isIndexMode && !isUnitView && graphData.twr && graphData.twr.length > lastIndex) {
                const twrStart = graphData.twr[firstIndex] || 1.0;
                const twrEnd = graphData.twr[lastIndex];
                perfPct = ((twrEnd - twrStart) / twrStart) * 100;
            } else {
                perfPct = priceStart !== 0 ? (perfAbs / priceStart) * 100 : 0;
            }
            displayValues.forEach(v => { if (v !== null && !isNaN(v)) { priceHigh = Math.max(priceHigh, v); priceLow = Math.min(priceLow, v); } });
        }

        let referenceClose = finalYesterdayClose;
        if ((referenceClose === null || referenceClose === 0) && !isUnitView && !isIndexMode) {
            referenceClose = priceStart;
        }

        // Debug pour les indices
        if (isIndexMode) {
            console.log(`[Index ${currentTicker}] finalYesterdayClose:`, finalYesterdayClose, 'referenceClose:', referenceClose, 'period:', this.currentPeriod);
        }

        if (priceEnd !== null && !isNaN(priceEnd) && !isUnitView && referenceClose) {
            vsYesterdayAbs = priceEnd - referenceClose;
            vsYesterdayPct = referenceClose !== 0 ? (vsYesterdayAbs / referenceClose) * 100 : 0;
        }

        useTodayVar = vsYesterdayAbs !== null;

        // DÉBUT MODIFICATION: La couleur du graphique est alignée sur vsYesterdayAbs (Day P&L)
        let comparisonValue = isPerformanceMode ? perfAbs : (vsYesterdayAbs !== null ? vsYesterdayAbs : perfAbs);

        const isPositive = isPerformanceMode ? (perfPct >= 0) : (comparisonValue >= 0);
        // FIN MODIFICATION

        let mainChartColor = isPositive ? '#2ecc71' : '#e74c3c';

        const perfLabel = document.getElementById('performance-label');
        const perfPercent = document.getElementById('performance-percent');

        // Mettre à jour les stats de performance (PERIOD RETURN)
        // Pour le mode index en 1D, on masque ces stats car elles ne sont pas pertinentes
        if (isIndexMode && this.currentPeriod === 1) {
            // Masquer PERIOD RETURN pour les indices en vue 1D
            if (perfLabel) perfLabel.textContent = '--';
            if (perfPercent) perfPercent.textContent = '--';
        } else {
            // Afficher normalement pour portfolio et autres modes
            if (perfLabel) {
                const currencySymbol = (isIndexMode) ? '' : '€';
                perfLabel.textContent = `${perfAbs > 0 ? '+' : ''}${perfAbs.toFixed(decimals)} ${currencySymbol}`;
                perfLabel.className = 'value ' + (isPositive ? 'positive' : 'negative');
            }
            if (perfPercent) {
                perfPercent.textContent = `(${perfPct > 0 ? '+' : ''}${perfPct.toFixed(2)}%)`;
                perfPercent.className = 'pct ' + (isPositive ? 'positive' : 'negative');
            }
        }

        const datasets = [];

        if (isPerformanceMode) {
            const portfolioData = [];
            const startTWR = graphData.twr[firstIndex] || 1.0;
            for (let i = 0; i < graphData.twr.length; i++) {
                if (i < firstIndex || !graphData.twr[i]) portfolioData.push(null);
                else portfolioData.push(((graphData.twr[i] - startTWR) / startTWR) * 100);
            }
            datasets.push({ label: 'Performance Portfolio (%)', data: portfolioData, borderColor: mainChartColor, backgroundColor: this.hexToRgba(mainChartColor, 0.1), borderWidth: 2, fill: true, pointRadius: 0, tension: 0.3 });

            const benchData = [];
            const benchTs = Object.keys(benchmarkData).map(Number).sort((a, b) => a - b);
            let startBenchPrice = null;

            if (benchTs.length > 0 && graphData.timestamps) {
                const startGraphTs = graphData.timestamps[firstIndex];
                for (let i = benchTs.length - 1; i >= 0; i--) {
                    if (benchTs[i] <= startGraphTs) {
                        startBenchPrice = benchmarkData[benchTs[i]];
                        break;
                    }
                }
                if (!startBenchPrice) startBenchPrice = benchmarkData[benchTs[0]];

                if (startBenchPrice) {
                    let lastKnownBenchPrice = startBenchPrice;
                    for (let i = 0; i < graphData.timestamps.length; i++) {
                        if (i < firstIndex) {
                            benchData.push(null);
                            continue;
                        }
                        const ts = graphData.timestamps[i];
                        let foundPrice = null;
                        for (let j = benchTs.length - 1; j >= 0; j--) {
                            if (benchTs[j] <= ts) {
                                foundPrice = benchmarkData[benchTs[j]];
                                break;
                            }
                        }
                        if (foundPrice !== null) lastKnownBenchPrice = foundPrice;
                        const pct = ((lastKnownBenchPrice - startBenchPrice) / startBenchPrice) * 100;
                        benchData.push(pct);
                    }
                    datasets.push({ label: 'Benchmark (%)', data: benchData, borderColor: '#A855F7', borderWidth: 2, borderDash: [], fill: false, pointRadius: 0 });
                }
            }
            datasets.push({ label: 'Base 0%', data: Array(graphData.labels.length).fill(0), borderColor: 'rgba(255, 255, 255, 0.2)', borderWidth: 1, borderDash: [5, 5], fill: false, pointRadius: 0 });

        } else {
            if (!isIndexMode && !isUnitView) {
                datasets.push({ label: 'Investi (€)', data: graphData.invested, borderColor: '#3b82f6', backgroundColor: 'transparent', borderWidth: 2, fill: false, tension: 0.1, pointRadius: 0, borderDash: [5, 5], hidden: true, spanGaps: true });
            }

            let label = 'Valeur Portfolio (€)';
            if (isUnitView) label = 'Prix unitaire (€)';
            if (isIndexMode) label = 'Cours';

            datasets.push({ label: label, data: displayValues, borderColor: mainChartColor, backgroundColor: this.hexToRgba(mainChartColor, 0.1), borderWidth: 3, fill: true, tension: 0.3, pointRadius: 0, spanGaps: true });

            // Ligne de clôture pour la période 1D (portfolio, asset, et indices)
            if (this.currentPeriod === 1 && !isUnitView && referenceClose && referenceClose > 0) {
                datasets.push({ label: 'Clôture hier', data: Array(graphData.labels.length).fill(referenceClose), borderColor: '#95a5a6', borderWidth: 2, borderDash: [6, 4], fill: false, pointRadius: 0 });
            }

            if (isUnitView && graphData.purchasePoints) {
                datasets.push({ type: 'line', label: 'Points d\'achat', data: graphData.purchasePoints, backgroundColor: '#FFFFFF', borderColor: '#3b82f6', borderWidth: 2, pointRadius: 5, pointHoverRadius: 8, showLine: false, parsing: { yAxisKey: 'y' } });
            }
            if (isUnitView && currentTicker && avgPrice > 0) {
                datasets.push({ label: 'PRU', data: Array(graphData.labels.length).fill(avgPrice), borderColor: '#FF9F43', borderWidth: 2, borderDash: [10, 5], fill: false, pointRadius: 0, pointStyle: 'circle', order: 10 });
            }
        }

        const group2 = document.querySelector('.stat-group-2');
        if (group2) {
            const statDayVar = document.getElementById('stat-day-var');
            const statYesterdayClose = document.getElementById('stat-yesterday-close');
            let statUnitPrice = document.getElementById('stat-unit-price-display');
            let statPru = document.getElementById('stat-pru-display');

            if (!statUnitPrice) { statUnitPrice = document.createElement('div'); statUnitPrice.className = 'stat'; statUnitPrice.id = 'stat-unit-price-display'; statUnitPrice.innerHTML = `<span class="label">PRIX ACTUEL</span><span class="value">0.00</span>`; group2.appendChild(statUnitPrice); }
            if (!statPru) { statPru = document.createElement('div'); statPru.className = 'stat'; statPru.id = 'stat-pru-display'; statPru.innerHTML = `<span class="label">PRU</span><span class="value">0.00</span>`; group2.appendChild(statPru); }

            const priceStartEl = document.getElementById('price-start');
            const priceEndEl = document.getElementById('price-end');
            const priceHighEl = document.getElementById('price-high');
            const priceLowEl = document.getElementById('price-low');

            // --- FIX 2: Sécuriser la mise à jour des éléments de stats FIN/DEBUT/HAUT/BAS ---
            // Cette section a été identifiée comme un point de défaillance possible (TypeError)
            if (priceStartEl) {
                if (priceStartEl.previousElementSibling) priceStartEl.previousElementSibling.textContent = "DÉBUT";
                priceStartEl.textContent = `${priceStart.toFixed(decimals)}`;
                priceStartEl.className = 'value';
            }
            if (priceEndEl) {
                if (priceEndEl.previousElementSibling) priceEndEl.previousElementSibling.textContent = "FIN";
                priceEndEl.textContent = `${priceEnd.toFixed(decimals)}`;
                priceEndEl.className = 'value';
            }
            if (priceHighEl) {
                if (priceHighEl.previousElementSibling) priceHighEl.previousElementSibling.textContent = "HAUT";
                priceHighEl.textContent = `${priceHigh.toFixed(decimals)}`;
                priceHighEl.className = `value positive`;
            }
            if (priceLowEl) {
                if (priceLowEl.previousElementSibling) priceLowEl.previousElementSibling.textContent = "BAS";
                priceLowEl.textContent = `${priceLow.toFixed(decimals)}`;
                priceLowEl.className = `value negative`;
            }
            // --- FIN FIX 2 ---

            if (isIndexMode || isUnitView) {
                group2.style.display = 'flex';
                if (statDayVar) statDayVar.style.display = 'none';
                if (statYesterdayClose) statYesterdayClose.style.display = 'none';

                // FIX 1: Masquer statUnitPrice en mode Index pour éviter la duplication
                if (statUnitPrice) {
                    statUnitPrice.style.display = isIndexMode ? 'none' : 'flex';
                    statUnitPrice.querySelector('.label').textContent = isIndexMode ? 'PRIX ACTUEL' : 'PRIX UNT';
                    statUnitPrice.querySelector('.value').textContent = priceEnd !== null ? `${priceEnd.toFixed(decimals)}` : '-';
                }
                if (statPru) {
                    if (!isIndexMode) {
                        statPru.style.display = 'flex';
                        statPru.querySelector('.value').textContent = `${avgPrice.toFixed(4)} €`;
                        statPru.querySelector('.value').style.color = '#FF9F43';
                    } else {
                        statPru.style.display = 'none';
                    }
                }
                // Logique d'affichage des stats journalières de l'indice
                if (isIndexMode && this.currentPeriod === 1 && referenceClose) {
                    if (statUnitPrice) statUnitPrice.style.display = 'none';
                    if (statPru) statPru.style.display = 'none';

                    let dayClass = 'neutral';
                    if (vsYesterdayAbs > 0.001) dayClass = 'positive';
                    else if (vsYesterdayAbs < -0.001) dayClass = 'negative';

                    // FIX 3: Sécuriser l'accès aux sous-éléments de statDayVar/statYesterdayClose
                    const dayVarLabel = document.getElementById('day-var-label');
                    const dayVarPercent = document.getElementById('day-var-percent');
                    const yesterdayCloseValue = document.getElementById('yesterday-close-value');

                    if (statDayVar && statYesterdayClose && dayVarLabel && dayVarPercent && yesterdayCloseValue) {
                        dayVarLabel.innerHTML = `${vsYesterdayAbs > 0 ? '+' : ''}${vsYesterdayAbs.toFixed(decimals)}`;
                        dayVarPercent.innerHTML = `(${vsYesterdayPct > 0 ? '+' : ''}${vsYesterdayPct.toFixed(2)}%)`;
                        dayVarLabel.className = `value ${dayClass}`;
                        dayVarPercent.className = `pct ${dayClass}`;

                        if (statDayVar.querySelector('.label')) statDayVar.querySelector('.label').textContent = 'VAR. JOUR';
                        statDayVar.style.display = 'flex';

                        yesterdayCloseValue.textContent = `${referenceClose.toFixed(decimals)}`;
                        if (statYesterdayClose.querySelector('.label')) statYesterdayClose.querySelector('.label').textContent = 'CLÔTURE HIER';
                        statYesterdayClose.style.display = 'flex';
                    }
                }


            } else {
                // Mode Portfolio Global

                // Masquer ET vider les stats spécifiques aux indices
                if (statDayVar) {
                    statDayVar.style.display = 'none';
                    const dayVarLabel = document.getElementById('day-var-label');
                    const dayVarPercent = document.getElementById('day-var-percent');
                    if (dayVarLabel) dayVarLabel.innerHTML = '';
                    if (dayVarPercent) dayVarPercent.innerHTML = '';
                }
                if (statYesterdayClose) {
                    statYesterdayClose.style.display = 'none';
                    const yesterdayCloseValue = document.getElementById('yesterday-close-value');
                    if (yesterdayCloseValue) yesterdayCloseValue.textContent = '';
                }
                if (statUnitPrice) {
                    statUnitPrice.style.display = 'none';
                    const unitPriceValue = statUnitPrice.querySelector('.value');
                    if (unitPriceValue) unitPriceValue.textContent = '';
                }
                if (statPru) {
                    statPru.style.display = 'none';
                    const pruValue = statPru.querySelector('.value');
                    if (pruValue) pruValue.textContent = '';
                }

                // === MODIFICATION ICI : On n'affiche les stats journalières que si période = 1 ===
                if (this.currentPeriod !== 1) {
                    group2.style.display = 'none';
                } else {
                    group2.style.display = 'flex';

                    if (statUnitPrice) statUnitPrice.style.display = 'none';
                    if (statPru) statPru.style.display = 'none';

                    if (useTodayVar && statDayVar) {
                        let dayClass = 'neutral';

                        // Utiliser directement les valeurs du graphique (vsYesterdayAbs/Pct) pour cohérence avec la carte VAR TODAY
                        const displayVar = vsYesterdayAbs;
                        const displayPct = vsYesterdayPct;

                        if (displayVar > 0.001) dayClass = 'positive';
                        else if (displayVar < -0.001) dayClass = 'negative';

                        // FIX 3: Utilisation sécurisée des éléments pour Portfolio Global
                        const dayVarLabel = document.getElementById('day-var-label');
                        const dayVarPercent = document.getElementById('day-var-percent');

                        if (dayVarLabel && dayVarPercent) {
                            dayVarLabel.innerHTML = `${displayVar > 0 ? '+' : ''}${displayVar.toFixed(decimals)} €`;
                            dayVarPercent.innerHTML = `(${displayPct > 0 ? '+' : ''}${displayPct.toFixed(2)}%)`;
                            dayVarLabel.className = `value ${dayClass}`;
                            dayVarPercent.className = `pct ${dayClass}`;
                            statDayVar.style.display = 'flex';
                        }
                    }
                    if (referenceClose && statYesterdayClose) {
                        const yesterdayCloseValue = document.getElementById('yesterday-close-value');
                        const labelEl = statYesterdayClose.querySelector('.label');

                        if (yesterdayCloseValue && labelEl) {
                            yesterdayCloseValue.textContent = `${referenceClose.toFixed(decimals)} €`;
                            labelEl.textContent = (finalYesterdayClose) ? 'CLÔTURE HIER' : 'OUVERTURE';
                            statYesterdayClose.style.display = 'flex';
                        }
                    }
                }
            }
        }

        const unitPriceRow = document.getElementById('unit-price-row');
        if (isSingleAsset && !isIndexMode) {
            if (viewToggle) {
                viewToggle.style.display = 'flex';
                viewToggle.querySelectorAll('.toggle-btn').forEach(btn => {
                    btn.onclick = (e) => {
                        if (btn.classList.contains('active')) return;
                        viewToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        this.renderChart(canvas, graphData, summary, titleConfig, benchmarkData, currentTicker);
                    };
                });
            }
        } else {
            if (viewToggle) viewToggle.style.display = 'none';
        }

        const unitPriceEl = document.getElementById('unit-price');
        if (unitPriceEl && (isUnitView || isIndexMode) && priceEnd !== null) unitPriceEl.textContent = `${priceEnd.toFixed(decimals)}`;

        const dateEl = document.getElementById('last-update');
        if (dateEl) dateEl.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        this.chart = new Chart(ctx, {
            type: 'line',
            data: { labels: graphData.labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false, hoverRadius: 12 },
                plugins: {
                    legend: { position: 'top', labels: { usePointStyle: true, padding: 20, color: '#fff' } },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(0,0,0,0.9)',
                        padding: 12,
                        titleFont: { weight: 'bold' },
                        displayColors: false,
                        callbacks: {
                            label: (ctx) => { return null; },
                            afterBody: (tooltipItems) => {
                                const lines = [];
                                const ctx = tooltipItems[0];

                                const referenceClose = finalYesterdayClose; // Récupérer la clôture de la veille

                                if (isPerformanceMode) {
                                    const portfolioPct = ctx.parsed.y;
                                    lines.push(`🔵 Performance : ${portfolioPct > 0 ? '+' : ''}${portfolioPct.toFixed(2)}%`);
                                    const benchItem = tooltipItems.find(i => i.dataset.label === 'Benchmark (%)');
                                    if (benchItem && benchItem.raw !== null) {
                                        const benchPct = benchItem.raw;
                                        const diff = portfolioPct - benchPct;
                                        const sign = diff >= 0 ? '+' : '';
                                        const icon = diff >= 0 ? '🚀' : '🔻';
                                        lines.push(`🟣 Benchmark : ${benchPct > 0 ? '+' : ''}${benchPct.toFixed(2)}%`);
                                        lines.push(`${icon} Alpha : ${sign}${diff.toFixed(2)}%`);
                                    }
                                } else {
                                    if (ctx.parsed.y !== null) {
                                        const val = ctx.parsed.y; // Valeur du point survolé
                                        const label = isIndexMode ? 'Cours' : (isUnitView ? 'Prix' : 'Valeur');
                                        const currencySymbol = isIndexMode ? '' : '€';

                                        // Ligne 1: Cours Actuel (Point survolé)
                                        lines.push(`🟢 ${label} : ${val.toFixed(decimals)} ${currencySymbol}`);

                                        // FIX 2: Ajout des informations Clôture et Variation
                                        if (referenceClose && referenceClose > 0) {
                                            const closeVal = referenceClose;
                                            const changeAbs = val - closeVal;
                                            const changePct = (closeVal !== 0) ? (changeAbs / closeVal) * 100 : 0;

                                            const signAbs = changeAbs >= 0 ? '+' : '';
                                            const changeColorIcon = changeAbs >= 0 ? '🟢' : '🔴';

                                            lines.push(`🟡 Clôture hier : ${closeVal.toFixed(decimals)} ${currencySymbol}`);
                                            lines.push(`${changeColorIcon} Var. Jour : ${signAbs}${changeAbs.toFixed(decimals)} ${currencySymbol} (${signAbs}${changePct.toFixed(2)}%)`);
                                        }
                                    }
                                    if (isUnitView && currentTicker && avgPrice > 0) {
                                        lines.push(`🟠 PRU : ${avgPrice.toFixed(4)} €`);
                                    }
                                    if (isUnitView && graphData.purchasePoints) {
                                        const currentLabel = ctx.label;
                                        const match = graphData.purchasePoints.find(p => p.x === currentLabel);
                                        if (match) lines.push(`🔵 Achat : ${match.quantity} @ ${match.y.toFixed(2)} €`);
                                    }
                                }
                                return lines;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        display: true,
                        ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, color: '#888' },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    },
                    y: {
                        display: true,
                        ticks: {
                            callback: (value) => isPerformanceMode ? `${value}%` : `${value.toLocaleString('fr-FR')}`,
                            color: '#888'
                        },
                        grid: { color: 'rgba(255, 255, 255, 0.05)' }
                    }
                }
            }
        });

        return { historicalDayChange: vsYesterdayAbs, historicalDayChangePct: vsYesterdayPct };
    }

    showMessage(message, type = 'info') {
        const info = document.getElementById('chart-info');
        if (!info) return;
        info.innerHTML = `${type === 'error' ? '⚠️' : 'ℹ️'} ${message}`;
        info.style.display = 'block';
        info.style.color = type === 'error' ? '#dc3545' : '#666';
        const loading = document.getElementById('chart-loading');
        if (loading) loading.style.display = 'none';
    }

    destroy() {
        this.stopAutoRefresh();
        if (this.chart) { this.chart.destroy(); this.chart = null; }
    }
}