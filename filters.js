// benderrobot/asset_tracker/asset_tracker-d2b20147fdbaa70dfad9c7d62d05505272e63ca2/filters.js

// ========================================
// filters.js - Filtres avec mise à jour dynamique
// ========================================

import { eventBus } from './eventBus.js'; // <-- AJOUTÉ

export class FilterManager {
  constructor(storage) {
    this.storage = storage;
    this.selectedTickers = new Set();
    this.selectedAssetType = '';
    this.selectedBroker = '';
    this.onFilterChangeCallback = null;
  }

  updateTickerFilter(onFilterChange) {
    this.onFilterChangeCallback = onFilterChange;
    const container = document.getElementById('ticker-filter-dropdown');
    if (!container) return;
    
    const map = new Map();
    this.storage.getPurchases().forEach(p => {
      if (!map.has(p.ticker)) map.set(p.ticker, p.name);
    });
    
    const sorted = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const count = this.selectedTickers.size;
    const buttonText = count === 0 ? 'All Assets' : `${count} actif${count > 1 ? 's' : ''}`;
    
    container.innerHTML = `
      <div style="position:relative;display:inline-block;">
        <button id="filter-toggle" style="min-width:200px;display:flex;justify-content:space-between;align-items:center;">
          <span>${buttonText}</span><span>▼</span>
        </button>
        
        <div id="filter-dropdown" style="display:none;position:absolute;top:100%;left:0;background:#1a2238;color:#ffffff;border:1px solid #2d3548;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.5);z-index:1000;min-width:300px;max-height:400px;overflow-y:auto;margin-top:5px;">
          
          <div style="padding:10px;border-bottom:1px solid #2d3548;display:flex;gap:10px;">
            <button id="select-all-tickers" style="flex:1;padding:6px;font-size:12px;">Tout sélectionner</button>
            <button id="clear-all-tickers" style="flex:1;padding:6px;font-size:12px;background:#dc3545;color:white;">Tout désélectionner</button>
          </div>
          
          <div style="padding:10px;">
            ${sorted.map(([t, n]) => `
              <label style="display:flex;align-items:center;gap:8px;padding:8px;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='#22294a'" onmouseout="this.style.background='transparent'">
                <input type="checkbox" class="ticker-checkbox" value="${t}" ${this.selectedTickers.has(t) ? 'checked' : ''}>
                <span><strong>${t}</strong> - ${n}</span>
              </label>
            `).join('')}
          </div>
        </div>
      </div>`;

    document.getElementById('filter-toggle')?.addEventListener('click', e => {
      e.stopPropagation();
      const d = document.getElementById('filter-dropdown');
      d.style.display = d.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('select-all-tickers')?.addEventListener('click', e => {
      e.stopPropagation();
      sorted.forEach(([t]) => this.selectedTickers.add(t));
      this.updateTickerFilter(onFilterChange);
      this.triggerFilterChange();
    });

    document.getElementById('clear-all-tickers')?.addEventListener('click', e => {
      e.stopPropagation();
      this.selectedTickers.clear();
      this.updateTickerFilter(onFilterChange);
      this.triggerFilterChange();
    });

    document.querySelectorAll('.ticker-checkbox').forEach(cb => {
      cb.onchange = () => {
        cb.checked ? this.selectedTickers.add(cb.value) : this.selectedTickers.delete(cb.value);
        this.updateTickerFilter(onFilterChange);
        this.triggerFilterChange();
      };
    });

    // Fermer le dropdown en cliquant ailleurs
    document.addEventListener('click', (e) => {
      const dropdown = document.getElementById('filter-dropdown');
      const toggle = document.getElementById('filter-toggle');
      if (dropdown && toggle && !dropdown.contains(e.target) && !toggle.contains(e.target)) {
        dropdown.style.display = 'none';
      }
    });
  }

  setAssetTypeFilter(assetType) {
    this.selectedAssetType = assetType;
    this.triggerFilterChange();
  }

  setBrokerFilter(broker) {
    this.selectedBroker = broker;
    this.triggerFilterChange();
  }

  clearAllFilters() {
    this.selectedTickers.clear();
    this.selectedAssetType = '';
    this.selectedBroker = '';
    
    // Réinitialiser les sélecteurs
    const assetTypeSelect = document.getElementById('filter-asset-type');
    const brokerSelect = document.getElementById('filter-broker');
    if (assetTypeSelect) assetTypeSelect.value = '';
    if (brokerSelect) brokerSelect.value = '';
    
    this.updateTickerFilter(this.onFilterChangeCallback);
    this.triggerFilterChange();
  }

  // MODIFIÉ: Ajout de la logique de vérification du graphique
  triggerFilterChange() {
    if (this.onFilterChangeCallback) {
      this.onFilterChangeCallback();
    }
    
    // LOGIQUE DE MISE À JOUR DU GRAPHIQUE (UNIQUEMENT SUR INVESTMENTS.HTML)
    if (window.location.pathname.includes('investments.html')) {
        const count = this.selectedTickers.size;
        
        if (count === 1) {
            const ticker = Array.from(this.selectedTickers)[0];
            // Émet l'événement que historicalChart.js écoute pour passer en mode actif unique.
            eventBus.dispatchEvent(new CustomEvent('showAssetChart', { 
                detail: { ticker: ticker, summary: null } // summary: null est conservé pour la compatibilité
            }));
        } else {
            // Efface le graphique pour revenir au mode portfolio global/filtré si le filtre est désactivé ou a plusieurs actifs
            eventBus.dispatchEvent(new CustomEvent('clearAssetChart'));
        }
    }
  }

  filterPurchases(purchases, searchQuery) {
    const q = searchQuery.toLowerCase();
    return purchases.filter(p => {
      // Filtre par recherche
      const matchesSearch = p.ticker.toLowerCase().includes(q) || 
                           p.name.toLowerCase().includes(q) || 
                           p.date.includes(q);
      
      // Filtre par ticker
      const matchesTicker = this.selectedTickers.size === 0 || 
                           this.selectedTickers.has(p.ticker.toUpperCase());
      
      // Filtre par type d'actif
      const matchesAssetType = !this.selectedAssetType || 
                               (p.assetType || 'Stock') === this.selectedAssetType;
      
      // Filtre par broker
      const matchesBroker = !this.selectedBroker || 
                           (p.broker || 'Unknown') === this.selectedBroker;
      
      return matchesSearch && matchesTicker && matchesAssetType && matchesBroker;
    });
  }

  getSelectedTickers() {
    return this.selectedTickers;
  }

  // Obtenir les achats filtrés
  getFilteredPurchases(searchQuery = '') {
    return this.filterPurchases(this.storage.getPurchases(), searchQuery);
  }

  clearSelectedTicker() {
    this.selectedTickers.clear();
    if (this.onFilterChangeCallback) {
      this.updateTickerFilter(this.onFilterChangeCallback);
    }
  }
}