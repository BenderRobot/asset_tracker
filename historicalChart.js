// ========================================
// historicalChart.js - (Améliorations Visuelles v3)
// ========================================

export class HistoricalChart {
  // Constructeur simplifié
  constructor(storage, dataManager) {
    this.storage = storage;
    this.dataManager = dataManager;
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
    this.liveSummary = null;
    
    this.injectChartStyles();
  }
  
  // Ajoute le CSS pour les améliorations visuelles
  injectChartStyles() {
    const styleId = 'historical-chart-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
      /* Amélioration des boutons Global/Unité */
      .view-toggle {
        border: 1px solid #e0e0e0;
        border-radius: 8px;
        overflow: hidden;
      }
      
      .view-toggle .toggle-btn {
        background-color: transparent;
        color: #777;
        border: none;
        padding: 6px 14px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease-in-out;
      }
      
      .view-toggle .toggle-btn.active {
        background-color: #3498db;
        color: white;
        box-shadow: 0 2px 8px rgba(52, 152, 219, 0.3);
      }
      
      .view-toggle .toggle-btn:first-of-type {
        border-right: 1px solid #e0e0e0;
      }
      
      /* Nouveaux styles pour le header du graphique */
      .chart-header-mini {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 12px;
      }
      
      .chart-header-mini .title-mini {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
      }
      
      .chart-header-mini .chart-title {
        margin-right: 16px;
      }

      /* Style pour la performance principale (ex: +50.00 €) */
      .chart-header-mini .perf-display-main {
        font-size: 1.4rem;
        font-weight: 700;
        line-height: 1.2;
      }
      
      .chart-header-mini .perf-display-main.positive { color: #2ecc71; }
      .chart-header-mini .perf-display-main.negative { color: #e74c3c; }
      .chart-header-mini .perf-display-main.neutral { color: #555; }

      .chart-header-mini .perf-display-main span {
        font-size: 1rem;
        font-weight: 600;
        margin-left: 6px;
      }

      /* Style pour le sous-titre "vs clôture hier" */
      .chart-header-mini .perf-subtitle-detail {
        font-size: 0.8rem;
        font-weight: 500;
        color: #888;
        margin-top: 4px;
        margin-left: 2px;
        width: 100%; /* Force le passage à la ligne */
        line-height: 1;
      }
      .chart-header-mini .perf-subtitle-detail.positive { color: #2ecc71; }
      .chart-header-mini .perf-subtitle-detail.negative { color: #e74c3c; }

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

  async init() {
    this.setupPeriodButtons();
    await this.update();
    this.startAutoRefresh();
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
      await this.updateChart(false); 
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
    this.liveSummary = summary; 
    await this.update();
  }

  async showAssetChart(ticker, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'asset';
    this.selectedAssets = [ticker];
    this.isCryptoOrGlobal = this.dataManager.isCryptoTicker(ticker); 
    this.liveSummary = summary; 
    await this.update();
  }

  async showPortfolioChart(summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'portfolio';
    this.selectedAssets = [];
    this.filteredPurchases = null;
    this.isCryptoOrGlobal = true;
    this.liveSummary = summary; 
    await this.update();
  }

  async changePeriod(days) {
    if (this.isLoading) return;
    this.currentPeriod = days;
    this.stopAutoRefresh(); 
    await this.update();
    this.startAutoRefresh(); 
  }

  async showFilteredPortfolioChart(filteredPurchases, summary = null) {
    if (this.isLoading) return;
    this.currentMode = 'filtered';
    this.filteredPurchases = filteredPurchases;
    this.isCryptoOrGlobal = true;
    this.liveSummary = summary;
    await this.update();
  }

  // ==========================================================
  // Logique de mise à jour (Simplifiée)
  // ==========================================================

  async update() {
    return this.updateChart(true);
  }

  async updateChart(showLoading = true) {
    if (this.isLoading) return;
    const canvas = document.getElementById('historical-portfolio-chart');
    if (!canvas) return;

    this.isLoading = true;
    const loading = document.getElementById('chart-loading');
    const info = document.getElementById('chart-info');

    if (showLoading) {
      if (loading) loading.style.display = 'block';
      if (info) info.style.display = 'none';
    }

    try {
      let data;
      
      if (this.currentMode === 'asset' && this.selectedAssets.length === 1) {
        data = await this.dataManager.calculateAssetHistory(this.selectedAssets[0], this.currentPeriod);
      } else if (this.currentMode === 'multiple' && this.selectedAssets.length > 1) {
        data = await this.dataManager.calculateMultipleAssetsHistory(this.filteredPurchases, this.currentPeriod);
      } else if (this.currentMode === 'filtered' && this.filteredPurchases) {
        if (this.filteredPurchases.length === 0) {
          this.showMessage('Aucun achat correspondant aux filtres');
          return;
        }
        data = await this.dataManager.calculateHistory(this.filteredPurchases, this.currentPeriod);
      } else {
        const purchases = this.storage.getPurchases();
        if (purchases.length === 0) {
          this.showMessage('Aucun achat enregistré');
          return;
        }
        data = await this.dataManager.calculateHistory(purchases, this.currentPeriod);
      }

      if (!data || data.labels.length === 0) {
        this.showMessage('Pas de données disponibles pour cette période');
        return;
      }

      this.renderChart(canvas, data);
    } catch (error) {
      console.error('Erreur graphique:', error);
      this.showMessage('Erreur lors du calcul', 'error');
    } finally {
      if (showLoading && loading) loading.style.display = 'none';
      this.isLoading = false;
    }
  }

  // ==========================================================
  // Logique de rendu (Vue)
  // ==========================================================

  renderChart(canvas, data) {
    if (this.chart) this.chart.destroy();
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
    
    // === Alignement Live vs Histo ===
    if (this.liveSummary && !isUnitView && displayValues.length > 0 && this.currentPeriod === 1) {
        console.log("Alignement des données Histo (1D) avec le Live Summary.");

        const livePriceEnd = this.liveSummary.totalCurrentEUR;
        displayValues[displayValues.length - 1] = livePriceEnd;
        data.labels[data.labels.length - 1] = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        const liveYesterdayClose = this.liveSummary.totalCurrentEUR - this.liveSummary.totalDayChangeEUR;
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
    
    // Détermine la couleur et la classe en se basant sur la VAR TODAY (vsYesterdayAbs)
    // si elle est disponible (en 1D), sinon se rabat sur la PERF PERIODE (perfAbs).
    const useTodayVar = vsYesterdayAbs !== null;
    const comparisonValue = useTodayVar ? vsYesterdayAbs : perfAbs;

    if (comparisonValue > 0.001) {
      mainChartColor = '#2ecc71'; // Vert
      perfClass = 'positive';
    } else if (comparisonValue < -0.001) {
      mainChartColor = '#e74c3c'; // Rouge
      perfClass = 'negative';
    }
    
    // --- AFFICHAGE TITRE ---
    // Affiche la VAR TODAY (vsYesterdayAbs) si on est en 1D,
    // sinon affiche la PERF PERIODE (perfAbs).
    const mainDisplayValue = useTodayVar ? vsYesterdayAbs : perfAbs;
    const mainDisplayPct = useTodayVar ? vsYesterdayPct : perfPct;
    
    const perfDisplayMain = document.getElementById('vs-yesterday-big');
    if (perfDisplayMain) {
      const sign = mainDisplayValue > 0 ? '+' : '';
      const signPct = mainDisplayPct > 0 ? '+' : '';
      perfDisplayMain.innerHTML = `${sign}${mainDisplayValue.toFixed(decimals)} € <span>(${signPct}${mainDisplayPct.toFixed(2)}%)</span>`;
      perfDisplayMain.className = `perf-display-main ${perfClass}`;
    }

    // --- AFFICHAGE SOUS-TITRE ---
    // S'affiche SEULEMENT si on est PAS en 1D (pour éviter la redondance)
    // Affiche "vs clôture hier" en 1D.
    const perfSubtitle = document.querySelector('.perf-subtitle'); // Cible la CLASSE
    if (perfSubtitle) {
      if (useTodayVar) {
        // En 1D, on affiche "vs clôture hier"
        perfSubtitle.innerHTML = `vs clôture hier`;
        perfSubtitle.className = `perf-subtitle-detail`; // Couleur neutre
      } else {
        // En 2D, 1M, etc., on affiche la performance de la période
        // (puisque le titre principal montre déjà la perf période, on pourrait le cacher)
        // Pour l'instant, on le cache pour éviter la confusion.
        perfSubtitle.innerHTML = ''; 
        perfSubtitle.className = 'perf-subtitle-detail';
      }
    }

    // --- STATS EN BAS ---
    // Affiche TOUJOURS la performance de la PÉRIODE (perfAbs)
    const perfLabel = document.getElementById('performance-label');
    const perfPercent = document.getElementById('performance-percent');
    if(perfLabel) {
      const sign = perfAbs > 0 ? '+' : '';
      const periodPerfClass = perfAbs > 0 ? 'positive' : (perfAbs < 0 ? 'negative' : 'neutral');
      perfLabel.textContent = `${sign}${perfAbs.toFixed(decimals)} €`;
      perfLabel.className = 'value ' + periodPerfClass;
    }
    if (perfPercent) {
      const sign = perfPct > 0 ? '+' : '';
      const periodPerfClass = perfPct > 0 ? 'positive' : (perfPct < 0 ? 'negative' : 'neutral');
      perfPercent.textContent = `(${sign}${perfPct.toFixed(2)}%)`;
      perfPercent.className = 'pct ' + periodPerfClass;
    }
    // ==========================================================
    // === FIN DE LA CORRECTION ===
    // ==========================================================

    ['price-start', 'price-end', 'price-high', 'price-low'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        const val = id === 'price-start' ? priceStart :
                    id === 'price-end' ? priceEnd :
                    id === 'price-high' ? priceHigh : priceLow;
        el.textContent = val !== -Infinity && val !== Infinity && val !== null
          ? `${val.toFixed(decimals)} €`
          : 'N/A';
      }
    });

    const unitPriceEl = document.getElementById('unit-price');
    if (unitPriceEl && isUnitView && priceEnd !== null) {
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
      viewToggle.style.display = 'flex';
      unitPriceRow.style.display = isUnitView ? 'flex' : 'none'; 
    } else {
      viewToggle.style.display = 'none';
      unitPriceRow.style.display = 'none';
    }

    // === Toggle clic ===
    viewToggle?.querySelectorAll('.toggle-btn').forEach(btn => {
      btn.onclick = () => {
        if (btn.classList.contains('active')) return;
        viewToggle.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.renderChart(canvas, data); // Re-render sans refetch
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