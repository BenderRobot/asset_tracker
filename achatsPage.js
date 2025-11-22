// ========================================
// achatsPage.js - (v8 - Avec Gestion des Onglets)
// ========================================
import { PAGE_SIZE, BROKERS } from './config.js';
import { formatCurrency, formatPercent, formatDate, formatQuantity } from './utils.js';

export class AchatsPage {
  constructor(storage, api, ui, filterManager, dataManager) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.currentPage = 1;
    this.sortColumn = 'date';
    this.sortDirection = 'desc';
    this.selectedRows = new Set();
    this.openBubble = null;
    this.closeHandler = null;
    this.currentEditKey = null;
    this.submitHandler = null;
  }

  async render(searchQuery = '') {
    const tbody = document.querySelector('#purchases-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;padding:20px;">Chargement...</td></tr>';

    // 1. Obtenir toutes les transactions filtrées
    let filtered = this.filterManager.filterPurchases(this.storage.getPurchases(), searchQuery);

    // 2. Séparer les actifs du cash
    const assetPurchases = filtered.filter(p => p.assetType !== 'Cash');
    const cashMovements = filtered.filter(p => p.assetType === 'Cash');

    // 3. Rafraîchir les prix UNIQUEMENT pour les actifs
    const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];
    await this.api.fetchBatchPrices(tickers, true);

    // 4. Enrichir les deux listes séparément
    const enrichedAssets = this.dataManager.calculateEnrichedPurchases(assetPurchases);
    const enrichedCash = this.dataManager.calculateEnrichedPurchases(cashMovements);

    // 5. Combiner pour l'affichage
    const allEnriched = [...enrichedAssets, ...enrichedCash];

    allEnriched.sort((a, b) => {
      const valA = a[this.sortColumn] ?? -Infinity;
      const valB = b[this.sortColumn] ?? -Infinity;
      
      let order;
      if (typeof valA === 'string' && typeof valB === 'string') {
        order = valA.localeCompare(valB);
      } else {
        order = valA < valB ? -1 : valA > valB ? 1 : 0;
      }
      
      return order * (this.sortDirection === 'asc' ? 1 : -1);
    });

    const totalPages = Math.max(1, Math.ceil(allEnriched.length / PAGE_SIZE));
    if (this.currentPage > totalPages) this.currentPage = totalPages;
    const pageItems = allEnriched.slice((this.currentPage - 1) * PAGE_SIZE, this.currentPage * PAGE_SIZE);

    tbody.innerHTML = pageItems.map(p => {
      const key = this.storage.getRowKey(p);
      
      const currencyBadge = p.currency === 'USD' 
        ? '<span class="currency-badge currency-usd">USD</span>'
        : '<span class="currency-badge currency-eur">EUR</span>';
      
      const assetTypeBadge = `<span class="asset-type-badge asset-type-${p.assetType.toLowerCase().replace(/\s/g, '-')}">${p.assetType}</span>`;
      const brokerBadge = `<span class="broker-badge">${p.broker}</span>`;
      
      // Affichage du cash
      if (p.assetType === 'Cash') {
        const cashColor = p.price > 0 ? 'positive' : 'negative';
        return `
          <tr data-row-key="${key}" style="opacity: 0.8; background: var(--bg-secondary);">
            <td><input type="checkbox" class="row-select" data-key="${key}"></td>
            <td>${assetTypeBadge}</td>
            <td>${brokerBadge}</td>
            <td>${formatDate(p.date)}</td>
            <td><strong>${p.ticker}</strong></td>
            <td>${p.name}</td>
            <td>${currencyBadge}</td>
            <td>-</td> <td>-</td> <td class="${cashColor}">${formatCurrency(p.gainEUR, 'EUR')}</td> <td>-</td> <td class="${cashColor}">${formatCurrency(p.buyPriceOriginal, 'EUR')}</td> <td>-</td> <td>-</td> <td class="action-cell">
              <div class="action-trigger" data-key="${key}">...</div>
            </td>
          </tr>
        `;
      }

      // Affichage normal pour les actifs
      return `
        <tr data-row-key="${key}">
          <td><input type="checkbox" class="row-select" data-key="${key}"></td>
          <td>${assetTypeBadge}</td>
          <td>${brokerBadge}</td>
          <td>${formatDate(p.date)}</td>
          <td><strong>${p.ticker}</strong></td>
          <td>${p.name}</td>
          <td>${currencyBadge}</td>
          <td>${formatCurrency(p.currentPriceOriginal, p.currency)}</td>
          <td>${formatQuantity(p.quantity)}</td>
          <td class="${p.gainEUR > 0 ? 'positive' : p.gainEUR < 0 ? 'negative' : ''}">
            ${formatCurrency(p.gainEUR, 'EUR')}
          </td>
          <td class="${p.gainEUR > 0 ? 'positive' : p.gainEUR < 0 ? 'negative' : ''}">
            ${formatPercent(p.gainPct)}
          </td>
          <td>${formatCurrency(p.buyPriceOriginal, p.currency)}</td>
          <td>${formatCurrency(p.investedEUR, 'EUR')}</td>
          <td>${formatCurrency(p.currentValueEUR, 'EUR')}</td>
          <td class="action-cell">
            <div class="action-trigger" data-key="${key}">
              <i class="fas fa-ellipsis-v"></i>
            </div>
            <div class="action-bubble" id="bubble-${key}">
              <button class="bubble-btn edit-btn" data-action="edit" data-key="${key}" title="Modifier">
                <i class="fas fa-edit"></i>
              </button>
              <button class="bubble-btn delete-btn" data-action="delete" data-key="${key}" title="Supprimer">
                <i class="fas fa-trash-alt"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('') || '<tr><td colspan="16">Aucune transaction.</td></tr>';

    // 6. Calculer le résumé et le cash
    const holdings = this.dataManager.calculateHoldings(assetPurchases);
    const summary = this.dataManager.calculateSummary(holdings);
    const globalCashReserve = this.dataManager.calculateCashReserve(this.storage.getPurchases());
    
    // 7. Mettre à jour l'UI
    this.ui.updatePortfolioSummary(summary, allEnriched.length, globalCashReserve.total); 
    
    this.ui.renderPagination(this.currentPage, totalPages, (newPage) => {
      this.currentPage = newPage;
      this.render(searchQuery);
    });

    this.attachEventListeners();
  }
  
  attachEventListeners() {
    const table = document.getElementById('purchases-table');
    if (!table) return;

    table.querySelectorAll('.row-select').forEach(cb => {
      cb.onclick = null;
      cb.addEventListener('change', () => {
        const key = cb.dataset.key;
        if (cb.checked) this.selectedRows.add(key);
        else this.selectedRows.delete(key);
        this.ui.updateBulkActions(this.selectedRows.size);
        this.updateSelectAllHeader();
      });
    });

    table.querySelectorAll('.action-trigger').forEach(btn => {
      btn.onclick = null;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.key;
        
        const purchase = this.storage.getPurchaseByKey(key);
        if (purchase && purchase.assetType === 'Cash') {
            if (confirm('Supprimer ce mouvement de cash ?')) {
                 this.storage.removePurchase(key);
                 this.selectedRows.delete(key);
                 this.render();
                 this.filterManager.updateTickerFilter(() => this.render());
            }
            return;
        }

        const bubble = document.getElementById(`bubble-${key}`);
        if (this.openBubble && this.openBubble !== bubble) {
          this.openBubble.classList.remove('show');
        }
        bubble.classList.toggle('show');
        this.openBubble = bubble.classList.contains('show') ? bubble : null;
      });
    });

    table.querySelectorAll('.bubble-btn').forEach(btn => {
      btn.onclick = null;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.key;
        const action = btn.dataset.action;
        const bubble = btn.closest('.action-bubble');
        bubble.classList.remove('show');
        this.openBubble = null;

        if (action === 'delete') {
          if (confirm('Supprimer cette transaction ?')) {
            this.storage.removePurchase(key);
            this.selectedRows.delete(key);
            this.render();
            this.filterManager.updateTickerFilter(() => this.render());
          }
        } else if (action === 'edit') {
          this.openEditModal(key);
        }
      });
    });

    const closeBubbles = (e) => {
      if (this.openBubble && !this.openBubble.contains(e.target) && !e.target.closest('.action-trigger')) {
        this.openBubble.classList.remove('show');
        this.openBubble = null;
      }
    };
    document.removeEventListener('click', this.closeHandler);
    this.closeHandler = closeBubbles;
    document.addEventListener('click', this.closeHandler);

    this.setupModalHandlers();
  }

  setupModalHandlers() {
    const closeBtn = document.getElementById('close-modal');
    const cancelBtn = document.getElementById('cancel-edit');
    const modal = document.getElementById('edit-modal');

    if (closeBtn) {
      closeBtn.onclick = null;
      closeBtn.onclick = () => this.closeEditModal();
    }
    
    if (cancelBtn) {
      cancelBtn.onclick = null;
      cancelBtn.onclick = () => this.closeEditModal();
    }
    
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) this.closeEditModal();
      };
    }
  }

  openEditModal(key) {
    const purchase = this.storage.getPurchaseByKey(key);
    if (!purchase) {
      alert('Transaction introuvable.');
      return;
    }

    const brokerSelect = document.getElementById('edit-broker');
    if (brokerSelect) {
      brokerSelect.innerHTML = BROKERS.map(broker => 
        `<option value="${broker.value}">${broker.label}</option>`
      ).join('');
    }

    const fields = {
      'edit-ticker': purchase.ticker,
      'edit-name': purchase.name,
      'edit-price': purchase.price,
      'edit-quantity': purchase.quantity,
      'edit-date': purchase.date,
      'edit-asset-type': purchase.assetType || 'Stock',
      'edit-broker': purchase.broker || 'RV-CT',
      'edit-currency': purchase.currency || 'EUR'
    };

    Object.entries(fields).forEach(([id, value]) => {
      const el = document.getElementById(id);
      if (el) el.value = value;
    });

    this.currentEditKey = key;

    const modal = document.getElementById('edit-modal');
    modal.style.display = 'flex';
    setTimeout(() => modal.classList.add('show'), 10);

    const form = document.getElementById('edit-form');
    const submitHandler = (e) => {
      e.preventDefault();
      this.saveEdit();
    };
    form.removeEventListener('submit', this.submitHandler);
    this.submitHandler = submitHandler;
    form.addEventListener('submit', this.submitHandler);
  }

  saveEdit() {
    const key = this.currentEditKey;
    
    const updates = {
      ticker: document.getElementById('edit-ticker').value.toUpperCase().trim(),
      name: document.getElementById('edit-name').value.trim(),
      price: parseFloat(document.getElementById('edit-price').value),
      quantity: parseFloat(document.getElementById('edit-quantity').value),
      date: document.getElementById('edit-date').value,
      assetType: document.getElementById('edit-asset-type').value,
      broker: document.getElementById('edit-broker').value,
      currency: document.getElementById('edit-currency').value
    };

    if (!updates.ticker || !updates.name || !updates.price || 
        !updates.quantity || !updates.date || !updates.assetType || 
        !updates.broker || !updates.currency) {
      alert('Tous les champs sont requis.');
      return;
    }

    if (updates.price <= 0 || updates.quantity <= 0) {
	  alert('Le prix et la quantité doivent être positifs.');
	  return;
	}

	this.storage.updatePurchase(key, updates);
	this.closeEditModal();
	this.render();
	this.filterManager.updateTickerFilter(() => this.render());

	this.showNotification('Transaction modifiée avec succès', 'success');
  }

  closeEditModal() {
    const modal = document.getElementById('edit-modal');
    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);
  }

  updateSelectAllHeader() {
    const header = document.getElementById('select-all-header');
    if (!header) return;
    const all = document.querySelectorAll('.row-select');
    const checked = Array.from(all).filter(cb => cb.checked).length;
    header.checked = checked === all.length && all.length > 0;
    header.indeterminate = checked > 0 && checked < all.length;
  }

  // === NOUVELLE MÉTHODE : GESTION DES ONGLETS ===
  setupTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    if (!tabBtns.length) return;

    // Gestion du clic sur les onglets
    tabBtns.forEach(btn => {
      // Pour éviter les doublons d'écouteurs si appelé plusieurs fois, on utilise onclick ou on clone
      // Ici, une approche simple suffit si setupTabs n'est appelé qu'une fois au chargement
      btn.addEventListener('click', (e) => {
        e.preventDefault(); // Empêcher tout comportement par défaut

        // 1. Désactiver tous les boutons et contenus
        tabBtns.forEach(b => b.classList.remove('active'));
        tabContents.forEach(c => c.classList.remove('active'));

        // 2. Activer le bouton cliqué
        btn.classList.add('active');
        
        // 3. Activer le contenu correspondant
        const tabName = btn.dataset.tab; // Récupère "asset", "cash" ou "data"
        const content = document.getElementById(`tab-${tabName}`);
        if (content) content.classList.add('active');
      });
    });
    
    // Initialisation des dates par défaut (Aujourd'hui)
    const today = new Date().toISOString().split('T')[0];
    const dateAsset = document.getElementById('date');
    const dateCash = document.getElementById('cash-date');
    
    if (dateAsset && !dateAsset.value) dateAsset.value = today;
    if (dateCash && !dateCash.value) dateCash.value = today;
  }

  setupSorting() {
    const headers = document.querySelectorAll('#purchases-table th[data-sort]');
    headers.forEach(th => {
      th.style.cursor = 'pointer';
      th.onclick = null;
      th.addEventListener('click', () => {
        const col = th.dataset.sort;
        if (this.sortColumn === col) {
          this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col;
          this.sortDirection = 'asc';
        }
        
        document.querySelectorAll('#purchases-table th[data-sort]').forEach(header => {
          header.classList.remove('sort-asc', 'sort-desc');
        });
        th.classList.add(`sort-${this.sortDirection}`);
        
        this.currentPage = 1;
        this.render();
      });
    });
  }

  deleteSelected() {
    if (this.selectedRows.size === 0) return;
    
    if (confirm(`Supprimer ${this.selectedRows.size} transaction(s) ?`)) {
      this.storage.removePurchases(this.selectedRows);
      this.selectedRows.clear();
      this.render();
      this.filterManager.updateTickerFilter(() => this.render());
      this.showNotification('Transactions supprimées', 'success');
    }
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