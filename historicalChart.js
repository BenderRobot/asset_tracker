// ========================================
// historicalChart.js - (Architecture "Zéro Incohérence")
// ========================================

export class HistoricalChart {
  // === MODIFICATION "ZÉRO INCOHÉRENCE" ===
  // Accepte UI et InvestmentsPage pour les callbacks
  constructor(storage, dataManager, ui, investmentsPage) {
    this.storage = storage;
    this.dataManager = dataManager;
    this.ui = ui; // Pour mettre à jour les cartes
    this.investmentsPage = investmentsPage; // Pour mettre à jour le tableau
    // ==========================================
    
    this.chart = null;
    this.currentPeriod = 1;
    this.isLoading = false;
    this.currentMode = 'portfolio';
    this.selectedAssets = [];
    this.filteredPurchases = null;
    this.isCryptoOrGlobal = true; 
    this.autoRefreshInterval = null;
    this.lastRefreshTime = null;
    this.lastYesterdayClose = null; 
    
    // Appel de la fonction de style (qui est maintenant définie)
    this.injectChartStyles();
  }
  
  // === CORRECTION : Fonction de style simplifiée (pour titre à gauche) ===
  injectChartStyles() {
    const styleId = 'historical-chart-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
      /* === AMÉLIORATION BOUTONS GLOBAL/UNITÉ === */
      .view-toggle {
        display: flex;
        gap: 8px; /* Espacer les boutons */
      }
      
      .view-toggle .toggle-btn {
        background-color: #1a2238; /* var(--bg-card) */
        color: #9fa6bc; /* var(--text-secondary) */
        border: 1px solid #2d3548; /* var(--border-color) */
        padding: 6px 16px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease-in-out;
        border-radius: 8px; /* Mettre la bordure sur le bouton */
      }
      
      .view-toggle .toggle-btn.active {
        background-color: #3b82f6; /* var(--accent-blue) */
        color: white;
        border-color: #3b82f6; /* var(--accent-blue) */
        box-shadow: 0 2px 8px rgba(59, 130, 246, 0.3);
        transform: translateY(-1px); /* Petit effet "pop" */
      }
      
      .view-toggle .toggle-btn:not(.active):hover {
          background-color: #22294a; /* var(--bg-hover) */
          border-color: #3b82f6; /* var(--accent-blue) */
      }
      
      /* === HEADER GRAPHIQUE === */
      .chart-header-mini {
        display: flex;
        justify-content: space-between; /* Aligne le titre à gauche et les contrôles à droite */
        align-items: center; 
        margin-bottom: 8px;
      }
      
      .chart-header-mini .title-mini {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
      }

      /* Styles pour la performance (déplacés) */
      .chart-header-mini .perf-display-main,
      .chart-header-mini .perf-subtitle-detail {
        display: none;
      }

      /* Cache la stat "PERIODE" redondante en bas */
      .chart-stats-bar .stat.stat-period {
        display: none;
      }
    `;
    document.head.appendChild(style);
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
      console.log('Auto-refresh activé (5 min) pour 1D');
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
    
    console.log('Rafraîchissement silencieux du graphique...');
    this.lastRefreshTime = now;
    try {
      // Le refresh silencieux n'affiche pas le loader, mais force l'API
      await this.update(false, true); 
    } catch (error) {
      console.warn('Erreur refresh silencieux:', error);
    }
  }

  // ==========================================================
  // Méthodes "show" (Contrôleur)
  // ==========================================================

  async showMultipleAssetsChart(purchases, tickers, summary = null) {
    if (this.isLoading) return;
    if (tickers.length === 1) {
      this.showAssetChart(tickers[0]);
      return;
    }
    this.currentMode = 'multiple';
    this.selectedAssets = tickers;
    this.filteredPurchases = purchases;
    this.isCryptoOrGlobal = true; 
    await this.update(false, false); // (showLoading = false, forceApi = false)
  }

  async showAssetChart(ticker, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'asset';
    this.selectedAssets = [ticker];
    this.isCryptoOrGlobal = this.dataManager.isCryptoTicker(ticker); 
    await this.update(true, false); // (showLoading = true, forceApi = false)
  }

  async showPortfolioChart(summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'portfolio';
    this.selectedAssets = [];
    this.filteredPurchases = null;
    this.isCryptoOrGlobal = true;
    await this.update(false, false); // (showLoading = false, forceApi = false)
  }

  async changePeriod(days) {
    if (this.isLoading) return;
    this.currentPeriod = days;
    this.stopAutoRefresh(); 
    await this.update(true, true); // (showLoading = true, forceApi = true)
    this.startAutoRefresh(); 
  }

  async showFilteredPortfolioChart(filteredPurchases, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'filtered';
    this.filteredPurchases = filteredPurchases;
    this.isCryptoOrGlobal = true;
    await this.update(false, false); // (showLoading = false, forceApi = false)
  }

  // ==========================================================
  // === NOUVELLE FONCTION "Cache-First" (chargement initial)
  // ==========================================================
  async loadPageWithCacheFirst() {
    if (this.isLoading) return;
    this.isLoading = true;
    console.log('--- Chargement Cache-First (Étape 1/3) : Rendu instantané Cartes & Tableau ---');

    let holdings, summary, purchases, tickers;
    const canvas = document.getElementById('historical-portfolio-chart');
    const graphLoader = document.getElementById('chart-loading');

    try {
      // --- ÉTAPE 1: Rendu instantané (Cartes & Tableau) depuis le cache ---
      
      // (Logique de filtrage copiée de 'update()')
      const searchQuery = this.investmentsPage.currentSearchQuery;
      purchases = this.storage.getPurchases(); // Get all

      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          purchases = purchases.filter(p => p.ticker.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      }
      const selectedTickers = this.investmentsPage.filterManager.getSelectedTickers();
      if (selectedTickers.size > 0) {
          purchases = purchases.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
      }

      if (purchases.length === 0) {
          this.showMessage('Aucun achat correspondant aux filtres');
          this.investmentsPage.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 });
          this.isLoading = false;
          return;
      }
      
      tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
      
      // Calculs SYNC (utilise le cache live de storage)
      holdings = this.dataManager.calculateHoldings(purchases);
      summary = this.dataManager.calculateSummary(holdings);
      
      // Rendu SYNC (le tableau et les cartes apparaissent)
      this.investmentsPage.renderData(holdings, summary);
      
    } catch (e) {
      console.error('Erreur Étape 1 (Cache-First)', e);
      this.showMessage('Erreur au chargement du cache', 'error');
      this.isLoading = false;
      return;
    }

    // --- ÉTAPE 2: Rendu du Graphique (depuis le cache historique) ---
    console.log('--- Chargement Cache-First (Étape 2/3) : Rendu Graphique (Cache) ---');
    // CORRECTION CENTRAGE : 'block' devient 'flex'
    if (graphLoader) graphLoader.style.display = 'flex'; 
    
    try {
      // (Cette fonction est async, mais rapide si le cache historique est plein)
      const graphData = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
      if (!graphData || graphData.labels.length === 0) {
           this.showMessage('Pas de données graphiques en cache. Cliquez sur "Refresh Prices"');
      } else {
           this.renderChart(canvas, graphData, summary);
      }
    } catch (e) {
      console.error('Erreur Étape 2 (Graph Cache)', e);
      this.showMessage('Erreur au chargement du graphique', 'error');
    } finally {
      if (graphLoader) graphLoader.style.display = 'none';
    }

    // --- ÉTAPE 3: Refresh API en arrière-plan (si nécessaire) ---
    console.log('--- Chargement Cache-First (Étape 3/3) : Vérification refresh API ---');
    // On libère le thread, puis on vérifie après un court délai
    setTimeout(async () => {
        try {
            await this.refreshDataFromAPIIfNeeded(purchases, tickers);
            this.isLoading = false; // Le chargement est terminé
        } catch (e) {
            console.error('Erreur Étape 3 (Refresh API)', e);
            // On ne met pas de message d'erreur, car la page est déjà affichée.
            this.isLoading = false;
        }
    }, 500); // 500ms delay
  }

  // ==========================================================
  // === NOUVELLE FONCTION (Refresh en arrière-plan)
  // ==========================================================
  async refreshDataFromAPIIfNeeded(purchases, tickers) {
      // Vérifier si le cache 'live' (5min/10min) est périmé
      const isStale = tickers.some(t => {
          const assetType = this.storage.getAssetType(t);
          return !this.storage.isCacheValid(t, assetType);
      });

      if (!isStale) {
          console.log('Cache-First: Données "live" à jour. Pas de refresh API.');
          return;
      }
      
      console.log('Cache-First: Données périmées. Refresh API en arrière-plan...');
      this.lastRefreshTime = Date.now();

      // 1. Fetch API
      await this.dataManager.api.fetchBatchPrices(tickers);
      
      // 2. Re-calculer cartes & tableau
      const newHoldings = this.dataManager.calculateHoldings(purchases);
      const newSummary = this.dataManager.calculateSummary(newHoldings);
      
      // 3. Re-rendre cartes & tableau
      this.investmentsPage.renderData(newHoldings, newSummary);
      
      // 4. Re-calculer & re-rendre le graphique
      const newGraphData = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
      this.renderChart(document.getElementById('historical-portfolio-chart'), newGraphData, newSummary);
      
      console.log('Cache-First: Refresh API en arrière-plan terminé.');
  }

  // ==========================================================
  // === ANCIENNE FONCTION "update" (pour le bouton Refresh)
  // ==========================================================
  async update(showLoading = true, forceApi = true) {
    if (this.isLoading) return;
    const canvas = document.getElementById('historical-portfolio-chart');
    if (!canvas) return;

    this.isLoading = true;
    const loading = document.getElementById('chart-loading');
    const info = document.getElementById('chart-info');

    if (showLoading) {
      // CORRECTION CENTRAGE : 'block' devient 'flex'
      if (loading) loading.style.display = 'flex'; 
      if (info) info.style.display = 'none';
    }

    try {
      // (Logique de filtrage copiée)
      const searchQuery = this.investmentsPage.currentSearchQuery;
      let purchases;
      
      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
        purchases = this.storage.getPurchases().filter(p => p.ticker.toUpperCase() === this.selectedAssets[0].toUpperCase());
      } else if (this.currentMode === 'multiple' && this.selectedAssets.length > 1) {
         purchases = this.filteredPurchases;
      } else if (this.currentMode === 'filtered' && this.filteredPurchases) {
         purchases = this.filteredPurchases;
      } else {
         // Mode 'portfolio'
         purchases = this.storage.getPurchases();
      }
      
      if (searchQuery) {
          const q = searchQuery.toLowerCase();
          purchases = purchases.filter(p => p.ticker.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
      }
      const selectedTickers = this.investmentsPage.filterManager.getSelectedTickers();
      if (selectedTickers.size > 0) {
          purchases = purchases.filter(p => selectedTickers.has(p.ticker.toUpperCase()));
      }

      if (purchases.length === 0) {
        this.showMessage('Aucun achat correspondant aux filtres');
        this.investmentsPage.renderData([], { totalInvestedEUR: 0, totalCurrentEUR: 0, totalDayChangeEUR: 0, gainTotal: 0, gainPct: 0, dayChangePct: 0, assetsCount: 0, movementsCount: 0 });
        return;
      }
      
      // === ÉTAPE 2 : FETCH API (centralisé)
      const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))];
      
      if (forceApi) {
          this.lastRefreshTime = Date.now();
          tickers.forEach(t => {
              if (this.storage.priceTimestamps[t]) {
                  this.storage.priceTimestamps[t] = 0; // Force l'expiration
              }
          });
          this.storage.savePricesCache();
          console.log('Cache forcé expiré pour le rafraîchissement.');
      }
      await this.dataManager.api.fetchBatchPrices(tickers);
      
      let graphData;
      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
         graphData = await this.dataManager.calculateAssetHistory(this.selectedAssets[0], this.currentPeriod);
      } else {
         graphData = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
      }

      if (!graphData || graphData.labels.length === 0) {
        this.showMessage('Pas de données disponibles pour cette période');
        return;
      }

      // === ÉTAPE 3 : CALCUL DES DONNÉES UNIFIÉES
      const holdings = this.dataManager.calculateHoldings(purchases);
      const summary = this.dataManager.calculateSummary(holdings);

      // === ÉTAPE 4 : DISTRIBUTION DES DONNÉES
      this.renderChart(canvas, graphData, summary);
      this.investmentsPage.renderData(holdings, summary);

    } catch (error) {
      console.error('Erreur graphique (update):', error);
      this.showMessage('Erreur lors du calcul', 'error');
    } finally {
      if (showLoading && loading) loading.style.display = 'none';
      this.isLoading = false;
    }
  }


  // ==========================================================
  // Logique de rendu (Vue)
  // ==========================================================

  // MODIFICATION : Accepte 'summary' pour l'alignement
  renderChart(canvas, data, summary) {
    if (this.chart) this.chart.destroy();
    if (!canvas) {
        console.error("Canvas non trouvé pour le rendu du graphique");
        return;
    }
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
        // CORRECTION: '`' (backtick) non échappé
        title = `${ticker} • ${name}`;
        icon = this.dataManager.isCryptoTicker(ticker) ? '₿' : '📊'; 
        color = this.dataManager.isCryptoTicker(ticker) ? '#f1c40f' : '#2ecc71';
      }

      titleText.textContent = title;
      titleIcon.textContent = icon;
      titleIcon.style.color = color;
    }

    // === DÉTECTION MODE UNITAIRE ===
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

    // === Valeurs affichées ===
    const displayValues = isUnitView
      ? data.values.map(v => v !== null ? v / totalQty : null)
      : data.values;

    // === Clôture hier affichée ===
    let yesterdayCloseTotal = data.yesterdayClose;
    
    // =======================================================
    // === MODIFICATION "ZÉRO INCOHÉRENCE" (RESTAURÉE) ===
    // =======================================================
    if (summary && !isUnitView && displayValues.length > 0 && this.currentPeriod === 1) {
        console.log("Alignement des données Histo (1D) avec le Live Summary.");

        const livePriceEnd = summary.totalCurrentEUR;
        displayValues[displayValues.length - 1] = livePriceEnd;
        data.labels[data.labels.length - 1] = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        const liveYesterdayClose = summary.totalCurrentEUR - summary.totalDayChangeEUR;
        yesterdayCloseTotal = liveYesterdayClose;
        this.lastYesterdayClose = liveYesterdayClose;
    
    } else if (yesterdayCloseTotal !== null) { 
      this.lastYesterdayClose = yesterdayCloseTotal;
    } else {
      this.lastYesterdayClose = null; // Force à null pour 2D, 1W, etc.
    }


    const yesterdayCloseDisplay = isUnitView && this.lastYesterdayClose !== null
      ? this.lastYesterdayClose / totalQty
      : this.lastYesterdayClose;

    // === Calculs d'affichage ===
    const firstIndex = displayValues.findIndex(v => v !== null && !isNaN(v));
    let lastIndex = displayValues.length - 1;
    while (lastIndex >= 0 && (displayValues[lastIndex] === null || isNaN(displayValues[lastIndex]))) lastIndex--;

    let perfAbs = 0, perfPct = 0; // Performance de la PÉRIODE
    let priceStart = 0, priceEnd = 0, priceHigh = -Infinity, priceLow = Infinity;
    const decimals = isUnitView ? 4 : 2;

    if (firstIndex >= 0 && lastIndex >= 0) {
      priceStart = displayValues[firstIndex];
      priceEnd = displayValues[lastIndex]; 
      perfAbs = priceEnd - priceStart;
      perfPct = priceStart !== 0 ? (perfAbs / priceStart) * 100 : 0;

      displayValues.forEach(v => {
        if (v !== null && !isNaN(v)) {
          priceHigh = Math.max(priceHigh, v);
          priceLow = Math.min(priceLow, v);
        }
      });
    }

    // === Variation vs hier (VAR TODAY) ===
    let vsYesterdayAbs = null, vsYesterdayPct = null;
    if (this.lastYesterdayClose !== null && priceEnd !== null) {
      vsYesterdayAbs = priceEnd - yesterdayCloseDisplay;
      vsYesterdayPct = yesterdayCloseDisplay !== 0 ? (vsYesterdayAbs / yesterdayCloseDisplay) * 100 : 0;
    }

    // ==========================================================
    // === LOGIQUE DE COULEUR ET D'AFFICHAGE (CORRIGÉE) ===
    // ==========================================================

    let mainChartColor = '#3498db'; // Bleu par défaut
    let perfClass = 'neutral';
    
    const useTodayVar = vsYesterdayAbs !== null;
    const comparisonValue = useTodayVar ? vsYesterdayAbs : perfAbs;

    if (comparisonValue > 0.001) {
      mainChartColor = '#2ecc71'; // Vert
      perfClass = 'positive';
    } else if (comparisonValue < -0.001) {
      mainChartColor = '#e74c3c'; // Rouge
      perfClass = 'negative';
    }
    
    // --- (SUPPRIMÉ) AFFICHAGE TITRE ---
    // --- (SUPPRIMÉ) AFFICHAGE SOUS-TITRE ---

    // --- STATS EN BAS (PÉRIODE) ---
    const perfLabel = document.getElementById('performance-label');
    const perfPercent = document.getElementById('performance-percent');
    if(perfLabel) {
      const sign = perfAbs > 0 ? '+' : '';
      const periodPerfClass = perfAbs > 0 ? 'positive' : (perfAbs < 0 ? 'negative' : 'neutral');
      // CORRECTION: '`' non échappé
      perfLabel.textContent = `${sign}${perfAbs.toFixed(decimals)} €`;
      perfLabel.className = 'value ' + periodPerfClass;
    }
    if (perfPercent) {
      const sign = perfPct > 0 ? '+' : '';
      const periodPerfClass = perfPct > 0 ? 'positive' : (perfPct < 0 ? 'negative' : 'neutral');
      // CORRECTION: '`' non échappé
      perfPercent.textContent = `(${sign}${perfPct.toFixed(2)}%)`;
      perfPercent.className = 'pct ' + periodPerfClass;
    }

    // ==========================================================
    // === MODIFICATION 3 : Remplir les nouvelles stats (Jour + Clôture) ===
    // ==========================================================
    const statDayVar = document.getElementById('stat-day-var');
    const statYesterdayClose = document.getElementById('stat-yesterday-close');

    if (useTodayVar && statDayVar) { // useTodayVar vient du calcul vsYesterdayAbs
        const dayVarLabel = document.getElementById('day-var-label');
        const dayVarPct = document.getElementById('day-var-percent');
        const sign = vsYesterdayAbs > 0 ? '+' : '';
        const signPct = vsYesterdayPct > 0 ? '+' : '';
        
        // CORRECTION: '`' non échappé
        dayVarLabel.innerHTML = `${sign}${vsYesterdayAbs.toFixed(decimals)} €`;
        dayVarPct.innerHTML = `(${signPct}${vsYesterdayPct.toFixed(2)}%)`;
        dayVarLabel.className = `value ${perfClass}`;
        dayVarPct.className = `pct ${perfClass}`;
        statDayVar.style.display = 'flex';
    } else if (statDayVar) {
        statDayVar.style.display = 'none';
    }

    if (yesterdayCloseDisplay !== null && statYesterdayClose) {
        const closeValue = document.getElementById('yesterday-close-value');
        // CORRECTION: '`' non échappé
        closeValue.textContent = `${yesterdayCloseDisplay.toFixed(decimals)} €`;
        statYesterdayClose.style.display = 'flex';
    } else if (statYesterdayClose) {
        statYesterdayClose.style.display = 'none';
    }
    // ==========================================================
    // === FIN DE LA MODIFICATION 3 ===
    // ==========================================================


    ['price-start', 'price-end', 'price-high', 'price-low'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const val = id === 'price-start' ? priceStart :
                        id === 'price-end' ? priceEnd :
                        id === 'price-high' ? priceHigh : priceLow;
        // CORRECTION: '`' non échappé
        el.textContent = val !== -Infinity && val !== Infinity && val !== null
          ? `${val.toFixed(decimals)} €`
          : 'N/A';
      }
    });

    const unitPriceEl = document.getElementById('unit-price');
    if (unitPriceEl && isUnitView && priceEnd !== null) {
      // CORRECTION: '`' non échappé
      unitPriceEl.textContent = `${priceEnd.toFixed(4)} €`;
    }

    document.getElementById('last-update').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    // === Datasets ===
    const datasets = [
      { 
        label: 'Investi (€)', 
        data: data.invested, 
        borderColor: '#e74c3c',
        backgroundColor: 'transparent',
        borderWidth: 2, 
        fill: false, 
        tension: 0.1, 
        pointRadius: 0, 
        borderDash: [5, 5], 
        hidden: true // Caché par défaut
      },
      {
        label: isUnitView ? 'Prix unitaire (€)' : 'Valeur réelle (€)',
        data: displayValues,
        borderColor: mainChartColor, // Couleur dynamique
        backgroundColor: this.hexToRgba(mainChartColor, 0.1), // Remplissage dynamique
        borderWidth: 3,
        fill: true,
        tension: 0.3,
        pointRadius: data.labels.length > 100 ? 0 : 2
      }
    ];

    // N'affiche la clôture hier que si on a la donnée (en 1D)
    if (this.lastYesterdayClose !== null) {
      const dashData = Array(data.labels.length).fill(yesterdayCloseDisplay); 
      datasets.push({
        label: 'Clôture hier',
        data: dashData,
        borderColor: '#95a5a6',
        borderWidth: 2,
        borderDash: [6, 4],
        fill: false,
        pointRadius: 0
      });
    }

    // === Toggle visibilité ===
    const unitPriceRow = document.getElementById('unit-price-row');
    if (isSingleAsset && totalQty > 0) {
      if(viewToggle) viewToggle.style.display = 'flex';
      if(unitPriceRow) unitPriceRow.style.display = isUnitView ? 'flex' : 'none'; 
    } else {
      if(viewToggle) viewToggle.style.display = 'none';
      if(unitPriceRow) unitPriceRow.style.display = 'none';
    }

    // === Toggle clic ===
    viewToggle?.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.onclick = () => {
        if (btn.classList.contains('active')) return;
        viewToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderChart(canvas, data, summary); // Re-render sans refetch
      };
    });

    // === Création du graphique ===
    this.chart = new Chart(ctx, {
      type: 'line',
      data: { labels: data.labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false, hoverRadius: 12 },
        plugins: {
          legend: { 
            position: 'top', 
            labels: { usePointStyle: true, padding: 20 } 
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(0,0,0,0.85)',
            padding: 12,
            titleFont: { weight: 'bold' },
            callbacks: {
              // CORRECTION: '`' non échappé
              label: ctx => ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(isUnitView ? 4 : 2)} €`
            }
          }
        },
        scales: {
          x: { 
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
            title: { display: false },
            ticks: { 
              // CORRECTION: '`' non échappé
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
  }

  showMessage(message, type = 'info') {
    const info = document.getElementById('chart-info');
    if (!info) return;
    // CORRECTION: '`' non échappé
    info.innerHTML = `${type === 'error' ? '⚠️' : 'ℹ️'} ${message}`;
    info.style.display = 'block';
    info.style.color = type === 'error' ? '#dc3545' : '#666';
    
    const loading = document.getElementById('chart-loading');
    if (loading) loading.style.display = 'none';
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  destroy() {
    this.stopAutoRefresh();
    if (this.chart) {
      this.chart.destroy();
      this.chart = null;
    }
  }
}