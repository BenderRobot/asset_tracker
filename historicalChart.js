// ========================================
// historicalChart.js - Architecture "Zéro Incohérence" (CORRIGÉ v4 - Source Unique)
// ========================================

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
    this.filteredPurchases = null;
    this.isCryptoOrGlobal = true; 
    this.autoRefreshInterval = null;
    this.lastRefreshTime = null;
    this.lastYesterdayClose = null; // Défini par dataManager
    
    // Style géré par style.css
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
        
        this.changePeriod(period === 'all' ? 'all' : parseInt(period));
      });
    });
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
    await this.update(true, false);
  }

  async changePeriod(days) {
    if (this.isLoading) return;
    this.currentPeriod = days;
    this.stopAutoRefresh(); 
    await this.update(true, true);
    this.startAutoRefresh(); 
  }

  // ==========================================================
  // === "Cache-First" & RESET (Logique de chargement de page) ===
  // ==========================================================
  async loadPageWithCacheFirst() {
    if (this.isLoading) return;
    this.isLoading = true;
    
    // CORRECTION BUG CLEAR FILTERS : On remet le mode par défaut
    this.currentMode = 'portfolio';
    this.selectedAssets = [];

    const graphLoader = document.getElementById('chart-loading');
    const canvas = document.getElementById('historical-portfolio-chart');

    try {
      // 1. Récupérer TOUS les achats filtrés (pour le tableau)
      const purchases = this.getFilteredPurchasesFromPage();
      
      if (purchases.length === 0) {
          this.showMessage('Aucun achat correspondant aux filtres');
          this.investmentsPage.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 });
          this.isLoading = false;
          return;
      }
      
      const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
      
      // 2. Calculs & Rendu SYNC (Tableau + Cartes)
      const holdings = this.dataManager.calculateHoldings(purchases);
      let summary = this.dataManager.calculateSummary(holdings); // 'let' au lieu de 'const'
      
      // 3. Rendu Graphique (Cache)
      if (graphLoader) graphLoader.style.display = 'flex';
      
      let historicalChanges = { historicalDayChange: null, historicalDayChangePct: null };
      try {
        const graphData = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
        
        // === Logique de Clôture UNIFIÉE (Source Historique) ===
        this.lastYesterdayClose = graphData.yesterdayClose;
        // =======================================================
        
        if (!graphData || graphData.labels.length === 0) {
             this.showMessage('Pas de données graphiques en cache. Cliquez sur "Refresh Prices"');
        } else {
             // Rendre le graphique, qui renvoie la VRAIE variation
             historicalChanges = this.renderChart(canvas, graphData, summary);
        }
      } catch (e) {
        console.error('Erreur Graph Cache', e);
      } finally {
        if (graphLoader) graphLoader.style.display = 'none';
      }

      // 4. ÉCRASER la Var. Jour "live" par la Var. Jour "historique"
      if (historicalChanges.historicalDayChange !== null) {
          summary.totalDayChangeEUR = historicalChanges.historicalDayChange;
          summary.dayChangePct = historicalChanges.historicalDayChangePct;
      }

      // 5. Rendre le tableau et les cartes avec les données UNIFIÉES
      this.investmentsPage.renderData(holdings, summary);

      // 6. Refresh API arrière-plan
      setTimeout(async () => {
          try {
              await this.refreshDataFromAPIIfNeeded(purchases, tickers);
          } finally {
              this.isLoading = false;
          }
      }, 500);

    } catch (e) {
      console.error('Erreur chargement', e);
      this.isLoading = false;
    }
  }

  async refreshDataFromAPIIfNeeded(purchases, tickers) {
      const isStale = tickers.some(t => {
          const assetType = this.storage.getAssetType(t);
          return !this.storage.isCacheValid(t, assetType);
      });

      if (!isStale) return;
      
      this.lastRefreshTime = Date.now();
      await this.dataManager.api.fetchBatchPrices(tickers);
      
      // Re-calcul total
      const newHoldings = this.dataManager.calculateHoldings(purchases);
      let newSummary = this.dataManager.calculateSummary(newHoldings); // 'let' au lieu de 'const'
      
      // Recalculer le graphique et la clôture historique
      const newGraphData = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
      // === Logique de Clôture UNIFIÉE (Source Historique) ===
      this.lastYesterdayClose = newGraphData.yesterdayClose;
      // =======================================================
      
      // Rendre le graphique, qui renvoie la VRAIE variation
      const historicalChanges = this.renderChart(document.getElementById('historical-portfolio-chart'), newGraphData, newSummary);

      // ÉCRASER la Var. Jour "live" par la Var. Jour "historique"
      if (historicalChanges.historicalDayChange !== null) {
          newSummary.totalDayChangeEUR = historicalChanges.historicalDayChange;
          newSummary.dayChangePct = historicalChanges.historicalDayChangePct;
      }
      
      // Rendre le tableau et les cartes avec les données UNIFIÉES
      this.investmentsPage.renderData(newHoldings, newSummary);
  }

  // ==========================================================
  // === Logique de MISE À JOUR (Clic, Période, Refresh) ===
  // ==========================================================
  async update(showLoading = true, forceApi = true) {
    if (this.isLoading) return;
    const canvas = document.getElementById('historical-portfolio-chart');
    if (!canvas) return;

    this.isLoading = true;
    const loading = document.getElementById('chart-loading');
    const info = document.getElementById('chart-info');

    if (showLoading) {
      if (loading) loading.style.display = 'flex'; 
      if (info) info.style.display = 'none';
    }

    try {
      // 1. CONTEXTE GLOBAL (Ce qu'on affiche dans le TABLEAU)
      const contextPurchases = this.getFilteredPurchasesFromPage();

      if (contextPurchases.length === 0) {
        this.showMessage('Aucun achat correspondant aux filtres');
        this.investmentsPage.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 });
        return;
      }

      // 2. CIBLE DU GRAPHIQUE (Ce qu'on affiche dans le GRAPHIQUE et les CARTES)
      let targetPurchases = contextPurchases;
      
      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
          targetPurchases = contextPurchases.filter(p => p.ticker.toUpperCase() === this.selectedAssets[0].toUpperCase());
      }
      
      // 3. FETCH API (On met à jour TOUT le contexte)
      const tickers = [...new Set(contextPurchases.map(p => p.ticker.toUpperCase()))];
      
      if (forceApi) {
          this.lastRefreshTime = Date.now();
          tickers.forEach(t => { if (this.storage.priceTimestamps[t]) this.storage.priceTimestamps[t] = 0; });
          this.storage.savePricesCache();
      }
      await this.dataManager.api.fetchBatchPrices(tickers);
      
      // 4. CALCULS
      
      // A. Données Graphique (sur la CIBLE)
      let graphData;
      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
         graphData = await this.dataManager.calculateAssetHistory(this.selectedAssets[0], this.currentPeriod);
      } else {
         graphData = await this.dataManager.calculateHistory(targetPurchases, this.currentPeriod);
      }

      // B. Données Cartes "Summary" (sur la CIBLE)
      const targetHoldings = this.dataManager.calculateHoldings(targetPurchases);
      let targetSummary = this.dataManager.calculateSummary(targetHoldings); // 'let'

      // C. Données Tableau (sur le CONTEXTE)
      const contextHoldings = this.dataManager.calculateHoldings(contextPurchases);
      
      // === Logique de Clôture UNIFIÉE (Source Historique) ===
      this.lastYesterdayClose = graphData.yesterdayClose;
      // =======================================================

      let historicalChanges = { historicalDayChange: null, historicalDayChangePct: null };
      if (!graphData || graphData.labels.length === 0) {
        this.showMessage('Pas de données disponibles pour cette période');
      } else {
        // E. Rendre le graphique, qui renvoie la VRAIE variation
        historicalChanges = this.renderChart(canvas, graphData, targetSummary);
      }
      
      // F. ÉCRASER la Var. Jour "live" par la Var. Jour "historique"
      if (historicalChanges.historicalDayChange !== null) {
          targetSummary.totalDayChangeEUR = historicalChanges.historicalDayChange;
          targetSummary.dayChangePct = historicalChanges.historicalDayChangePct;
      }

      // G. Rendre le tableau et les cartes avec les données UNIFIÉES
      this.investmentsPage.renderData(contextHoldings, targetSummary);

    } catch (error) {
      console.error('Erreur graphique (update):', error);
      this.showMessage('Erreur lors du calcul', 'error');
    } finally {
      if (showLoading && loading) loading.style.display = 'none';
      this.isLoading = false;
    }
  }

  // Helper pour récupérer les achats selon les filtres de la page
  getFilteredPurchasesFromPage() {
      const searchQuery = this.investmentsPage.currentSearchQuery;
      let purchases = this.storage.getPurchases();
      
      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          purchases = purchases.filter(p => p.ticker.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      }
      const selectedTickers = this.investmentsPage.filterManager.getSelectedTickers();
      if (selectedTickers.size > 0) {
          purchases = purchases.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
      }
      if (this.investmentsPage.currentAssetTypeFilter) {
          purchases = purchases.filter(p => (p.assetType || 'Stock') === this.investmentsPage.currentAssetTypeFilter);
      }
      if (this.investmentsPage.currentBrokerFilter) {
          purchases = purchases.filter(p => (p.broker || 'RV-CT') === this.investmentsPage.currentBrokerFilter);
      }
      
      return purchases;
  }

  // ==========================================================
  // Rendu
  // ==========================================================

  renderChart(canvas, data, summary) {
    if (this.chart) this.chart.destroy();
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const info = document.getElementById('chart-info');
    if (info) info.style.display = 'none';

    // === TITRE ===
    const titleText = document.getElementById('chart-title-text');
    const titleIcon = document.getElementById('chart-title-icon');
    if (titleText && titleIcon) {
      let title = 'Portfolio Global';
      let icon = '📈'; 
      let color = '#3498db';

      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
        const ticker = this.selectedAssets[0];
        const name = this.storage.getPurchases().find(p => p.ticker.toUpperCase() === ticker.toUpperCase())?.name || ticker;
        title = `${ticker} • ${name}`;
        icon = this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊'; 
        color = this.dataManager.isCryptoTicker(ticker) ? '#f1c40f' : '#2ecc71';
      }

      titleText.textContent = title;
      titleIcon.textContent = icon;
      titleIcon.style.color = color;
    }

    // === MODE UNITAIRE ===
    const viewToggle = document.getElementById('view-toggle');
    const activeView = viewToggle?.querySelector('.toggle-btn.active')?.dataset.view || 'global';
    const isSingleAsset = this.currentMode === 'asset' && this.selectedAssets.length === 1;
    
    let totalQty = 0;
    if (isSingleAsset) {
      const ticker = this.selectedAssets[0];
      const purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === ticker.toUpperCase());
      totalQty = purchases.reduce((sum, p) => sum + parseFloat(p.quantity), 0);
    }
    
    const isUnitView = isSingleAsset && activeView === 'unit' && totalQty > 0;
    const displayValues = isUnitView ? data.values.map(v => v !== null ? v / totalQty : null) : data.values;

    // === Clôture hier (SOURCE UNIQUE) ===
    // 'this.lastYesterdayClose' est maintenant la SEULE source de vérité
    
    // Aligner le PRIX DE FIN du 1D avec le summary "live" (pour la fluidité)
    if (summary && !isUnitView && displayValues.length > 0 && this.currentPeriod === 1) {
        const livePriceEnd = summary.totalCurrentEUR;
        if (displayValues.length > 0) {
            displayValues[displayValues.length - 1] = livePriceEnd;
        }
        if (data.labels.length > 0) {
            data.labels[data.labels.length - 1] = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        }
    }
    
    const yesterdayCloseDisplay = isUnitView && this.lastYesterdayClose !== null 
      ? this.lastYesterdayClose / totalQty 
      : this.lastYesterdayClose;

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

    // Calcul de la Var. Jour (maintenant basé sur la clôture historique)
    let vsYesterdayAbs = null, vsYesterdayPct = null;
    if (this.lastYesterdayClose !== null && priceEnd !== null && !isNaN(priceEnd)) {
      vsYesterdayAbs = priceEnd - yesterdayCloseDisplay;
      vsYesterdayPct = yesterdayCloseDisplay !== 0 ? (vsYesterdayAbs / yesterdayCloseDisplay) * 100 : 0;
    }

    // Couleur Chart
    const useTodayVar = vsYesterdayAbs !== null;
    const comparisonValue = useTodayVar ? vsYesterdayAbs : perfAbs;
    let mainChartColor = '#3498db'; 
    let perfClass = 'neutral';

    if (comparisonValue > 0.001) { mainChartColor = '#2ecc71'; perfClass = 'positive'; } 
    else if (comparisonValue < -0.001) { mainChartColor = '#e74c3c'; perfClass = 'negative'; }

    // Mise à jour DOM Stats
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

    if (useTodayVar && statDayVar) { 
        document.getElementById('day-var-label').innerHTML = `${vsYesterdayAbs > 0 ? '+' : ''}${vsYesterdayAbs.toFixed(decimals)} €`;
        document.getElementById('day-var-percent').innerHTML = `(${vsYesterdayPct > 0 ? '+' : ''}${vsYesterdayPct.toFixed(2)}%)`;
        document.getElementById('day-var-label').className = `value ${perfClass}`;
        document.getElementById('day-var-percent').className = `pct ${perfClass}`;
        statDayVar.style.display = 'flex';
    } else if (statDayVar) { statDayVar.style.display = 'none'; }

    if (yesterdayCloseDisplay !== null && statYesterdayClose) {
        document.getElementById('yesterday-close-value').textContent = `${yesterdayCloseDisplay.toFixed(decimals)} €`;
        statYesterdayClose.style.display = 'flex';
    } else if (statYesterdayClose) { statYesterdayClose.style.display = 'none'; }

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

    // === DATASETS ===
    const datasets = [
      { 
        label: 'Investi (€)', 
        data: data.invested, 
        borderColor: '#3b82f6', // BLEU
        backgroundColor: 'transparent',
        borderWidth: 2, 
        fill: false, 
        tension: 0.1, 
        pointRadius: 0, 
        borderDash: [5, 5], 
        hidden: true 
      },
      {
        label: isUnitView ? 'Prix unitaire (€)' : 'Valeur réelle (€)',
        data: displayValues,
        borderColor: mainChartColor,
        backgroundColor: this.hexToRgba(mainChartColor, 0.1),
        borderWidth: 3,
        fill: true,
        tension: 0.3,
        pointRadius: data.labels.length > 100 ? 0 : 2
      }
    ];

    if (this.lastYesterdayClose !== null) {
      datasets.push({
        label: 'Clôture hier',
        data: Array(data.labels.length).fill(yesterdayCloseDisplay),
        borderColor: '#95a5a6',
        borderWidth: 2,
        borderDash: [6, 4],
        fill: false,
        pointRadius: 0
      });
    }

    // Toggles
    const unitPriceRow = document.getElementById('unit-price-row');
    if (isSingleAsset && totalQty > 0) {
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
        this.renderChart(canvas, data, summary); 
      };
    });

    this.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, hoverRadius: 12 },
        plugins: {
          legend: { position: 'top', labels: { usePointStyle: true, padding: 20 } },
          tooltip: {
            mode: 'index', intersect: false, backgroundColor: 'rgba(0,0,0,0.85)', padding: 12,
            titleFont: { weight: 'bold' },
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(isUnitView ? 4 : 2)} €` }
          }
        },
        scales: {
          x: { 
            display: true, // AXE X VISIBLE
            title: { display: false },
            ticks: { 
              maxRotation: 0, 
              autoSkip: true, 
              maxTicksLimit: (this.currentPeriod === 1 || this.currentPeriod === 2) ? 8 : 10,
              color: '#888'
            },
            grid: {
              color: 'rgba(200, 200, 200, 0.1)' 
            }
          },
          y: { 
            display: true,
            ticks: { 
              callback: (value) => `${value.toLocaleString('fr-FR')} €`,
              color: '#888'
            },
            grid: {
              color: 'rgba(200, 200, 200, 0.1)'
            }
          }
        }
    
      }
    });
    
    // RENVOYER LA VARIATION HISTORIQUE
    return { historicalDayChange: vsYesterdayAbs, historicalDayChangePct: vsYesterdayPct };
  
  } // Fin de renderChart

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