// ========================================
// historicalChart.js - (v18 - Synchro Totale "Vérité 1D")
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
    this.currentBenchmark = null;
    
    // Écouteurs d'événements
    eventBus.addEventListener('showAssetChart', (e) => {
        this.showAssetChart(e.detail.ticker, e.detail.summary);
    });

    eventBus.addEventListener('clearAssetChart', () => {
        this.currentMode = 'portfolio';
        this.selectedAssets = [];
        this.currentBenchmark = null; 
        const benchmarkSelect = document.getElementById('benchmark-select');
        if (benchmarkSelect) benchmarkSelect.value = '';
    });
  }

  // Convertit Hex en RGBA
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
      btn.addEventListener('click', (e) => {
        if (this.isLoading) return;
        const period = btn.dataset.period;
        
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        
        this.currentPeriod = (period === 'all' ? 'all' : parseInt(period));
        this.changePeriod(this.currentPeriod);
      });
    });
    
    this.setupBenchmarkSelector();
  }
  
  setupBenchmarkSelector() {
    const benchmarkSelect = document.getElementById('benchmark-select');
    if (benchmarkSelect) {
        benchmarkSelect.addEventListener('change', (e) => {
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

  // ==========================================================
  // Méthodes "show" (Contrôleur)
  // ==========================================================

  async showAssetChart(ticker, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'asset'; 
    this.selectedAssets = [ticker];
    this.isCryptoOrGlobal = this.dataManager.isCryptoTicker(ticker); 
    
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
  // === Synchronisation Summary <-> Graph Data (LA VÉRITÉ 1D) ===
  // ==========================================================
  syncSummaryWithChartData(summary, graphData) {
      // On cherche la dernière valeur valide du graphique 1D fourni
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

      // Si on a trouvé une valeur de fin de graph, on met à jour le résumé
      if (lastValue !== null) {
          // 1. Mettre à jour la Valeur Actuelle (Total Value)
          summary.totalCurrentEUR = lastValue;

          // 2. Recalculer le Gain Total (P&L)
          summary.gainTotal = summary.totalCurrentEUR - summary.totalInvestedEUR;

          // 3. Recalculer le % Total
          summary.gainPct = summary.totalInvestedEUR > 0 
              ? (summary.gainTotal / summary.totalInvestedEUR) * 100 
              : 0;
              
          // 4. Optionnel : Recalculer Var Day si available
          if (graphData.yesterdayClose && graphData.yesterdayClose > 0) {
              summary.totalDayChangeEUR = summary.totalCurrentEUR - graphData.yesterdayClose;
              summary.dayChangePct = (summary.totalDayChangeEUR / graphData.yesterdayClose) * 100;
          }
      }

      return summary;
  }

  // ==========================================================
  // === Logique de chargement de page (Cache-First)
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
      
      if (tickers.length > 0) {
          await this.dataManager.api.fetchBatchPrices(tickers);
      }
      
      const titleConfig = this.investmentsPage.getChartTitleConfig();
      let targetAssetPurchases = assetPurchases;
      let targetCashPurchases = cashPurchases;

      if (titleConfig.mode === 'asset') {
         const ticker = this.filterManager.getSelectedTickers().values().next().value;
         targetAssetPurchases = assetPurchases.filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
         targetCashPurchases = []; 
      }
      
      const contextHoldings = this.dataManager.calculateHoldings(assetPurchases);
      const targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases);
      let targetSummary = this.dataManager.calculateSummary(targetHoldings); 
      const targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);
      
      try {
        let graphData;
        const isSingleAsset = (titleConfig.mode === 'asset');
        
        // Récupération des données graphiques principales
        if (isSingleAsset) {
            const ticker = this.filterManager.getSelectedTickers().values().next().value;
            graphData = await this.dataManager.calculateAssetHistory(ticker, this.currentPeriod);
        } else {
            graphData = await this.dataManager.calculateHistory(targetAssetPurchases, this.currentPeriod);
        }
        
        this.lastYesterdayClose = graphData.yesterdayClose;
        
        if (!graphData || graphData.labels.length === 0) {
             this.showMessage('Pas de données graphiques disponibles.');
        } else {
             this.renderChart(canvas, graphData, targetSummary, titleConfig);
             
             // === LOGIQUE DE VÉRITÉ 1D ===
             // Si on est déjà en 1D, on utilise graphData.
             // Si on est en > 1D, on doit quand même récupérer la valeur 1D pour la carte.
             let referenceData = graphData;
             
             if (this.currentPeriod !== 1) {
                 // On est en vue 1M, 1Y, etc. -> On fetch la 1D en arrière-plan
                 if (isSingleAsset) {
                     const ticker = this.filterManager.getSelectedTickers().values().next().value;
                     referenceData = await this.dataManager.calculateAssetHistory(ticker, 1);
                 } else {
                     referenceData = await this.dataManager.calculateHistory(targetAssetPurchases, 1);
                 }
             }
             
             // On écrase le résumé avec la donnée 1D précise
             targetSummary = this.syncSummaryWithChartData(targetSummary, referenceData);
        }
      } catch (e) {
        console.error('Erreur Graph Cache', e);
      } finally {
        if (graphLoader) graphLoader.style.display = 'none';
      }

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
  // === Logique de MISE À JOUR ===
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
      const contextPurchasesNoTickerFilter = this.getFilteredPurchasesFromPage(true);
      const contextAssetPurchases = contextPurchasesNoTickerFilter.filter(p => p.assetType !== 'Cash');

      let targetAssetPurchases;
      let targetCashPurchases;
      let titleConfig;
      let isSingleAsset = false; 

      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
         isSingleAsset = true;
         if (benchmarkWrapper) benchmarkWrapper.style.display = 'none'; 
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
         isSingleAsset = false;
         if (benchmarkWrapper) benchmarkWrapper.style.display = 'block'; 
         
         titleConfig = this.investmentsPage.getChartTitleConfig();
         const targetAllPurchases = this.getFilteredPurchasesFromPage(false);
         targetAssetPurchases = targetAllPurchases.filter(p => p.assetType !== 'Cash');
         targetCashPurchases = targetAllPurchases.filter(p => p.assetType === 'Cash');
         
         if (titleConfig.mode === 'asset') isSingleAsset = true;
      }
      
      const contextTickers = new Set(contextAssetPurchases.map(p => p.ticker.toUpperCase()));
      const targetTickers = new Set(targetAssetPurchases.map(p => p.ticker.toUpperCase()));
      let allTickers = [...new Set([...contextTickers, ...targetTickers])];
      
      if (this.currentBenchmark && !isSingleAsset) {
          allTickers.push(this.currentBenchmark);
      }
      allTickers = [...new Set(allTickers)];
      
      if (forceApi) {
          this.lastRefreshTime = Date.now();
          await this.dataManager.api.fetchBatchPrices(allTickers);
      }
      
      // 4. CALCULS GRAPHIQUE PRINCIPAL
      let graphData;
      if (isSingleAsset) {
         const ticker = (this.currentMode === 'asset') 
            ? this.selectedAssets[0] 
            : this.filterManager.getSelectedTickers().values().next().value;
         
         graphData = await this.dataManager.calculateAssetHistory(ticker, this.currentPeriod);
      } else {
         graphData = await this.dataManager.calculateHistory(targetAssetPurchases, this.currentPeriod);
      }

      const targetHoldings = this.dataManager.calculateHoldings(targetAssetPurchases);
      let targetSummary = this.dataManager.calculateSummary(targetHoldings);
      const targetCashReserve = this.dataManager.calculateCashReserve(targetCashPurchases);
      const contextHoldings = this.dataManager.calculateHoldings(contextAssetPurchases);
      
      this.lastYesterdayClose = graphData.yesterdayClose;

      let benchmarkData = null;
      if (this.currentBenchmark && !isSingleAsset) {
          const { startTs, endTs } = this.getStartEndTs(this.currentPeriod);
          const interval = this.dataManager.getIntervalForPeriod(this.currentPeriod);
          benchmarkData = await this.dataManager.api.getHistoricalPricesWithRetry(this.currentBenchmark, startTs, endTs, interval);
      }
      
      if (!graphData || graphData.labels.length === 0) {
        this.showMessage('Pas de données disponibles pour cette période');
      } else {
        this.renderChart(canvas, graphData, targetSummary, titleConfig, benchmarkData);
        
        // === C'EST ICI QUE LA MAGIE OPÈRE (VÉRITÉ 1D) ===
        let referenceDataForSummary = graphData;

        if (this.currentPeriod !== 1) {
            // Si on n'est pas en 1D, le graphData est "imprécis" (clôtures veille).
            // On fetch les données 1D en douce pour avoir le vrai prix actuel.
            try {
                if (isSingleAsset) {
                   const ticker = (this.currentMode === 'asset') ? this.selectedAssets[0] : this.filterManager.getSelectedTickers().values().next().value;
                   referenceDataForSummary = await this.dataManager.calculateAssetHistory(ticker, 1);
                } else {
                   referenceDataForSummary = await this.dataManager.calculateHistory(targetAssetPurchases, 1);
                }
            } catch (e) {
                console.warn("Fallback Summary: Impossible de fetcher la 1D", e);
            }
        }

        // On force le résumé à utiliser la donnée 1D précise
        targetSummary = this.syncSummaryWithChartData(targetSummary, referenceDataForSummary);
      }
      
      // 5. RENDU FINAL DES CARTES (avec le targetSummary corrigé)
      this.investmentsPage.renderData(contextHoldings, targetSummary, targetCashReserve.total);

    } catch (error) {
      console.error('Erreur graphique (update):', error);
      this.showMessage('Erreur lors du calcul', 'error');
    } finally {
      if (showLoading && loading) loading.style.display = 'none';
      this.isLoading = false;
    }
  }

  // === UTILITAIRES (Inchangés) ===
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

  // ==========================================================
  // Rendu (Inchangé)
  // ==========================================================
  renderChart(canvas, graphData, summary, titleConfig, benchmarkData = null) {
    if (this.chart) this.chart.destroy();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const info = document.getElementById('chart-info');
    if (info) info.style.display = 'none';

    // Titre
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
    
    const viewToggle = document.getElementById('view-toggle');
    const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';
    const isSingleAsset = (titleConfig && titleConfig.mode === 'asset');
    
    const isUnitView = isSingleAsset && activeView === 'unit';
    const displayValues = isUnitView ? graphData.unitPrices : graphData.values;

    // Stats
    const yesterdayCloseDisplay = isUnitView && this.lastYesterdayClose !== null 
      ? this.lastYesterdayClose / (summary.movementsCount || 1) 
      : this.lastYesterdayClose;
      
    const finalYesterdayClose = isUnitView ? null : this.lastYesterdayClose;

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
    if (finalYesterdayClose !== null && priceEnd !== null && !isNaN(priceEnd) && !isUnitView) {
      vsYesterdayAbs = priceEnd - finalYesterdayClose;
      vsYesterdayPct = finalYesterdayClose !== 0 ? (vsYesterdayAbs / finalYesterdayClose) * 100 : 0;
    }

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
    
    // Mise à jour de la barre de stats
    const statDayVar = document.getElementById('stat-day-var');
    const statYesterdayClose = document.getElementById('stat-yesterday-close');
    const group2 = document.querySelector('.stat-group-2');
    const is1DView = (this.currentPeriod === 1);
    if (group2) {
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

    // DATASETS
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
        hidden: true,
        spanGaps: true 
      },
      {
        label: isUnitView ? 'Prix unitaire (€)' : 'Valeur Portfolio (€)',
        data: displayValues,
        borderColor: mainChartColor,
        backgroundColor: this.hexToRgba(mainChartColor, 0.1),
        borderWidth: 3,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        spanGaps: true 
      }
    ];

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
    
    // === POINTS D'ACHAT ALIGNÉS ===
    if (isUnitView && graphData.purchasePoints) {
        datasets.push({
            type: 'line', 
            label: 'Points d\'achat',
            data: graphData.purchasePoints, 
            backgroundColor: '#FFFFFF',
            borderColor: '#3b82f6',
            borderWidth: 2,
            pointRadius: 5,
            pointHoverRadius: 8,
            showLine: false, // Cache la ligne
            parsing: {
                yAxisKey: 'y' // Indique à Chart.js où lire la valeur
            }
        });
    }

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
        this.renderChart(canvas, graphData, summary, titleConfig, benchmarkData); 
      };
    });

    this.chart = new Chart(ctx, {
      type: 'line', 
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
                    // Détection via le label du dataset
                    if (ctx.dataset.label === 'Points d\'achat') {
                        const dataPoint = ctx.raw;
                        // Vérification que dataPoint est bien l'objet complet
                        if (dataPoint && dataPoint.quantity) {
                            return ` Achat: ${dataPoint.quantity} @ ${dataPoint.y.toFixed(2)} €`;
                        }
                    }
                    // Pour les autres datasets, formatage standard
                    if (ctx.parsed.y !== null) {
                        return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(isUnitView ? 4 : 2)} €`;
                    }
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