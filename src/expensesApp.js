// ========================================
// expensesApp.js - Page Dépenses : historique bancaire, catégorisation, tendances
// ========================================

import { auth, db } from './firebaseConfig.js';
import { categorizeTransaction, isCredit } from './expenseCategorizer.js';

const fmtEUR = (v) => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 2 }).format(v || 0);
const fmtDate = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return iso; }
};

class ExpensesApp {
  constructor() {
    this.transactions = [];
    this.accountsById = {};
    this.period = 'this_month';
    this.categoryFilter = 'all';
    this.searchTerm = '';
    this.trendChart = null;

    this.periodSelect = document.getElementById('expenses-period-select');
    this.categorySelect = document.getElementById('expenses-category-select');
    this.searchInput = document.getElementById('expenses-search');
    this.listEl = document.getElementById('expenses-transaction-list');
    this.emptyStateEl = document.getElementById('expenses-empty-state');
    this.contentEl = document.getElementById('expenses-content');
    this.loadingEl = document.getElementById('expenses-loading');
  }

  init() {
    this.periodSelect?.addEventListener('change', () => { this.period = this.periodSelect.value; this.renderAll(); });
    this.searchInput?.addEventListener('input', () => { this.searchTerm = this.searchInput.value.trim().toLowerCase(); this.renderList(); });
    this.categorySelect?.addEventListener('change', () => { this.categoryFilter = this.categorySelect.value; this.renderList(); });

    auth.onAuthStateChanged((user) => {
      if (!user) { window.location.href = 'login.html'; return; }

      db.collection(`users/${user.uid}/bankAccounts`).onSnapshot((snap) => {
        this.accountsById = {};
        snap.docs.forEach((d) => { this.accountsById[d.id] = d.data(); });
        this.renderList();
      });

      db.collection(`users/${user.uid}/transactions`).onSnapshot((snap) => {
        this.transactions = snap.docs.map((d) => ({ id: d.id, ...d.data(), category: categorizeTransaction(d.data()) }));
        this.toggleEmptyState();
        this.renderAll();
      });
    });
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
    return this.transactions.filter((tx) => {
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
    this.renderList();
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
    this.transactions.forEach((tx) => {
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
      return `
        <div class="expense-row">
            <div class="expense-row-icon">${tx.category.icon}</div>
            <div class="expense-row-main">
                <div class="expense-row-title">${tx.counterparty || tx.description || 'Transaction'}</div>
                <div class="expense-row-meta">${tx.category.label} · ${account?.name || 'Compte'} · ${fmtDate(tx.bookingDate)}</div>
            </div>
            <div class="expense-row-amount" style="color:${amountColor};">${sign}${fmtEUR(Math.abs(tx.amount || 0))}</div>
        </div>`;
    }).join('');
  }
}

const app = new ExpensesApp();
app.init();
