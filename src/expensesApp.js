// ========================================
// expensesApp.js - Page Dépenses : historique bancaire, catégorisation, tendances
// ========================================

import { auth, db } from './firebaseConfig.js';
import { categorizeTransaction, isCredit, getCategoriesForDirection } from './expenseCategorizer.js';
import { detectRecurring, computeRecurringKey, FREQUENCY_LABELS } from './recurringDetector.js';

const fmtEUR = (v) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(v || 0);
const fmtDate = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return iso; }
};

class ExpensesApp {
  constructor() {
    this.rawTransactions = [];
    this.transactions = [];
    this.categoryOverrides = {};
    this.accountsById = {};
    this.accountToBank = {};
    this.bankConnections = [];
    this.dismissedRecurringKeys = new Set();
    this.manualRecurringKeys = new Set();
    this.customRecurringLabels = {};
    this.customRecurringFrequencies = {};
    this.period = 'this_month';
    this.bankFilter = 'all';
    this.categoryFilter = 'all';
    this.searchTerm = '';
    this.trendChart = null;

    this.periodSelect = document.getElementById('expenses-period-select');
    this.bankSelect = document.getElementById('expenses-bank-select');
    this.categorySelect = document.getElementById('expenses-category-select');
    this.searchInput = document.getElementById('expenses-search');
    this.listEl = document.getElementById('expenses-transaction-list');
    this.emptyStateEl = document.getElementById('expenses-empty-state');
    this.contentEl = document.getElementById('expenses-content');
    this.loadingEl = document.getElementById('expenses-loading');
  }

  init() {
    this.periodSelect?.addEventListener('change', () => { this.period = this.periodSelect.value; this.renderAll(); });
    this.bankSelect?.addEventListener('change', () => { this.bankFilter = this.bankSelect.value; this.renderAll(); });
    this.searchInput?.addEventListener('input', () => { this.searchTerm = this.searchInput.value.trim().toLowerCase(); this.renderList(); });
    this.categorySelect?.addEventListener('change', () => { this.categoryFilter = this.categorySelect.value; this.renderList(); });

    auth.onAuthStateChanged((user) => {
      if (!user) { window.location.href = 'login.html'; return; }
      this.uid = user.uid;

      db.doc(`users/${user.uid}/settings/recurringPrefs`).onSnapshot((doc) => {
        const data = doc.data() || {};
        this.dismissedRecurringKeys = new Set(data.dismissedKeys || []);
        this.manualRecurringKeys = new Set(data.manualKeys || []);
        this.customRecurringLabels = data.customLabels || {};
        this.customRecurringFrequencies = data.customFrequencies || {};
        this.renderRecurring();
      });

      db.collection(`users/${user.uid}/bankAccounts`).onSnapshot((snap) => {
        this.accountsById = {};
        snap.docs.forEach((d) => { this.accountsById[d.id] = d.data(); });
        this.renderAll();
      });

      db.collection(`users/${user.uid}/bankConnections`).onSnapshot((snap) => {
        this.bankConnections = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this.accountToBank = {};
        this.bankConnections.forEach((conn) => {
          (conn.accountUids || []).forEach((accountId) => { this.accountToBank[accountId] = conn; });
        });
        this.populateBankFilter();
        this.renderAll();
      });

      db.doc(`users/${user.uid}/settings/categoryOverrides`).onSnapshot((doc) => {
        this.categoryOverrides = doc.data() || {};
        this.applyCategorization();
        this.renderAll();
      });

      db.collection(`users/${user.uid}/transactions`).onSnapshot((snap) => {
        this.rawTransactions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        this.applyCategorization();
        this.toggleEmptyState();
        this.renderAll();
      });
    });
  }

  // Recalcule this.transactions (avec catégorie) à partir des données brutes + des overrides
  // manuels — appelé quand les transactions OU les overrides changent.
  applyCategorization() {
    this.transactions = this.rawTransactions.map((tx) => ({
      ...tx,
      category: categorizeTransaction(tx, this.categoryOverrides[tx.id]),
    }));
  }

  async setCategoryOverride(txId, categoryKey) {
    if (!this.uid || !txId) return;
    this.categoryOverrides[txId] = categoryKey;
    this.applyCategorization();
    this.renderAll();
    await db.doc(`users/${this.uid}/settings/categoryOverrides`).set({ [txId]: categoryKey }, { merge: true });
  }

  populateBankFilter() {
    if (!this.bankSelect) return;
    const prevValue = this.bankSelect.value;
    const options = ['<option value="all">Toutes les banques</option>']
      .concat(this.bankConnections.map((c) => `<option value="${c.id}">🏦 ${c.aspspName || 'Banque connectée'}</option>`));
    this.bankSelect.innerHTML = options.join('');
    if ([...this.bankSelect.options].some((o) => o.value === prevValue)) this.bankSelect.value = prevValue;
  }

  getBankFiltered(list) {
    if (this.bankFilter === 'all') return list;
    return list.filter((tx) => this.accountToBank[tx.accountId]?.id === this.bankFilter);
  }

  // Les cartes à débit différé (ex: Visa Ultim Boursorama) sont synchronisées comme un compte
  // à part par Enable Banking, mais leurs mouvements sont déjà présents sur le compte courant
  // lié : les compter aussi ferait doubler chaque achat carte dans les stats.
  getVisibleTransactions() {
    return this.transactions.filter((tx) => this.accountsById[tx.accountId]?.cashAccountType !== 'CARD');
  }

  toggleEmptyState() {
    const hasData = this.transactions.length > 0;
    if (this.loadingEl) this.loadingEl.style.display = 'none';
    if (this.emptyStateEl) this.emptyStateEl.style.display = hasData ? 'none' : 'block';
    if (this.contentEl) this.contentEl.style.display = hasData ? 'block' : 'none';
  }

  getPeriodRange() {
    const now = new Date();
    const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);

    switch (this.period) {
      case 'last_month': {
        const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const end = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start, end };
      }
      case '3m':
        return { start: new Date(now.getFullYear(), now.getMonth() - 2, 1), end: null };
      case '6m':
        return { start: new Date(now.getFullYear(), now.getMonth() - 5, 1), end: null };
      case 'year':
        return { start: new Date(now.getFullYear(), 0, 1), end: null };
      case 'all':
        return { start: null, end: null };
      case 'this_month':
      default:
        return { start: startOfMonth(now), end: null };
    }
  }

  getFilteredByPeriod() {
    const { start, end } = this.getPeriodRange();
    return this.getBankFiltered(this.getVisibleTransactions()).filter((tx) => {
      const d = tx.bookingDate ? new Date(tx.bookingDate) : null;
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d >= end) return false;
      return true;
    });
  }

  renderAll() {
    const periodTx = this.getFilteredByPeriod();
    this.renderKpis(periodTx);
    this.renderCategoryBreakdown(periodTx);
    this.renderTrendChart();
    this.renderRecurring();
    this.renderList();
  }

  renderRecurring() {
    const chargesContainer = document.getElementById('expenses-recurring-list-charges');
    const incomeContainer = document.getElementById('expenses-recurring-list-income');
    if (!chargesContainer || !incomeContainer) return;

    const visibleTx = this.getBankFiltered(this.getVisibleTransactions());

    const recurringItems = detectRecurring(visibleTx, {
      forcedKeys: this.manualRecurringKeys,
      customLabels: this.customRecurringLabels,
      customFrequencies: this.customRecurringFrequencies,
    }).filter((item) => !this.dismissedRecurringKeys.has(item.key));

    const charges = recurringItems.filter((item) => item.direction === 'DBIT');
    const recurringIncome = recurringItems.filter((item) => item.direction === 'CRDT');

    // Côté revenus, en plus des entrées fixes (auto/manuelles), on ajoute toute rentrée d'argent
    // du mois en cours qui n'est pas déjà comptée dans une entrée fixe (ex: virement ponctuel).
    const oneOffIncome = this.getOneOffIncomeThisMonth(visibleTx, recurringIncome);
    const income = [...recurringIncome, ...oneOffIncome].sort((a, b) => b.amount - a.amount);

    this.renderRecurringKpis([...charges, ...income]);

    this.renderRecurringRows(
      chargesContainer,
      charges,
      'Pas encore de charge fixe détectée (il faut au moins 2 mois de données sur un même prélèvement, ou ajoute-en une manuellement depuis la liste des transactions).'
    );
    this.renderRecurringRows(
      incomeContainer,
      income,
      'Aucun revenu ce mois-ci.'
    );
  }

  getOneOffIncomeThisMonth(transactions, recurringIncomeItems) {
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const recurringKeys = new Set(recurringIncomeItems.map((item) => item.key));

    return transactions
      .filter((tx) => isCredit(tx) && (tx.bookingDate || '').slice(0, 7) === currentMonthKey)
      .filter((tx) => {
        const key = computeRecurringKey(tx);
        return !key || !recurringKeys.has(key);
      })
      .map((tx) => ({
        key: `oneoff_${tx.id}`,
        label: tx.counterparty || tx.description || 'Transaction',
        direction: 'CRDT',
        category: tx.category,
        amount: Math.abs(tx.amount || 0),
        typicalDay: tx.bookingDate ? new Date(tx.bookingDate).getDate() : 1,
        monthsSeen: 1,
        monthsSet: new Set([currentMonthKey]),
        manual: false,
        oneOff: true,
        frequencyMonths: 1,
        monthsSinceLast: 0,
        dueThisCycle: true,
      }));
  }

  renderRecurringRows(container, items, emptyMessage) {
    if (!items.length) {
      container.innerHTML = `<div class="empty-state">${emptyMessage}</div>`;
      return;
    }

    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const today = now.getDate();

    container.innerHTML = items.map((item) => {
      const paidThisMonth = item.monthsSet.has(currentMonthKey);
      let statusHtml;
      if (paidThisMonth) {
        statusHtml = '<span class="recurring-status recurring-status-paid"><i class="fas fa-check-circle"></i> Payé</span>';
      } else if (!item.dueThisCycle) {
        statusHtml = '<span class="recurring-status recurring-status-upcoming"><i class="fas fa-hourglass-half"></i> Pas dû ce mois</span>';
      } else if (today <= item.typicalDay + 5) {
        statusHtml = `<span class="recurring-status recurring-status-pending"><i class="fas fa-clock"></i> Prévu vers le ${item.typicalDay}</span>`;
      } else {
        statusHtml = '<span class="recurring-status recurring-status-late"><i class="fas fa-triangle-exclamation"></i> En retard</span>';
      }

      const amountColor = item.direction === 'CRDT' ? 'var(--accent-green)' : 'var(--text-primary)';
      const sign = item.direction === 'CRDT' ? '+' : '-';
      const tag = item.manual ? ' (manuel)' : (item.oneOff ? ' (ponctuel)' : '');
      const freqLabel = FREQUENCY_LABELS[item.frequencyMonths] || FREQUENCY_LABELS[1];
      const meta = item.oneOff
        ? `${item.category.label} · reçu le ${item.typicalDay} du mois`
        : `${item.category.label} · ${freqLabel} · vers le ${item.typicalDay} du mois · vu sur ${item.monthsSeen} mois`;

      return `
        <div class="recurring-row">
            <div class="expense-row-icon">${item.category.icon}</div>
            <div class="expense-row-main">
                <div class="expense-row-title">${item.label}${tag ? ` <span style="color:var(--text-muted); font-size:11px;">${tag}</span>` : ''}</div>
                <div class="expense-row-meta">${meta}</div>
            </div>
            <div class="recurring-row-amount" style="color:${amountColor};">${sign}${fmtEUR(item.amount)}</div>
            <div class="recurring-row-status">${statusHtml}</div>
            <button class="recurring-rename-btn" data-key="${item.key}" data-label="${item.label.replace(/"/g, '&quot;')}" data-frequency="${item.frequencyMonths}" title="Renommer / changer la fréquence">
                <i class="fas fa-pen"></i>
            </button>
            <button class="recurring-dismiss-btn" data-key="${item.key}" title="Ne plus afficher dans les fixes">
                <i class="fas fa-times"></i>
            </button>
        </div>`;
    }).join('');

    container.querySelectorAll('.recurring-dismiss-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.dismissRecurring(btn.dataset.key));
    });
    container.querySelectorAll('.recurring-rename-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.renameRecurring(btn.dataset.key, btn.dataset.label, Number(btn.dataset.frequency) || 1));
    });
  }

  renderRecurringKpis(items) {
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const set = (id, paid, total) => {
      const el = document.getElementById(id);
      if (el) el.textContent = `${fmtEUR(paid)} / ${fmtEUR(total)}`;
    };

    const sumPaidAndTotal = (list) => list.reduce(
      (acc, item) => {
        // Une charge trimestrielle/annuelle ne compte dans le total du mois que le mois où elle
        // est effectivement due (ou déjà réglée) — pas chaque mois entre deux échéances.
        if (!item.dueThisCycle && !item.monthsSet.has(currentMonthKey)) return acc;
        acc.total += item.amount;
        if (item.monthsSet.has(currentMonthKey)) acc.paid += item.amount;
        return acc;
      },
      { paid: 0, total: 0 }
    );

    const charges = sumPaidAndTotal(items.filter((i) => i.direction === 'DBIT'));
    const income = sumPaidAndTotal(items.filter((i) => i.direction === 'CRDT'));

    set('expenses-kpi-fixed-charges', charges.paid, charges.total);
    set('expenses-kpi-fixed-income', income.paid, income.total);
  }

  async saveRecurringPrefs() {
    if (!this.uid) return;
    await db.doc(`users/${this.uid}/settings/recurringPrefs`).set({
      dismissedKeys: [...this.dismissedRecurringKeys],
      manualKeys: [...this.manualRecurringKeys],
      customLabels: this.customRecurringLabels,
      customFrequencies: this.customRecurringFrequencies,
    }, { merge: true });
  }

  async dismissRecurring(key) {
    if (!this.uid || !key) return;
    this.dismissedRecurringKeys.add(key);
    this.manualRecurringKeys.delete(key);
    delete this.customRecurringLabels[key];
    delete this.customRecurringFrequencies[key];
    this.renderRecurring();
    await this.saveRecurringPrefs();
  }

  // Demande une fréquence (en mois) à l'utilisateur ; accepte 1/2/3/6/12 ou les mots courants.
  promptFrequency(currentFrequency) {
    const answer = prompt(
      'Fréquence : tous les combien de mois revient cette charge/revenu ?\n(1 = mensuel, 3 = trimestriel, 6 = semestriel, 12 = annuel)',
      String(currentFrequency || 1)
    );
    if (answer === null) return null;
    const parsed = parseInt(answer.trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : currentFrequency || 1;
  }

  async renameRecurring(key, currentLabel, currentFrequency) {
    if (!key) return;
    const name = prompt('Nom personnalisé :', currentLabel || '');
    if (name === null) return;
    const trimmed = name.trim();
    if (trimmed) this.customRecurringLabels[key] = trimmed;
    else delete this.customRecurringLabels[key];

    const frequency = this.promptFrequency(currentFrequency);
    if (frequency !== null) this.customRecurringFrequencies[key] = frequency;

    this.renderRecurring();
    await this.saveRecurringPrefs();
  }

  async markTransactionAsFixed(txId) {
    const tx = this.transactions.find((t) => t.id === txId);
    if (!tx) return;
    const key = computeRecurringKey(tx);
    if (!key) { alert('Impossible de déterminer un libellé pour cette transaction.'); return; }

    const name = prompt('Nom pour cette dépense/revenu fixe :', tx.counterparty || tx.description || '');
    if (name === null) return;

    const frequency = this.promptFrequency(1);
    if (frequency === null) return;

    this.manualRecurringKeys.add(key);
    this.dismissedRecurringKeys.delete(key);
    this.customRecurringFrequencies[key] = frequency;
    const trimmed = name.trim();
    if (trimmed) this.customRecurringLabels[key] = trimmed;

    this.renderAll();
    await this.saveRecurringPrefs();
  }

  renderKpis(periodTx) {
    const income = periodTx.filter(isCredit).reduce((s, tx) => s + Math.abs(tx.amount || 0), 0);
    const expenses = periodTx.filter((tx) => !isCredit(tx)).reduce((s, tx) => s + Math.abs(tx.amount || 0), 0);
    const net = income - expenses;

    const set = (id, val, colorVar) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = fmtEUR(val);
      if (colorVar) el.style.color = colorVar;
    };

    set('expenses-kpi-income', income, 'var(--accent-green)');
    set('expenses-kpi-expenses', expenses, 'var(--accent-red)');
    set('expenses-kpi-net', net, net >= 0 ? 'var(--accent-green)' : 'var(--accent-red)');
  }

  renderCategoryBreakdown(periodTx) {
    const container = document.getElementById('expenses-category-breakdown');
    if (!container) return;

    const debitTx = periodTx.filter((tx) => !isCredit(tx));
    const total = debitTx.reduce((s, tx) => s + Math.abs(tx.amount || 0), 0);

    if (total <= 0) {
      container.innerHTML = '<div style="color:var(--text-muted); font-size:12px; text-align:center; padding: 20px;">Aucune dépense sur cette période.</div>';
      return;
    }

    const byCategory = {};
    debitTx.forEach((tx) => {
      const cat = tx.category;
      if (!byCategory[cat.key]) byCategory[cat.key] = { ...cat, value: 0 };
      byCategory[cat.key].value += Math.abs(tx.amount || 0);
    });

    const data = Object.values(byCategory)
      .map((c) => ({ ...c, pct: (c.value / total) * 100 }))
      .sort((a, b) => b.value - a.value);

    let barHTML = '<div class="allocation-bar">';
    let listHTML = '<div class="allocation-list" style="flex-grow: 1;">';

    data.forEach((item) => {
      barHTML += `<div class="alloc-segment" style="width: ${item.pct}%; background-color: ${item.color};"></div>`;
      listHTML += `<div class="alloc-row">
                <div class="alloc-left">
                    <span class="alloc-dot" style="background-color: ${item.color};"></span>
                    <span class="alloc-pct">${item.pct.toFixed(1)}%</span>
                    <span class="alloc-label">${item.icon} ${item.label}</span>
                </div>
                <div class="alloc-right"><span>${fmtEUR(item.value)}</span></div>
            </div>`;
    });

    barHTML += '</div>'; listHTML += '</div>';
    container.innerHTML = `<div class="allocation-wrapper" style="display: flex; flex-direction: column; height: 100%;">${barHTML}${listHTML}</div>`;

    // Alimente le filtre catégorie avec les catégories réellement présentes
    if (this.categorySelect) {
      const prevValue = this.categorySelect.value;
      const options = ['<option value="all">Toutes les catégories</option>']
        .concat(data.map((c) => `<option value="${c.key}">${c.icon} ${c.label}</option>`));
      this.categorySelect.innerHTML = options.join('');
      if ([...this.categorySelect.options].some((o) => o.value === prevValue)) this.categorySelect.value = prevValue;
    }
  }

  renderTrendChart() {
    const canvas = document.getElementById('expenses-trend-chart');
    if (!canvas || typeof Chart === 'undefined') return;

    const now = new Date();
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }) });
    }

    const income = months.map(() => 0);
    const expenses = months.map(() => 0);
    this.getBankFiltered(this.getVisibleTransactions()).forEach((tx) => {
      if (!tx.bookingDate) return;
      const key = tx.bookingDate.slice(0, 7);
      const idx = months.findIndex((m) => m.key === key);
      if (idx === -1) return;
      if (isCredit(tx)) income[idx] += Math.abs(tx.amount || 0);
      else expenses[idx] += Math.abs(tx.amount || 0);
    });

    if (this.trendChart) this.trendChart.destroy();
    this.trendChart = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: months.map((m) => m.label),
        datasets: [
          { label: 'Revenus', data: income, backgroundColor: '#10b981', borderRadius: 4, barPercentage: 0.6 },
          { label: 'Dépenses', data: expenses, backgroundColor: '#ef4444', borderRadius: 4, barPercentage: 0.6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'top', labels: { color: '#9fa6bc', font: { size: 11 } } },
          tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtEUR(c.parsed.y)}` } },
        },
        scales: {
          x: { grid: { display: false, drawBorder: false }, ticks: { color: '#94a3b8', font: { size: 10 } } },
          y: { grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false }, ticks: { color: '#94a3b8', font: { size: 10 }, callback: (v) => v >= 1000 ? (v / 1000) + 'k' : v } },
        },
      },
    });
  }

  renderList() {
    if (!this.listEl) return;

    let rows = this.getFilteredByPeriod();
    if (this.categoryFilter !== 'all') rows = rows.filter((tx) => tx.category.key === this.categoryFilter);
    if (this.searchTerm) {
      rows = rows.filter((tx) => `${tx.description || ''} ${tx.counterparty || ''}`.toLowerCase().includes(this.searchTerm));
    }
    rows = rows.slice().sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''));

    if (!rows.length) {
      this.listEl.innerHTML = '<div class="empty-state">Aucune transaction pour ces filtres.</div>';
      return;
    }

    this.listEl.innerHTML = rows.map((tx) => {
      const account = this.accountsById[tx.accountId];
      const amountColor = isCredit(tx) ? 'var(--accent-green)' : 'var(--text-primary)';
      const sign = isCredit(tx) ? '+' : '-';
      const categoryOptions = getCategoriesForDirection(isCredit(tx))
        .map((c) => `<option value="${c.key}" ${c.key === tx.category.key ? 'selected' : ''}>${c.icon} ${c.label}</option>`)
        .join('');
      return `
        <div class="expense-row">
            <div class="expense-row-icon">${tx.category.icon}</div>
            <div class="expense-row-main">
                <div class="expense-row-title">${tx.counterparty || tx.description || 'Transaction'}</div>
                <div class="expense-row-meta">${account?.name || 'Compte'} · ${fmtDate(tx.bookingDate)}</div>
            </div>
            <select class="expense-row-category-select" data-tx-id="${tx.id}" title="Changer la catégorie">${categoryOptions}</select>
            <div class="expense-row-amount" style="color:${amountColor};">${sign}${fmtEUR(Math.abs(tx.amount || 0))}</div>
            <button class="expense-row-fixed-btn" data-tx-id="${tx.id}" title="Marquer comme dépense/revenu fixe">
                <i class="fas fa-thumbtack"></i>
            </button>
        </div>`;
    }).join('');

    this.listEl.querySelectorAll('.expense-row-fixed-btn').forEach((btn) => {
      btn.addEventListener('click', () => this.markTransactionAsFixed(btn.dataset.txId));
    });
    this.listEl.querySelectorAll('.expense-row-category-select').forEach((select) => {
      select.addEventListener('change', () => this.setCategoryOverride(select.dataset.txId, select.value));
    });
  }
}

const app = new ExpensesApp();
app.init();
