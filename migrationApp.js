// ========================================
// migrationApp.js - Migration et Modification en Masse
// ========================================

import { Storage } from './storage.js';
import { BROKERS, ASSET_TYPES, CURRENCIES } from './config.js';

class MigrationApp {
    constructor() {
        this.storage = new Storage();
        this.selectedAssets = new Map(); // ticker -> { purchases, config }
        this.currentFilter = 'all';
        this.searchQuery = '';
    }

    async init() {
        console.log('🔄 Initialisation Migration...');
        
        this.render();
        this.setupEventListeners();
        
        console.log('✅ Migration prêt');
    }

    render() {
        const purchases = this.storage.getPurchases();
        
        if (purchases.length === 0) {
            document.getElementById('assets-grid').style.display = 'none';
            document.getElementById('empty-state').style.display = 'block';
            return;
        }

        document.getElementById('assets-grid').style.display = 'grid';
        document.getElementById('empty-state').style.display = 'none';

        // Agréger par ticker
        const assetsMap = this.aggregateByAsset(purchases);
        
        // Filtrer
        let filtered = this.filterAssets(assetsMap);

        // Afficher le nombre total
        document.getElementById('total-assets').textContent = filtered.length;
        
        // Rendre les cartes
        this.renderAssetCards(filtered);
        
        // Mettre à jour le compteur de sélection
        this.updateSelectionCount();
        
        // Mettre à jour les actions de migration
        this.updateMigrationActions();
    }

    aggregateByAsset(purchases) {
        const map = new Map();

        purchases.forEach(p => {
            const ticker = p.ticker.toUpperCase();
            if (!map.has(ticker)) {
                map.set(ticker, {
                    ticker,
                    name: p.name,
                    assetType: p.assetType || 'Stock',
                    broker: p.broker || 'RV-CT',
                    currency: p.currency || 'EUR',
                    totalQty: 0,
                    totalInvested: 0,
                    purchaseCount: 0,
                    purchases: []
                });
            }

            const asset = map.get(ticker);
            asset.totalQty += p.quantity;
            asset.totalInvested += p.price * p.quantity;
            asset.purchaseCount++;
            asset.purchases.push(p);
        });

        return Array.from(map.values());
    }

    filterAssets(assets) {
        return assets.filter(asset => {
            // Filtre par type
            if (this.currentFilter === 'crypto' && asset.assetType !== 'Crypto') return false;
            if (this.currentFilter === 'stocks' && !['Stock', 'ETF'].includes(asset.assetType)) return false;

            // Filtre par recherche
            if (this.searchQuery) {
                const query = this.searchQuery.toLowerCase();
                return asset.ticker.toLowerCase().includes(query) || 
                       asset.name.toLowerCase().includes(query);
            }

            return true;
        });
    }

    renderAssetCards(assets) {
        const grid = document.getElementById('assets-grid');
        
        grid.innerHTML = assets.map(asset => {
            const isSelected = this.selectedAssets.has(asset.ticker);
            const config = this.selectedAssets.get(asset.ticker) || {
                broker: asset.broker,
                assetType: asset.assetType,
                currency: asset.currency
            };

            return `
                <div class="asset-card ${isSelected ? 'selected' : ''}" data-ticker="${asset.ticker}">
                    <div class="asset-card-header">
                        <div>
                            <div class="asset-ticker">${asset.ticker}</div>
                            <div class="asset-name">${asset.name}</div>
                        </div>
                        <input type="checkbox" 
                               class="asset-checkbox" 
                               data-ticker="${asset.ticker}" 
                               ${isSelected ? 'checked' : ''}>
                    </div>

                    <div class="asset-stats">
                        <div>
                            <div class="asset-stat-label">Quantité</div>
                            <div class="asset-stat-value">${asset.totalQty.toFixed(4)}</div>
                        </div>
                        <div>
                            <div class="asset-stat-label">Transactions</div>
                            <div class="asset-stat-value">${asset.purchaseCount}</div>
                        </div>
                        <div>
                            <div class="asset-stat-label">Investi</div>
                            <div class="asset-stat-value">${asset.totalInvested.toFixed(2)} €</div>
                        </div>
                        <div>
                            <div class="asset-stat-label">Actuel</div>
                            <div class="asset-stat-value">
                                <span class="asset-type-badge asset-type-${asset.assetType.toLowerCase()}">${asset.assetType}</span>
                            </div>
                        </div>
                    </div>

                    ${isSelected ? `
                        <div class="platform-selector">
                            <div class="platform-label">
                                <i class="fas fa-cog"></i>
                                Configuration de migration
                            </div>
                            <div class="platform-inputs">
                                <div class="platform-input-group">
                                    <label>
                                        <i class="fas fa-building"></i>
                                        Broker
                                    </label>
                                    <select class="config-broker" data-ticker="${asset.ticker}">
                                        ${BROKERS.map(b => `
                                            <option value="${b.value}" ${config.broker === b.value ? 'selected' : ''}>
                                                ${b.label}
                                            </option>
                                        `).join('')}
                                    </select>
                                </div>
                                <div class="platform-input-group">
                                    <label>
                                        <i class="fas fa-chart-line"></i>
                                        Type
                                    </label>
                                    <select class="config-assettype" data-ticker="${asset.ticker}">
                                        ${ASSET_TYPES.map(type => `
                                            <option value="${type}" ${config.assetType === type ? 'selected' : ''}>
                                                ${type}
                                            </option>
                                        `).join('')}
                                    </select>
                                </div>
                                <div class="platform-input-group">
                                    <label>
                                        <i class="fas fa-dollar-sign"></i>
                                        Devise
                                    </label>
                                    <select class="config-currency" data-ticker="${asset.ticker}">
                                        ${CURRENCIES.map(curr => `
                                            <option value="${curr.value}" ${config.currency === curr.value ? 'selected' : ''}>
                                                ${curr.label}
                                            </option>
                                        `).join('')}
                                    </select>
                                </div>
                            </div>
                        </div>
                    ` : ''}
                </div>
            `;
        }).join('');

        this.attachCardListeners();
    }

    attachCardListeners() {
        // Checkboxes
        document.querySelectorAll('.asset-checkbox').forEach(cb => {
            cb.addEventListener('change', (e) => {
                e.stopPropagation();
                const ticker = cb.dataset.ticker;
                this.toggleAssetSelection(ticker);
            });
        });

        // Cartes cliquables
        document.querySelectorAll('.asset-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // Ne pas déclencher si on clique sur un select ou checkbox
                if (e.target.tagName === 'SELECT' || 
                    e.target.tagName === 'INPUT' ||
                    e.target.closest('.platform-selector')) {
                    return;
                }
                
                const ticker = card.dataset.ticker;
                const checkbox = card.querySelector('.asset-checkbox');
                checkbox.checked = !checkbox.checked;
                this.toggleAssetSelection(ticker);
            });
        });

        // Selects de configuration
        document.querySelectorAll('.config-broker, .config-assettype, .config-currency').forEach(select => {
            select.addEventListener('change', (e) => {
                e.stopPropagation();
                const ticker = select.dataset.ticker;
                this.updateAssetConfig(ticker);
            });
        });
    }

    toggleAssetSelection(ticker) {
        const purchases = this.storage.getPurchases();
        const assetPurchases = purchases.filter(p => p.ticker.toUpperCase() === ticker);
        
        if (this.selectedAssets.has(ticker)) {
            this.selectedAssets.delete(ticker);
        } else {
            const firstPurchase = assetPurchases[0];
            this.selectedAssets.set(ticker, {
                purchases: assetPurchases,
                broker: firstPurchase.broker || 'RV-CT',
                assetType: firstPurchase.assetType || 'Stock',
                currency: firstPurchase.currency || 'EUR'
            });
        }

        this.render();
    }

    updateAssetConfig(ticker) {
        if (!this.selectedAssets.has(ticker)) return;

        const config = this.selectedAssets.get(ticker);
        
        const brokerSelect = document.querySelector(`.config-broker[data-ticker="${ticker}"]`);
        const assetTypeSelect = document.querySelector(`.config-assettype[data-ticker="${ticker}"]`);
        const currencySelect = document.querySelector(`.config-currency[data-ticker="${ticker}"]`);

        if (brokerSelect) config.broker = brokerSelect.value;
        if (assetTypeSelect) config.assetType = assetTypeSelect.value;
        if (currencySelect) config.currency = currencySelect.value;

        this.selectedAssets.set(ticker, config);
        this.updateMigrationActions();
    }

    updateSelectionCount() {
        const count = this.selectedAssets.size;
        document.getElementById('selection-count').textContent = `${count} sélectionné${count > 1 ? 's' : ''}`;
    }

    updateMigrationActions() {
        const actionsDiv = document.getElementById('migration-actions');
        const countEl = document.getElementById('migrate-count');
        
        if (this.selectedAssets.size > 0) {
            actionsDiv.style.display = 'flex';
            countEl.textContent = `${this.selectedAssets.size} actif${this.selectedAssets.size > 1 ? 's' : ''}`;
        } else {
            actionsDiv.style.display = 'none';
        }
    }

    setupEventListeners() {
        // Recherche
        const searchInput = document.getElementById('search-assets');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                this.render();
            });
        }

        // Filtres
        document.getElementById('show-all')?.addEventListener('click', () => {
            this.currentFilter = 'all';
            this.updateFilterButtons();
            this.render();
        });

        document.getElementById('show-crypto')?.addEventListener('click', () => {
            this.currentFilter = 'crypto';
            this.updateFilterButtons();
            this.render();
        });

        document.getElementById('show-stocks')?.addEventListener('click', () => {
            this.currentFilter = 'stocks';
            this.updateFilterButtons();
            this.render();
        });

        // Sélection
        document.getElementById('select-all-btn')?.addEventListener('click', () => {
            this.selectAll();
        });

        document.getElementById('deselect-all-btn')?.addEventListener('click', () => {
            this.deselectAll();
        });

        // Migration
        document.getElementById('start-migration')?.addEventListener('click', () => {
            this.startMigration();
        });

        document.getElementById('cancel-migration')?.addEventListener('click', () => {
            this.deselectAll();
        });
    }

    updateFilterButtons() {
        document.querySelectorAll('.filter-bar button').forEach(btn => {
            btn.classList.remove('active');
        });

        const activeBtn = {
            'all': 'show-all',
            'crypto': 'show-crypto',
            'stocks': 'show-stocks'
        }[this.currentFilter];

        document.getElementById(activeBtn)?.classList.add('active');
    }

    selectAll() {
        const purchases = this.storage.getPurchases();
        const assets = this.aggregateByAsset(purchases);
        const filtered = this.filterAssets(assets);

        filtered.forEach(asset => {
            if (!this.selectedAssets.has(asset.ticker)) {
                this.selectedAssets.set(asset.ticker, {
                    purchases: asset.purchases,
                    broker: asset.broker,
                    assetType: asset.assetType,
                    currency: asset.currency
                });
            }
        });

        this.render();
    }

    deselectAll() {
        this.selectedAssets.clear();
        this.render();
    }

    startMigration() {
        if (this.selectedAssets.size === 0) return;

        const totalTransactions = Array.from(this.selectedAssets.values())
            .reduce((sum, asset) => sum + asset.purchases.length, 0);

        if (!confirm(`Migrer ${this.selectedAssets.size} actif(s) (${totalTransactions} transaction(s)) ?`)) {
            return;
        }

        let updated = 0;

        this.selectedAssets.forEach((config, ticker) => {
            config.purchases.forEach(purchase => {
                const key = this.storage.getRowKey(purchase);
                this.storage.updatePurchase(key, {
                    broker: config.broker,
                    assetType: config.assetType,
                    currency: config.currency
                });
                updated++;
            });
        });

        this.showNotification(`✅ ${updated} transaction(s) migrée(s) avec succès`, 'success');
        
        this.selectedAssets.clear();
        this.render();

        // Rediriger vers la page principale après un délai
        setTimeout(() => {
            window.location.href = 'index.html';
        }, 2000);
    }

    showNotification(message, type = 'info') {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
            color: white;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            z-index: 10000;
            font-weight: 600;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transition = 'opacity 0.3s';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }
}

// Initialisation
(async () => {
    const app = new MigrationApp();
    window.migrationApp = app;
    
    try {
        await app.init();
    } catch (error) {
        console.error('❌ Erreur fatale:', error);
        alert('Erreur lors du chargement de la migration');
    }
})();
