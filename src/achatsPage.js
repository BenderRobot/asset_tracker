// achatsPage.js - (v8 - Avec Gestion des Onglets, MODIFIÉ pour chargement NON-BLOQUANT)
// ========================================
console.log('📌 AchatsPage v7 Loaded - Row Click Handler Ready');
import { PAGE_SIZE } from './config.js';
import { getBrokers, getBrokersSync, fillSelect, attachAddBrokerHandler } from './brokerService.js';
import { formatCurrency, formatPercent, formatDate, formatQuantity } from './utils.js';
import { DividendManager } from './dividendManager.js';

export class AchatsPage {
  constructor(storage, api, ui, filterManager, dataManager) {
    this.storage = storage;
    this.api = api;
    this.ui = ui;
    this.filterManager = filterManager;
    this.dataManager = dataManager;
    this.dividendManager = new DividendManager(storage, dataManager); // Initialize Manager
    this.currentPage = 1;
    this.sortColumn = 'date';
    this.sortDirection = 'desc';
    this.selectedRows = new Set();
    this.openBubble = null;
    this.closeHandler = null;
    this.currentEditKey = null;
    this.submitHandler = null;
  }

  async render(searchQuery = '', fetchPrices = false) {
    const tbody = document.querySelector('#purchases-table tbody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="16" style="text-align:center;padding:20px;">Loading...</td></tr>';

    // 1. Obtenir toutes les transactions filtrées
    let filtered = this.filterManager.filterPurchases(this.storage.getPurchases(), searchQuery);

    // 2. Séparer les actifs du cash
    const assetPurchases = filtered.filter(p => p.assetType !== 'Cash');
    const cashMovements = filtered.filter(p => p.assetType === 'Cash');

    // 3. Rafraîchir les prix UNIQUEMENT pour les actifs (L'APP.JS S'EN CHARGE MAINTENANT EN FOND)
    // const tickers = [...new Set(assetPurchases.map(p => p.ticker.toUpperCase()))];
    // await this.api.fetchBatchPrices(tickers, true); // <--- LIGNE SUPPRIMÉE

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

    const bubble = document.getElementById('add-hint-bubble');
    if (allEnriched.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="15" style="padding: 48px 20px; text-align: center; color: var(--text-muted);">
            <div style="font-size: 36px; margin-bottom: 12px; opacity: 0.5;">📋</div>
            <div style="font-size: 15px; color: var(--text-secondary);">
              Aucune transaction — utilisez le bouton <strong style="color: var(--text-primary);">Add</strong> ci-dessus pour commencer.
            </div>
          </td>
        </tr>`;
      if (bubble) bubble.style.display = 'block';
      this.ui.renderPagination(1, 1, () => {});
      return;
    }

    if (bubble) bubble.style.display = 'none';

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

      // Affichage des Dividendes
      if (p.type === 'dividend') {
        return `
          <tr data-row-key="${key}" style="background: rgba(39, 174, 96, 0.1);">
            <td><input type="checkbox" class="row-select" data-key="${key}"></td>
            <td><span class="asset-type-badge" style="background:#27ae60;">💰 Div</span></td>
            <td>${brokerBadge}</td>
            <td>${formatDate(p.date)}</td>
            <td><strong>${p.ticker}</strong></td>
            <td>${p.name}</td>
            <td>${currencyBadge}</td>
            <td>-</td> 
            <td>-</td> 
            <td class="positive">+${formatCurrency(p.amount || p.price, p.currency)}</td> 
            <td>-</td> 
            <td>-</td> 
            <td>-</td> 
            <td>-</td> 
            <td class="action-cell">
              <div class="action-trigger" data-key="${key}"><i class="fas fa-ellipsis-v"></i></div>
              <div class="action-bubble" id="bubble-${key}">
                  <button class="bubble-btn edit-btn" data-action="edit" data-key="${key}" title="Modifier"><i class="fas fa-edit"></i></button>
                  <button class="bubble-btn delete-btn" data-action="delete" data-key="${key}" title="Supprimer"><i class="fas fa-trash-alt"></i></button>
              </div>
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

  updateSelectAllHeader() {
    const selectAll = document.querySelector('#select-all-rows');
    const table = document.getElementById('purchases-table');
    if (!selectAll || !table) return;

    const allCheckboxes = Array.from(table.querySelectorAll('.row-select'));
    if (allCheckboxes.length === 0) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      return;
    }

    const allChecked = allCheckboxes.every(cb => cb.checked);
    const someChecked = allCheckboxes.some(cb => cb.checked);

    selectAll.checked = allChecked;
    selectAll.indeterminate = someChecked && !allChecked;
  }

  attachEventListeners() {
    const table = document.getElementById('purchases-table');
    if (!table) return;

    // Use event delegation on the table body/container
    // Remove old listener if exists to avoid duplication
    if (this._tableClickHandler) {
      table.removeEventListener('click', this._tableClickHandler);
    }
    if (this._tableChangeHandler) {
      table.removeEventListener('change', this._tableChangeHandler);
    }

    this._tableChangeHandler = (e) => {
      const target = e.target;
      if (target.classList.contains('row-select')) {
        const key = target.dataset.key;
        if (target.checked) this.selectedRows.add(key);
        else this.selectedRows.delete(key);
        this.ui.updateBulkActions(this.selectedRows.size);
        this.updateSelectAllHeader();
      }
    };

    this._tableClickHandler = (e) => {
      // 1. Action Trigger (...)
      const trigger = e.target.closest('.action-trigger');
      if (trigger) {
        e.preventDefault();
        e.stopPropagation();
        const key = trigger.dataset.key;
        const bubble = document.getElementById(`bubble-${key}`);

        // Close other bubbles
        if (this.openBubble && this.openBubble !== bubble) {
          this.openBubble.classList.remove('show');
        }

        if (bubble) {
          bubble.classList.toggle('show');
          this.openBubble = bubble.classList.contains('show') ? bubble : null;
        }
        return;
      }

      // 2. Bubble Buttons (Edit/Delete)
      const btn = e.target.closest('.bubble-btn');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset.key;
        const action = btn.dataset.action;
        const bubble = btn.closest('.action-bubble');
        if (bubble) bubble.classList.remove('show');
        this.openBubble = null;

        if (action === 'delete') {
          if (confirm('Confirmer la suppression ?')) {
            this.storage.removePurchase(key);
            this.selectedRows.delete(key);
            this.render(this.lastSearchQuery);
            this.filterManager.updateTickerFilter(() => this.render());
            this.ui.showNotification('Transaction supprimée', 'success');
          }
        } else if (action === 'edit') {
          console.log('✏️ Edit button clicked (delegated) for key:', key);
          this.openEditModal(key);
        }
        return;
      }
    };

    table.addEventListener('change', this._tableChangeHandler);
    table.addEventListener('click', this._tableClickHandler);

    // Close bubbles on click outside
    if (!this.closeHandler) {
      this.closeHandler = (e) => {
        if (this.openBubble && !e.target.closest('.action-cell')) {
          this.openBubble.classList.remove('show');
          this.openBubble = null;
        }
      };
      document.addEventListener('click', this.closeHandler);
    }
  }

  // === DIVIDEND HANDLING ===

  setupHeaderListeners() {
    const scanBtn = document.getElementById('scan-dividends-btn');
    if (scanBtn) {
      scanBtn.addEventListener('click', () => this.handleScanDividends());
    }

    // --- Bulk Action Listeners (FIX) ---
    const selectAllBtn = document.getElementById('select-all-btn');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', () => {
        const allCheckboxes = document.querySelectorAll('.row-select');
        const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);

        allCheckboxes.forEach(cb => {
          cb.checked = !allChecked;
          const key = cb.dataset.key;
          if (cb.checked) this.selectedRows.add(key);
          else this.selectedRows.delete(key);
        });

        this.updateSelectAllHeader();
        this.ui.updateBulkActions(this.selectedRows.size);
      });
    }

    const deleteSelectedBtn = document.getElementById('delete-selected');
    if (deleteSelectedBtn) {
      deleteSelectedBtn.addEventListener('click', () => this.deleteSelected());
    }

    // Tab Switching Logic for Modal (Asset/Cash/Dividend)
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        // Remove active class from all tabs & contents
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

        // Activate clicked tab
        e.currentTarget.classList.add('active');
        const targetId = 'tab-' + e.currentTarget.dataset.tab;
        document.getElementById(targetId)?.classList.add('active');

        // Populate Dividend Dropdowns on Tab Click
        if (e.currentTarget.dataset.tab === 'dividend') {
          const tickerSelect = document.getElementById('div-ticker-select');
          const brokerSelect = document.getElementById('div-broker');

          if (tickerSelect && tickerSelect.options.length <= 1) {
            const purchases = this.storage.getPurchases();
            // Unique assets
            const assets = [...new Set(purchases.filter(p => p.assetType !== 'Cash').map(p => p.ticker))];
            tickerSelect.innerHTML = '<option value="">Choisir l\'actif...</option>' +
              assets.map(t => `<option value="${t}">${t}</option>`).join('');
          }

          if (brokerSelect && brokerSelect.options.length <= 1) {
            const divOpts = { includeEmpty: 'Courtier...', includeAdd: true };
            getBrokers().then(brokers => {
              fillSelect(brokerSelect, brokers, divOpts);
              attachAddBrokerHandler(brokerSelect, [{ el: brokerSelect, opts: divOpts }]);
            });
          }
        }
      });
    });

    // Manual Dividend Form Submit
    const divForm = document.getElementById('dividend-form');
    if (divForm) {
      divForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        await this.handleManualDividend();
      });
    }

    // --- Modal Close Listeners (FIX) ---
    const closeBtn = document.getElementById('close-modal');
    const cancelBtn = document.getElementById('cancel-edit');
    const modal = document.getElementById('edit-modal');

    const closeHandler = (e) => {
      e.preventDefault();
      this.closeEditModal();
    };

    if (closeBtn) closeBtn.addEventListener('click', closeHandler);
    if (cancelBtn) cancelBtn.addEventListener('click', closeHandler);

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) this.closeEditModal();
      });
    }
  }

  async handleScanDividends() {
    const scanModal = document.getElementById('scan-loading-modal');
    if (scanModal) {
      scanModal.style.display = 'flex';
      requestAnimationFrame(() => scanModal.classList.add('show'));
    }

    try {
      const suggestions = await this.dividendManager.scanForMissingDividends();
      if (scanModal) {
        scanModal.classList.remove('show');
        await new Promise(r => setTimeout(r, 280));
        scanModal.style.display = 'none';
      }
      this.renderDividendModal(suggestions);
    } catch (e) {
      console.error('❌ Scan Error:', e);
      if (scanModal) {
        scanModal.classList.remove('show');
        setTimeout(() => { scanModal.style.display = 'none'; }, 280);
      }
      alert('Erreur lors du scan : ' + e.message);
    }
  }

  renderDividendModal(suggestions) {
    const list = document.getElementById('dividend-list');
    const modal = document.getElementById('dividend-modal');
    if (!list || !modal) return;

    // Sort by Date Descending (Newest first)
    suggestions.sort((a, b) => new Date(b.date) - new Date(a.date));

    console.log('💰 Dividend Suggestions for Modal:', suggestions);

    if (suggestions.length === 0) {
      list.innerHTML = '<div style="text-align:center; padding: 20px;">Aucun nouveau dividende manquant détecté.</div>';
    } else {
      list.innerHTML = this.renderDividendRows(suggestions);
    }

    this.currentSuggestions = suggestions;

    // Fix Visibility: Set display to flex AND add 'show' class for opacity transition
    modal.style.display = 'flex';
    requestAnimationFrame(() => modal.classList.add('show'));

    // --- Helper for Recalculation ---
    const recalculateRow = (index) => {
      const row = document.querySelector(`.div-row-${index}`);
      if (!row) return;

      const suggestion = this.currentSuggestions[index];
      const taxSelect = row.querySelector('.div-tax-select');
      const usdCheck = row.querySelector('.div-usd-check');
      const netInput = row.querySelector('.div-net-input');

      let taxRate = parseFloat(taxSelect.value);
      let forceUSD = usdCheck ? usdCheck.checked : false;

      // Base is always the Raw amount from Yahoo (which might be USD for US stocks)
      // If 'originalAmount' exists, it means we ALREADY converted it. 
      // If we want to support "Force USD", we should rely on the Source Amount (grossAmount if unoptimized, originalAmount if optimized).

      // Simpler: Use the *Rawest* amount we have.
      // grossAmount est TOUJOURS en EUR (nativement ou déjà converti)
      // originalAmount = montant brut USD (si conversion appliquée)
      // forceUSD coché  → re-convertir depuis USD vers EUR au taux du jour
      // forceUSD décoché → utiliser grossAmount (EUR) directement
      let currentAmount;
      if (forceUSD && suggestion.originalAmount && suggestion.exchangeRate) {
        currentAmount = suggestion.originalAmount / suggestion.exchangeRate;
      } else {
        currentAmount = suggestion.grossAmount;
      }

      const net = currentAmount * (1 - taxRate);
      netInput.value = net.toFixed(2);
    }

    // Attach Listeners
    setTimeout(() => {
      const rows = document.querySelectorAll('.dividend-file-row');
      rows.forEach(row => {
        const idx = row.dataset.index;
        const taxSelect = row.querySelector('.div-tax-select');
        const usdCheck = row.querySelector('.div-usd-check');

        if (taxSelect) taxSelect.onchange = () => recalculateRow(idx);
        if (usdCheck) usdCheck.onchange = () => recalculateRow(idx);

        // Initial calculation for each row
        recalculateRow(idx);
      });
    }, 100);

    // Modal Events
    const closeModal = () => {
      modal.classList.remove('show');
      setTimeout(() => { modal.style.display = 'none'; }, 300); // Wait for transition
    };

    document.getElementById('close-div-modal').onclick = closeModal;
    document.getElementById('cancel-div-btn').onclick = closeModal;

    // Confirm Button
    const confirmBtn = document.getElementById('confirm-div-btn');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.onclick = () => this.handleConfirmDividends();
  }

  // Helper to render Rows with new Tax Controls
  renderDividendRows(suggestions) {
    return suggestions.map((s, i) => {
      const unitPrice = s.amountPerShare;
      const rateInfo = s.exchangeRate ? `(Rate: ${s.exchangeRate.toFixed(4)})` : '';

      // Default State
      const isConverted = !!s.originalAmount;

      // Display Info
      let conversionInfo = isConverted
        ? `<div style="font-size:10px; color:#888;">Raw: ${formatCurrency(s.originalAmount, s.originalCurrency)} ${rateInfo}</div>`
        : `<div style="font-size:10px; color:#888;">Native: ${s.currency}</div>`;

      return `
                <div class="dividend-file-row div-row-${i}" data-index="${i}" style="display:flex; align-items:flex-start; gap:10px; padding:12px 8px; border-bottom:1px solid var(--border-color);">
                    <input type="checkbox" checked class="div-check" data-index="${i}" style="margin-top:4px;">
                    
                    <div style="flex:1;">
                        <div style="font-weight:600; font-size:14px;">${s.name}</div>
                        <div style="font-size:11px; color:var(--text-muted); margin-bottom:4px;">
                            <span style="font-weight:bold;">${s.ticker}</span> • ${formatDate(s.date)} • Qty: ${formatQuantity(s.quantity)}
                        </div>
                        <div style="font-size:11px; color:var(--accent-blue);">
                            Unit: ${unitPrice}
                        </div>
                        ${conversionInfo}
                    </div>

                    <div style="text-align:right; display:flex; flex-direction:column; gap:6px; align-items:flex-end;">
                         
                         <!-- Settings Row -->
                         <div style="display:flex; gap:6px; align-items:center;">
                            <label style="font-size:10px; color:var(--text-secondary); display:flex; align-items:center; ${isConverted ? '' : 'opacity:0.4; cursor:not-allowed;'}" title="${isConverted ? '' : 'Aucun montant brut USD disponible pour cette ligne : rien à convertir.'}">
                                <input type="checkbox" class="div-usd-check" ${isConverted ? 'checked' : ''} ${isConverted ? '' : 'disabled'} style="width:auto; margin-right:4px;">
                                Force USD
                            </label>
                            
                            <select class="div-tax-select" style="padding:2px; font-size:11px; border:1px solid var(--border-color); border-radius:4px; width:80px;">
                                <option value="0">No Tax</option>
                                <option value="0.30" selected>Flat (30%)</option>
                                <option value="0.15">US (15%)</option>
                                <option value="0.128">Impôt (12.8%)</option>
                                <option value="0.172">CSG (17.2%)</option>
                            </select>
                         </div>

                         <div style="display:flex; align-items:center; gap:6px;">
                            <span style="font-size:12px; color:var(--text-secondary);">Net €:</span>
                            <input type="number" class="div-net-input" data-index="${i}" value="${(s.grossAmount * 0.7).toFixed(2)}" step="0.01" style="width:80px; padding:6px; font-size:14px; border:1px solid var(--border-color); border-radius:4px; text-align:right; font-weight:bold; background:var(--bg-secondary);">
                         </div>
                         
                    </div>
                </div>
            `;
    }).join('');
  }

  async handleConfirmDividends() {
    const modal = document.getElementById('dividend-modal');
    const checks = document.querySelectorAll('.div-check');
    let count = 0;

    // for...of obligatoire : forEach ignore les await
    for (const chk of checks) {
      if (!chk.checked) continue;
      const idx = chk.dataset.index;
      const suggestion = this.currentSuggestions[idx];
      const netAmount = parseFloat(document.querySelector(`.div-net-input[data-index="${idx}"]`).value);

      const newTx = {
        id: Date.now() + Math.random().toString(36).substr(2, 9) + idx,
        date: suggestion.date,
        ticker: suggestion.ticker,
        name: suggestion.name || 'Dividend',
        type: 'dividend',
        amount: netAmount,
        price: netAmount,
        quantity: 1,
        currency: 'EUR',
        broker: suggestion.broker || 'Auto-Detect',
        assetType: 'Dividend'
      };

      await this.storage.addPurchase(newTx);
      count++;
    }

    modal.classList.remove('show');
    setTimeout(() => { modal.style.display = 'none'; }, 300);

    if (count > 0) {
      this.ui.showNotification(`${count} dividende${count > 1 ? 's' : ''} ajouté${count > 1 ? 's' : ''} !`, 'success');
      await this.render();
    }
  }

  async handleManualDividend() {
    // Try to find asset name from existing purchases
    let assetName = 'Dividend Manual';
    const ticker = document.getElementById('div-ticker-select').value;
    const existing = this.storage.getPurchases().find(p => p.ticker === ticker && p.assetType !== 'Dividend');
    if (existing) assetName = existing.name;

    const purchase = {
      id: Date.now() + Math.random().toString(36).substr(2, 9),
      ticker: ticker,
      name: assetName,
      date: document.getElementById('div-date').value,
      type: 'dividend',
      amount: parseFloat(document.getElementById('div-amount').value),
      price: parseFloat(document.getElementById('div-amount').value),
      quantity: 1,
      currency: document.getElementById('div-currency').value,
      broker: document.getElementById('div-broker').value,
      assetType: 'Dividend'
    };

    if (!purchase.ticker || !purchase.date || isNaN(purchase.amount)) {
      alert('Veuillez remplir les champs obligatoires');
      return;
    }

    await this.storage.addPurchase(purchase);
    this.ui.showNotification('Dividende ajouté', 'success');
    document.getElementById('dividend-form').reset();
    await this.render();
  }

  setupTabs() {
    // Legacy or reused if needed, but logic moved to setupHeaderListeners
  }

  setupCSVListeners() {
    const table = document.getElementById('purchases-table');
    if (!table) return;

    // Listners for table actions are now handled via Delegation in attachEventListeners()
    // This method should focus only on CSV features if any specific listeners remain outside delegation.

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

    // --- GESTION EXPANSION MOBILE (Event Delegation) ---
    // On nettoie d'abord l'ancien listener s'il existe pour éviter les doublons
    if (this._mobileClickHandler) {
      table.removeEventListener('click', this._mobileClickHandler);
    }

    this._mobileClickHandler = (e) => {
      // Validation basique mobile
      if (!window.matchMedia('(max-width: 768px)').matches) return;

      const row = e.target.closest('tr[data-row-key]');
      if (!row) return;


      // Feedback visuel
      row.style.backgroundColor = '#2d3748';
      setTimeout(() => row.style.backgroundColor = '', 200);

      const nextRow = row.nextElementSibling;
      if (nextRow && nextRow.classList.contains('mobile-detail-row')) {
        nextRow.remove(); // Fermer si déjà ouvert
        return;
      }

      // Fermer les autres expansion existantes
      document.querySelectorAll('.mobile-detail-row').forEach(r => r.remove());

      // Créer la ligne de détail
      const key = row.dataset.rowKey;

      // DEBUG ALERT
      // alert("Opening details for: " + key);

      const purchase = this.storage.getPurchaseByKey(key);
      if (!purchase) {
        console.error("Purchase not found for key:", key);
        return;
      }

      const detailRow = document.createElement('tr');
      detailRow.className = 'mobile-detail-row';

      // Récupérer les données
      const fullDate = formatDate(purchase.date);
      const broker = purchase.broker;
      const brokerObj = getBrokersSync().find(b => b.value === purchase.broker);
      const brokerLabel = brokerObj ? brokerObj.label : purchase.broker;
      const type = purchase.assetType;
      const name = purchase.name;
      const ccy = purchase.currency;

      detailRow.innerHTML = `
                <td colspan="15" style="padding: 0 !important; border: none;">
                    <div class="mobile-detail-content">
                        <div class="detail-grid">
                            <div class="detail-item">
                                <span class="label">Type</span>
                                <span class="value">${type}</span>
                            </div>
                            <div class="detail-item">
                                <span class="label">Devise</span>
                                <span class="value">${ccy}</span>
                            </div>
                            <div class="detail-item full-width">
                                <span class="label">Nom complet</span>
                                <span class="value">${name}</span>
                            </div>
                        </div>
                        <div class="detail-actions">
                             <button class="mobile-action-btn edit" data-key="${key}">
                                <i class="fas fa-edit"></i> Modifier
                             </button>
                             <button class="mobile-action-btn delete" data-key="${key}">
                                <i class="fas fa-trash-alt"></i> Supprimer
                             </button>
                        </div>
                    </div>
                </td>
            `;

      // Insérer après la ligne cliquée
      row.parentNode.insertBefore(detailRow, row.nextSibling);

      // Attacher les actions
      detailRow.querySelector('.mobile-action-btn.edit').addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.openEditModal(key);
      });
      detailRow.querySelector('.mobile-action-btn.delete').addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (confirm('Supprimer cette transaction ?')) {
          this.storage.removePurchase(key);
          this.selectedRows.delete(key);
          this.render();
          this.filterManager.updateTickerFilter(() => this.render());
        }
      });
    };

    table.addEventListener('click', this._mobileClickHandler);
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
    try {
      console.log('Open Edit Modal for key:', key);
      const purchase = this.storage.getPurchaseByKey(key);
      if (!purchase) {
        console.error('Purchase not found for key:', key);
        alert('Transaction introuvable.');
        return;
      }

      const brokerSelect = document.getElementById('edit-broker');
      if (brokerSelect) {
        const editOpts = { includeAdd: true };
        const brokers = getBrokersSync();
        fillSelect(brokerSelect, brokers, editOpts);
        attachAddBrokerHandler(brokerSelect, [{ el: brokerSelect, opts: editOpts }]);
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
        else console.warn(`Field ${id} not found in edit modal`);
      });

      this.currentEditKey = key;

      const modal = document.getElementById('edit-modal');
      if (!modal) {
        console.error('Edit modal element not found!');
        return;
      }

      modal.style.display = 'flex';
      // Force reflow
      void modal.offsetWidth;
      modal.classList.add('show');

      const form = document.getElementById('edit-form');
      const submitHandler = (e) => {
        e.preventDefault();
        this.saveEdit();
      };
      if (this.submitHandler) form.removeEventListener('submit', this.submitHandler);
      this.submitHandler = submitHandler;
      form.addEventListener('submit', this.submitHandler);

    } catch (e) {
      console.error('Error opening edit modal:', e);
      alert('Erreur ouverture modal: ' + e.message);
    }
  }

  saveEdit() {
    const key = this.currentEditKey;
    const original = this.storage.getPurchaseByKey(key);

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

    // Les lignes dividende affichent/agrègent "amount" en priorité sur "price" :
    // il faut garder les deux champs synchronisés sinon l'édition semble ne rien faire.
    if (original && (original.type === 'dividend' || original.assetType === 'Dividend')) {
      updates.amount = updates.price;
    }

    if (!updates.ticker || !updates.name || !updates.price ||
      !updates.quantity || !updates.date || !updates.assetType ||
      !updates.broker || !updates.currency) {
      alert('Tous les champs sont requis.');
      return;
    }

    if (updates.price <= 0 || updates.quantity === 0) {
      alert('Le prix doit être positif et la quantité non nulle.');
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
        const tabName = btn.dataset.tab; // Récupère "asset", "cash" ou "data" ou "dividend"
        const content = document.getElementById(`tab-${tabName}`);
        if (content) content.classList.add('active');

        // Logic Spécifique Tab "Dividend"
        if (tabName === 'dividend') {
          const divTickerSelect = document.getElementById('div-ticker-select');
          const divBrokerSelect = document.getElementById('div-broker');

          if (divTickerSelect) {
            const purchases = this.storage.getPurchases();
            // Unique tickers from Stocks/ETFs (excluding cash/div/fees)
            const tickers = [...new Set(purchases
              .filter(p => (p.assetType === 'Stock' || p.assetType === 'ETF') && !p.type)
              .map(p => p.ticker)
            )].sort();

            divTickerSelect.innerHTML = '<option value="">Choisir l\'actif...</option>' +
              tickers.map(t => `<option value="${t}">${t}</option>`).join('');
          }

          if (divBrokerSelect) {
            const divOpts2 = { includeEmpty: 'Courtier...', includeAdd: true };
            getBrokers().then(brokers => {
              fillSelect(divBrokerSelect, brokers, divOpts2);
              attachAddBrokerHandler(divBrokerSelect, [{ el: divBrokerSelect, opts: divOpts2 }]);
            });
          }
        }
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