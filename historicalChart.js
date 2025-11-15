// ========================================
// historicalChart.js - (v12 - Features 1 & 2)
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
    this.currentMode = 'portfolio';
    this.selectedAssets = [];
    this.autoRefreshInterval = null;
    this.lastRefreshTime = null;
    this.lastYesterdayClose = null; 
    
    this.filterManager = investmentsPage.filterManager;
    
    // NOUVEAU (Feature 1)
    this.currentBenchmark = null; // Ticker de l'indice (ex: '^GSPC')
    
    // Écouteurs d'événements
    eventBus.addEventListener('showAssetChart', (e) => {
        this.showAssetChart(e.detail.ticker, e.detail.summary);
    });

    eventBus.addEventListener('clearAssetChart', () => {
        this.currentMode = 'portfolio';
        this.selectedAssets = [];
        this.currentBenchmark = null; // Réinitialiser aussi le benchmark
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = '';
    });
  }

  // Convertit Hex en RGBA
  hexToRgba(hex, alpha) {
    // ... (inchangé) ...
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
    // ... (inchangé) ...
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (this.isLoading) return;
        const period = btn.dataset.period;
        
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        this.currentPeriod = (period === 'all' ? 'all' : parseInt(period));
        this.changePeriod(this.currentPeriod);
      });
    });
    
    // NOUVEAU (Feature 1) : Attacher l'écouteur du benchmark
    this.setupBenchmarkSelector();
  }
  
  // NOUVEAU (Feature 1) : Logique du sélecteur de benchmark
  setupBenchmarkSelector() {
    const benchmarkSelect = document.getElementById('benchmark-select');
    if (benchmarkSelect) {
        benchmarkSelect.addEventListener('change', (e) => {
            this.currentBenchmark = e.target.value || null;
            // Rafraîchir le graphique avec le benchmark
            this.update(true, false); 
        });
    }
  }

  startAutoRefresh() {
    // ... (inchangé) ...
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
    // ... (inchangé) ...
    if (this.autoRefreshInterval) {
      clearInterval(this.autoRefreshInterval);
      this.autoRefreshInterval = null;
    }
  }

  async silentUpdate() {
    // ... (inchangé) ...
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

  // ==========================================================
  // Méthodes "show" (Contrôleur)
  // ==========================================================

  async showAssetChart(ticker, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'asset'; 
    this.selectedAssets = [ticker];
    this.isCryptoOrGlobal = this.dataManager.isCryptoTicker(ticker); 
    
    // On cache le sélecteur de benchmark en vue unitaire
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

  // ==========================================================
  // === Logique de chargement de page (MODIFIÉE)
  // ==========================================================
  async loadPageWithCacheFirst() {
    if (this.isLoading) return;
    this.isLoading = true;
    
    this.currentMode = 'portfolio';
    this.selectedAssets = [];

    const graphLoader = document.getElementById('chart-loading');
    const canvas = document.getElementById('historical-portfolio-chart');
    if (graphLoader) graphLoader.style.display = 'flex';

    try {
      // 1. Récupérer les achats filtrés
      const contextPurchases = this.getFilteredPurchasesFromPage();
      const assetPurchases = contextPurchases.filter(p => p.assetType !== 'Cash');
      const cashPurchases = contextPurchases.filter(p => p.assetType === 'Cash');

      if (assetPurchases.length === 0 && cashPurchases.length === 0) {
          this.showMessage('Aucun achat correspondant aux filtres');
          this.investmentsPage.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 }, 0);
          this.isLoading = false;
          if (graphLoader) graphLoader.style.display = 'none';
          return;
      }
      
      const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];
      
      // Force le rafraîchissement des prix au premier chargement
      if (tickers.length > 0) {
          await this.dataManager.api.fetchBatchPrices(tickers);
      }
      
      // 2. Déterminer la CIBLE du graphique et des cartes
      const titleConfig = this.investmentsPage.getChartTitleConfig();
      let targetAssetPurchases = assetPurchases;
      let targetCashPurchases = cashPurchases;

      if (titleConfig.mode === 'asset') {
         const ticker = this.filterManager.getSelectedTickers().values().next().value;
         targetAssetPurchases = assetPurchases.filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
         targetCashPurchases = []; 
      }
      
      // 3. Calculs & Rendu SYNC (MAINTENANT AVEC PRIX FRAIS)
      const contextHoldings = this.dataManager.calculateHoldings(assetPurchases);
      const targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases);
      let targetSummary = this.dataManager.calculateSummary(targetHoldings); 
      const targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);
      
      // 4. Rendu Graphique
      let historicalChanges = { historicalDayChange: null, historicalDayChangePct: null };
      try {
        let graphData;
        if (titleConfig.mode === 'asset') {
            const ticker = this.filterManager.getSelectedTickers().values().next().value;
            graphData = await this.dataManager.calculateAssetHistory(ticker, this.currentPeriod);
        } else {
            graphData = await this.dataManager.calculateHistory(targetAssetPurchases, this.currentPeriod);
        }
        
        this.lastYesterdayClose = graphData.yesterdayClose;
        
        if (!graphData || graphData.labels.length === 0) {
             this.showMessage('Pas de données graphiques disponibles.');
        } else {
             // MODIFICATION : Passe les graphData complètes
             historicalChanges = this.renderChart(canvas, graphData, targetSummary, titleConfig);
        }
      } catch (e) {
        console.error('Erreur Graph Cache', e);
      } finally {
        if (graphLoader) graphLoader.style.display = 'none';
      }

      // 5. ÉCRASER la Var. Jour "live" par la Var. Jour "historique"
      if (this.currentPeriod === 1 && historicalChanges.historicalDayChange !== null) {
          targetSummary.totalDayChangeEUR = historicalChanges.historicalDayChange;
          targetSummary.dayChangePct = historicalChanges.historicalDayChangePct;
      }

      // 6. Rendre le tableau (Contexte) et les cartes (Cible)
      this.investmentsPage.renderData(contextHoldings, targetSummary, targetCashReserve.total);

    } catch (e) {
      console.error('Erreur chargement', e);
      this.showMessage('Erreur de chargement', 'error');
      if (graphLoader) graphLoader.style.display = 'none';
    } finally {
      this.isLoading = false;
    }
  }

  // ==========================================================
  // === Logique de MISE À JOUR (MODIFIÉE)
  // ==========================================================
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
      // 1. CONTEXTE GLOBAL (Ce qu'on affiche dans le TABLEAU)
      const contextPurchasesNoTickerFilter = this.getFilteredPurchasesFromPage(true);
      const contextAssetPurchases = contextPurchasesNoTickerFilter.filter(p => p.assetType !== 'Cash');

      
      // 2. CIBLE DU GRAPHIQUE ET TITRE
      let targetAssetPurchases;
      let targetCashPurchases;
      let titleConfig;
      let isSingleAsset = false; // <-- NOUVEAU

      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
         // CAS 1: On a cliqué sur une ligne
         isSingleAsset = true;
         if (benchmarkWrapper) benchmarkWrapper.style.display = 'none'; // Cache benchmark
         const ticker = this.selectedAssets[0];
         const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
         titleConfig = {
           mode: 'asset',
           label: `${ticker} • ${name}`,
           icon: this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊'
         };
         targetAssetPurchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
         targetCashPurchases = [];
      
      } else {
         // CAS 2: On est en vue "filtrée" ou "globale"
         isSingleAsset = false;
         if (benchmarkWrapper) benchmarkWrapper.style.display = 'block'; // Montre benchmark
         
         titleConfig = this.investmentsPage.getChartTitleConfig();
         const targetAllPurchases = this.getFilteredPurchasesFromPage(false);
         targetAssetPurchases = targetAllPurchases.filter(p => p.assetType !== 'Cash');
         targetCashPurchases = targetAllPurchases.filter(p => p.assetType === 'Cash');
         
         // Cas spécial: 1 seul actif filtré
         if (titleConfig.mode === 'asset') isSingleAsset = true;
      }
      
      // 3. FETCH API
      const contextTickers = new Set(contextAssetPurchases.map(p => p.ticker.toUpperCase()));
      const targetTickers = new Set(targetAssetPurchases.map(p => p.ticker.toUpperCase()));
      let allTickers = [...new Set([...contextTickers, ...targetTickers])];
      
      // AJOUT (Feature 1) : Ajouter le benchmark aux tickers à fetch
      if (this.currentBenchmark && !isSingleAsset) {
          allTickers.push(this.currentBenchmark);
      }
      allTickers = [...new Set(allTickers)]; // Dédoublonne
      
      if (forceApi) {
          this.lastRefreshTime = Date.now();
          await this.dataManager.api.fetchBatchPrices(allTickers);
      }
      
      // 4. CALCULS
      
      // A. Données Graphique (sur la CIBLE)
      let graphData;
      if (isSingleAsset) {
         const ticker = (this.currentMode === 'asset') 
            ? this.selectedAssets[0] 
            : this.filterManager.getSelectedTickers().values().next().value;
         
         graphData = await this.dataManager.calculateAssetHistory(ticker, this.currentPeriod);
      } else {
         graphData = await this.dataManager.calculateHistory(targetAssetPurchases, this.currentPeriod);
      }

      // B. Données Cartes "Summary" (sur la CIBLE)
      const targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases);
      let targetSummary = this.dataManager.calculateSummary(targetHoldings);
      const targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);

      // C. Données Tableau (sur le CONTEXTE)
      const contextHoldings = this.dataManager.calculateHoldings(contextAssetPurchases);
      
      this.lastYesterdayClose = graphData.yesterdayClose;

      // D. AJOUT (Feature 1) : Données Benchmark
      let benchmarkData = null;
      if (this.currentBenchmark && !isSingleAsset) {
          const { startTs, endTs } = this.getStartEndTs(this.currentPeriod);
          const interval = this.dataManager.getIntervalForPeriod(this.currentPeriod);
          benchmarkData = await this.dataManager.api.getHistoricalPricesWithRetry(this.currentBenchmark, startTs, endTs, interval);
      }
      
      // E. Rendu
      let historicalChanges = { historicalDayChange: null, historicalDayChangePct: null };
      if (!graphData || graphData.labels.length === 0) {
        this.showMessage('Pas de données disponibles pour cette période');
      } else {
        // MODIFICATION : Passe les graphData complètes ET le benchmark
        historicalChanges = this.renderChart(canvas, graphData, targetSummary, titleConfig, benchmarkData);
      }
      
      // F. ÉCRASER la Var. Jour (UNIQUEMENT en vue 1J)
      if (this.currentPeriod === 1 && historicalChanges.historicalDayChange !== null) {
          targetSummary.totalDayChangeEUR = historicalChanges.historicalDayChange;
          targetSummary.dayChangePct = historicalChanges.historicalDayChangePct;
      }

      // G. Rendre le tableau (Contexte) et les cartes (Cible)
      this.investmentsPage.renderData(contextHoldings, targetSummary, targetCashReserve.total);

    } catch (error) {
      console.error('Erreur graphique (update):', error);
      this.showMessage('Erreur lors du calcul', 'error');
    } finally {
      if (showLoading && loading) loading.style.display = 'none';
      this.isLoading = false;
    }
  }

  // ... (getFilteredPurchasesFromPage inchangé) ...
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
  
  // NOUVEAU (Helper pour Feature 1)
  getStartEndTs(days) {
      const today = new Date();
      const todayUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999));
      let displayStartUTC;
        
      if (days === 1) {
          displayStartUTC = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0));
      } else if (days === 2) {
          const twoDaysAgo = new Date(today);
          twoDaysAgo.setDate(twoDaysAgo.getDate() - 1);
          displayStartUTC = new Date(Date.UTC(twoDaysAgo.getFullYear(), twoDaysAgo.getMonth(), twoDaysAgo.getDate(), 0, 0, 0));
      } else if (days !== 'all') {
          const localDisplay = new Date(today);
          localDisplay.setDate(localDisplay.getDate() - (days - 1));
          displayStartUTC = new Date(Date.UTC(localDisplay.getFullYear(), localDisplay.getMonth(), localDisplay.getDate()));
      } else {
          // 'all' est géré par dataManager, ici on prend 1 an par défaut pour le benchmark
          const localDisplay = new Date(today);
          localDisplay.setDate(localDisplay.getDate() - 365);
          displayStartUTC = new Date(Date.UTC(localDisplay.getFullYear(), localDisplay.getMonth(), localDisplay.getDate()));
      }
      
      let dataStartUTC = new Date(displayStartUTC);
      dataStartUTC.setUTCDate(dataStartUTC.getUTCDate() - 5); 
        
      const startTs = Math.floor(dataStartUTC.getTime() / 1000);
      const endTs = Math.floor(todayUTC.getTime() / 1000);
      return { startTs, endTs };
  }
  
  // NOUVEAU (Helper pour Feature 1)
  normalizeDatasets(portfolioGraphData, benchmarkApiData) {
    if (!benchmarkApiData || Object.keys(benchmarkApiData).length === 0) {
        return { normalizedPortfolio: portfolioGraphData.values, normalizedBenchmark: null };
    }

    const portfolioValues = portfolioGraphData.values;
    const portfolioLabels = portfolioGraphData.labels; // Ceux-ci sont des strings formatés
    const portfolioTimestamps = portfolioGraphData.labels.map(l => new Date(l).getTime()); // Pas fiable, les labels sont formatés
    
    // Il faut que dataManager retourne les timestamps bruts
    // EN ATTENDANT : On suppose que les 'labels' et 'values' de portfolioGraphData
    // et les clés/valeurs de benchmarkApiData sont alignés, ce qui est faux.
    
    // VRAIE LOGIQUE DE NORMALISATION (simplifiée)
    // 1. Trouver le premier point de données commun
    const benchTimestamps = Object.keys(benchmarkApiData).map(Number).sort((a,b)=>a-b);
    
    // On utilise les labels/values du portfolio comme référence
    let firstPortfolioValue = null;
    let firstBenchmarkValue = null;

    // Trouver la première valeur du portfolio
    for (let i = 0; i < portfolioValues.length; i++) {
        if (portfolioValues[i] !== null) {
            firstPortfolioValue = portfolioValues[i];
            
            // Essayer de trouver un prix de benchmark proche de ce point de départ
            // Ceci est complexe. Pour l'instant, on prend la première valeur du benchmark.
            firstBenchmarkValue = benchmarkApiData[benchTimestamps[0]];
            break;
        }
    }

    if (firstPortfolioValue === null || firstBenchmarkValue === null || firstPortfolioValue === 0 || firstBenchmarkValue === 0) {
        return { normalizedPortfolio: portfolioValues, normalizedBenchmark: null };
    }

    // 2. Normaliser tout à 100
    const normalizedPortfolio = portfolioValues.map(v => v === null ? null : (v / firstPortfolioValue) * 100);
    
    // 3. Aligner et normaliser le benchmark (très simplifié)
    // Idéalement, on devrait matcher chaque timestamp du portfolio au timestamp le plus proche du benchmark
    const normalizedBenchmark = benchTimestamps.map(ts => {
        const val = benchmarkApiData[ts];
        return val === null ? null : (val / firstBenchmarkValue) * 100;
    });

    // Problème : Les 'labels' du portfolio ne correspondent pas aux timestamps du benchmark.
    // Cette normalisation est trop complexe à faire sans modifier dataManager pour qu'il retourne les timestamps bruts.
    
    // SOLUTION TEMPORAIRE : On renvoie juste le portfolio.
    console.warn("Normalisation du benchmark non implémentée (nécessite timestamps bruts de dataManager)");
    return { normalizedPortfolio: portfolioValues, normalizedBenchmark: null };
    
    // TODO: Implémenter la vraie normalisation quand dataManager retournera les timestamps.
  }


  // ==========================================================
  // Rendu (MODIFIÉ)
  // ==========================================================

  renderChart(canvas, graphData, summary, titleConfig, benchmarkData = null) {
    if (this.chart) this.chart.destroy();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const info = document.getElementById('chart-info');
    if (info) info.style.display = 'none';

    // ... (Logique du TITRE inchangée) ...
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
        titleIcon.style.color = color;
    }
    
    // === VUE UNITAIRE (Feature 2) ===
    const viewToggle = document.getElementById('view-toggle');
    const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';
    const isSingleAsset = (titleConfig && titleConfig.mode === 'asset');
    
    // MODIFICATION : 'isUnitView' utilise les nouvelles données de dataManager
    const isUnitView = isSingleAsset && activeView === 'unit';
    // 'displayValues' sera soit la valeur du portefeuille, soit le prix unitaire brut
    const displayValues = isUnitView ? graphData.unitPrices : graphData.values;

    // ... (Logique Clôture Hier & Stats... inchangée, mais utilise displayValues) ...
    const yesterdayCloseDisplay = isUnitView && this.lastYesterdayClose !== null 
      ? this.lastYesterdayClose / (summary.movementsCount) // Approximation
      : this.lastYesterdayClose;
      
    // (Cette logique est complexe car lastYesterdayClose est pour le *portefeuille*)
    // Pour la vue unitaire, on devrait utiliser la clôture unitaire.
    // Pour l'instant, on ignore 'yesterdayClose' en vue unitaire.
    const finalYesterdayClose = isUnitView ? null : this.lastYesterdayClose;

    // === Stats ===
    const firstIndex = displayValues.findIndex(v => v !== null && !isNaN(v));
    let lastIndex = displayValues.length - 1;
    while (lastIndex >= 0 && (displayValues[lastIndex] === null || isNaN(displayValues[lastIndex]))) lastIndex--;

    let perfAbs = 0, perfPct = 0, priceStart = 0, priceEnd = 0, priceHigh = -Infinity, priceLow = Infinity;
    const decimals = isUnitView ? 4 : 2;

    if (firstIndex >= 0 && lastIndex >= 0) {
      priceStart = displayValues[firstIndex];
      priceEnd = displayValues[lastIndex]; 
      perfAbs = priceEnd - priceStart;
      perfPct = priceStart !== 0 ? (perfAbs / priceStart) * 100 : 0;
      displayValues.forEach(v => { if (v !== null && !isNaN(v)) { priceHigh = Math.max(priceHigh, v); priceLow = Math.min(priceLow, v); } });
    }

    let vsYesterdayAbs = null, vsYesterdayPct = null;
    // MODIFICATION : Ne pas calculer la Var. Jour en vue unitaire pour l'instant
    if (finalYesterdayClose !== null && priceEnd !== null && !isNaN(priceEnd) && !isUnitView) {
      vsYesterdayAbs = priceEnd - finalYesterdayClose;
      vsYesterdayPct = finalYesterdayClose !== 0 ? (vsYesterdayAbs / finalYesterdayClose) * 100 : 0;
    }

    // ... (Logique Couleur Chart & MàJ DOM inchangée) ...
    const useTodayVar = vsYesterdayAbs !== null;
    const comparisonValue = useTodayVar ? vsYesterdayAbs : perfAbs;
    let mainChartColor = '#3498db'; 
    let perfClass = 'neutral';
    if (comparisonValue > 0.001) { mainChartColor = '#2ecc71'; perfClass = 'positive'; } 
    else if (comparisonValue < -0.001) { mainChartColor = '#e74c3c'; perfClass = 'negative'; }
    const perfLabel = document.getElementById('performance-label');
    const perfPercent = document.getElementById('performance-percent');
    if(perfLabel) {
      perfLabel.textContent = `${perfAbs > 0 ? '+' : ''}${perfAbs.toFixed(decimals)} €`;
      perfLabel.className = 'value ' + (perfAbs > 0 ? 'positive' : (perfAbs < 0 ? 'negative' : 'neutral'));
    }
    if (perfPercent) {
      perfPercent.textContent = `(${perfPct > 0 ? '+' : ''}${perfPct.toFixed(2)}%)`;
      perfPercent.className = 'pct ' + (perfPct > 0 ? 'positive' : (perfPct < 0 ? 'negative' : 'neutral'));
    }
    const statDayVar = document.getElementById('stat-day-var');
    const statYesterdayClose = document.getElementById('stat-yesterday-close');
    const group2 = document.querySelector('.stat-group-2');
    const is1DView = (this.currentPeriod === 1);
    if (group2) {
        // MODIFICATION : Cacher Var. Jour en vue unitaire
        group2.style.display = (is1DView && !isUnitView) ? 'flex' : 'none'; 
    }
    if (useTodayVar && statDayVar) { 
        document.getElementById('day-var-label').innerHTML = `${vsYesterdayAbs > 0 ? '+' : ''}${vsYesterdayAbs.toFixed(decimals)} €`;
        document.getElementById('day-var-percent').innerHTML = `(${vsYesterdayPct > 0 ? '+' : ''}${vsYesterdayPct.toFixed(2)}%)`;
        document.getElementById('day-var-label').className = `value ${perfClass}`;
        document.getElementById('day-var-percent').className = `pct ${perfClass}`;
        statDayVar.style.display = 'flex';
    } else if (statDayVar) { 
        statDayVar.style.display = 'none'; 
    }
    if (finalYesterdayClose !== null && statYesterdayClose) {
        document.getElementById('yesterday-close-value').textContent = `${finalYesterdayClose.toFixed(decimals)} €`;
        statYesterdayClose.style.display = 'flex';
    } else if (statYesterdayClose) { 
        statYesterdayClose.style.display = 'none'; 
    }
    ['price-start', 'price-end', 'price-high', 'price-low'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const val = id === 'price-start' ? priceStart : id === 'price-end' ? priceEnd : id === 'price-high' ? priceHigh : priceLow;
        el.textContent = val !== -Infinity && val !== Infinity && val !== null ? `${val.toFixed(decimals)} €` : 'N/A';
      }
    });
    const unitPriceEl = document.getElementById('unit-price');
    if (unitPriceEl && isUnitView && priceEnd !== null) unitPriceEl.textContent = `${priceEnd.toFixed(4)} €`;
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    // === DATASETS (MODIFIÉ) ===
    const datasets = [
      { 
        label: 'Investi (€)', 
        data: graphData.invested, 
        borderColor: '#3b82f6',
        backgroundColor: 'transparent',
        borderWidth: 2, 
        fill: false, 
        tension: 0.1, 
        pointRadius: 0, 
        borderDash: [5, 5], 
        hidden: isUnitView // Cacher "Investi" en vue unitaire
      },
      {
        label: isUnitView ? 'Prix unitaire (€)' : 'Valeur Portfolio (€)',
        data: displayValues,
        borderColor: mainChartColor,
        backgroundColor: this.hexToRgba(mainChartColor, 0.1),
        borderWidth: 3,
        fill: true,
        tension: 0.3,
        pointRadius: 0 // On enlève les points de la ligne principale
      }
    ];

    // MODIFICATION : Clôture hier (Seulement en vue globale)
    if (finalYesterdayClose !== null && this.currentPeriod === 1 && !isUnitView) {
      datasets.push({
        label: 'Clôture hier',
        data: Array(graphData.labels.length).fill(finalYesterdayClose),
        borderColor: '#95a5a6',
        borderWidth: 2,
        borderDash: [6, 4],
        fill: false,
        pointRadius: 0
      });
    }
    
    // AJOUT (Feature 2) : Points d'achat
    if (isUnitView && graphData.purchasePoints && graphData.purchasePoints.length > 0) {
        datasets.push({
            type: 'scatter', // Type de graphique différent
            label: 'Points d\'achat',
            data: graphData.purchasePoints,
            backgroundColor: '#FFFFFF',
            borderColor: '#3b82f6',
            borderWidth: 2,
            radius: 5,
            hoverRadius: 8,
            showLine: false
        });
    }
    
    // AJOUT (Feature 1) : Ligne Benchmark
    // (Cette logique est désactivée car normalizeDatasets est un TODO)
    /*
    if (benchmarkData && benchmarkData.normalizedBenchmark) {
        datasets.push({
            label: 'Benchmark',
            data: benchmarkData.normalizedBenchmark,
            borderColor: '#f1c40f',
            borderWidth: 2,
            borderDash: [3, 3],
            fill: false,
            pointRadius: 0,
            yAxisID: 'yPercent' // Nécessite un 2e axe Y
        });
    }
    */

    // ... (Logique Toggles inchangée) ...
    const unitPriceRow = document.getElementById('unit-price-row');
    if (isSingleAsset) {
      if(viewToggle) viewToggle.style.display = 'flex';
      if(unitPriceRow) unitPriceRow.style.display = isUnitView ? 'flex' : 'none'; 
    } else {
      if(viewToggle) viewToggle.style.display = 'none';
      if(unitPriceRow) unitPriceRow.style.display = 'none';
    }
    viewToggle?.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.onclick = () => {
        if (btn.classList.contains('active')) return;
        viewToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderChart(canvas, graphData, summary, titleConfig, benchmarkData); // Re-render
      };
    });

    this.chart = new Chart(ctx, {
      type: 'line', // Le type par défaut
      data: { labels: graphData.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, hoverRadius: 12 },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20 } },
          tooltip: {
            mode: 'index', intersect: false, backgroundColor: 'rgba(0,0,0,0.85)', padding: 12,
            titleFont: { weight: 'bold' },
            callbacks: { 
                label: (ctx) => {
                    if (ctx.dataset.type === 'scatter') {
                        const dataPoint = ctx.raw;
                        return ` Achat: ${dataPoint.quantity} @ ${dataPoint.y.toFixed(2)} €`;
                    }
                    return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(isUnitView ? 4 : 2)} €`;
                }
            }
          }
        },
        scales: {
          x: { 
            display: true,
            title: { display: false },
            ticks: { 
              maxRotation: 0, 
              autoSkip: true, 
              maxTicksLimit: (this.currentPeriod === 1 || this.currentPeriod === 2) ? 8 : 10,
              color: '#888'
            },
            grid: { color: 'rgba(200, 200, 200, 0.1)' }
          },
          y: { 
            display: true,
            ticks: { 
              callback: (value) => `${value.toLocaleString('fr-FR')} €`,
              color: '#888'
            },
            grid: { color: 'rgba(200, 200, 200, 0.1)' }
          }
          // (Axe Y 'yPercent' à ajouter pour le benchmark)
        }
      }
    });
    
    // RENVOYER LA VARIATION HISTORIQUE
    return { historicalDayChange: vsYesterdayAbs, historicalDayChangePct: vsYesterdayPct };
  
  } // Fin de renderChart

  showMessage(message, type = 'info') {
    // ... (inchangé) ...
    const info = document.getElementById('chart-info');
    if (!info) return;
    info.innerHTML = `${type === 'error' ? '⚠️' : 'ℹ️'} ${message}`;
    info.style.display = 'block';
    info.style.color = type === 'error' ? '#dc3545' : '#666';
    const loading = document.getElementById('chart-loading');
    if (loading) loading.style.display = 'none';
  }

  destroy() {
    // ... (inchangé) ...
    this.stopAutoRefresh();
    if (this.chart) { this.chart.destroy(); this.chart = null; }
  }
}