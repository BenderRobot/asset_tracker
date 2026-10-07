// dividendModal.js - Rendu du modal "Détail des Dividendes" (page Analytics).
//
// Les calculs vivent dans dividendAnalytics.js (pur, testé) ; ce module ne
// fait que l'affichage : KPI, onglets, graphiques Chart.js et tableaux.

import { buildDividendAnalytics, aggregateByPeriod, MONTH_LABELS, monthKey } from './dividendAnalytics.js';

// Palette catégorielle (étapes "dark" validées, ordre fixe). Une couleur suit
// l'actif (rang sur le total historique tous courtiers), jamais sa position
// dans la vue filtrée. Au-delà de 8 actifs : regroupement "Autres".
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const OTHER_COLOR = '#6b7280';
const TOTAL_COLOR = '#10b981';
const PREV_COLOR = '#475569';
const MAX_SERIES = SERIES_COLORS.length;
const AXIS_COLOR = '#94a3b8';
const GRID_COLOR = 'rgba(148, 163, 184, 0.12)';
const SURFACE = '#141b34';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = (v, digits = 2) => Number.isFinite(v)
    ? v.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits })
    : '—';
const pct = (v, digits = 2) => Number.isFinite(v) ? `${v.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %` : '—';
const signedPct = v => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${pct(v, 1)}` : '—';
const trendClass = v => (Number.isFinite(v) ? (v >= 0 ? 'div-up' : 'div-down') : '');
const fmtDate = d => (d ? d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const fmtMonth = key => {
    const [y, m] = key.split('-');
    return m && !m.startsWith('T') ? `${MONTH_LABELS[Number(m) - 1]} ${y.slice(2)}` : key.replace('-', ' ');
};

function baseScales({ stacked = false, money = true } = {}) {
    return {
        x: { stacked, ticks: { color: AXIS_COLOR, maxRotation: 0, autoSkip: true, autoSkipPadding: 8 }, grid: { display: false } },
        y: {
            stacked, beginAtZero: true,
            ticks: { color: AXIS_COLOR, callback: v => (money ? `${Number(v).toLocaleString('fr-FR')} €` : v) },
            grid: { color: GRID_COLOR }, border: { display: false }
        }
    };
}

const moneyTooltip = {
    backgroundColor: '#0f172a',
    borderColor: '#2d3548',
    borderWidth: 1,
    padding: 10,
    callbacks: { label: ctx => `${ctx.dataset.label ? ctx.dataset.label + ' : ' : ''}${eur(ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed)}` }
};

export class DividendModal {
    constructor() {
        this.charts = {};
        this.state = { tab: 'evolution', granularity: 'month', mode: 'total', broker: '', sortKey: 'total', sortDir: -1, selectedTicker: null, search: '' };
        this.source = null;
        this.data = null;
        this.colorByTicker = new Map();
        this._bound = false;
    }

    /**
     * @param {Object} source { dividends, toEUR, holdings, brokerLabel, portfolioValue }
     */
    open(source) {
        this.source = source;
        this.state.selectedTicker = null;
        // Couleurs figées sur le classement global (non filtré).
        const global = buildDividendAnalytics(source.dividends, source);
        this.colorByTicker = new Map(global.assets.slice(0, MAX_SERIES).map((a, i) => [a.ticker.toUpperCase(), SERIES_COLORS[i]]));
        this._populateBrokerFilter(global.brokers);
        this._bindOnce();
        this._recompute();
    }

    _colorFor(ticker) {
        return this.colorByTicker.get(String(ticker).toUpperCase()) || OTHER_COLOR;
    }

    _populateBrokerFilter(brokers) {
        const select = document.getElementById('div-broker-filter');
        if (!select) return;
        const current = this.state.broker;
        select.innerHTML = '<option value="">Tous les courtiers</option>'
            + brokers.map(b => `<option value="${esc(b.broker)}">${esc(b.broker)}</option>`).join('');
        select.value = brokers.some(b => b.broker === current) ? current : '';
        this.state.broker = select.value;
        select.style.display = brokers.length > 1 ? '' : 'none';
    }

    _recompute() {
        const { dividends, brokerLabel = c => c } = this.source;
        const filtered = this.state.broker
            ? dividends.filter(d => (brokerLabel(d.broker || 'Inconnu') || d.broker || 'Inconnu') === this.state.broker)
            : dividends;
        this.data = buildDividendAnalytics(filtered, this.source);
        this._renderWarning();
        this._renderKpis();
        this._renderTab();
    }

    _bindOnce() {
        if (this._bound) return;
        this._bound = true;
        const modal = document.getElementById('dividend-detail-modal');
        if (!modal) return;

        modal.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-div-tab]');
            if (tab) { this.state.tab = tab.dataset.divTab; this._renderTab(); return; }

            const gran = e.target.closest('[data-granularity]');
            if (gran) { this.state.granularity = gran.dataset.granularity; this._renderEvolution(); return; }

            const mode = e.target.closest('[data-mode]');
            if (mode) { this.state.mode = mode.dataset.mode; this._renderEvolution(); return; }

            const sortTh = e.target.closest('#div-asset-table th[data-sort]');
            if (sortTh) {
                const key = sortTh.dataset.sort;
                this.state.sortDir = this.state.sortKey === key ? -this.state.sortDir : (key === 'ticker' || key === 'next' ? 1 : -1);
                this.state.sortKey = key;
                this._renderAssetTable();
                return;
            }

            if (e.target.closest('[data-div-close-detail]')) {
                this.state.selectedTicker = null;
                this._renderAssets();
                return;
            }

            const row = e.target.closest('tr[data-ticker]');
            if (row) {
                const t = row.dataset.ticker;
                this.state.selectedTicker = this.state.selectedTicker === t ? null : t;
                if (this.state.tab !== 'assets') this.state.tab = 'assets';
                this._renderTab();
                if (this.state.selectedTicker) document.getElementById('div-asset-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                return;
            }

            if (e.target.closest('#div-history-export')) this._exportCsv();
        });

        document.getElementById('div-broker-filter')?.addEventListener('change', (e) => {
            this.state.broker = e.target.value;
            this.state.selectedTicker = null;
            this._recompute();
        });
        document.getElementById('div-history-search')?.addEventListener('input', (e) => {
            this.state.search = e.target.value.trim().toLowerCase();
            this._renderHistory();
        });
    }

    _renderWarning() {
        const el = document.getElementById('div-warning');
        if (!el) return;
        const n = this.data.excludedCount;
        el.style.display = n ? '' : 'none';
        el.innerHTML = n
            ? `<i class="ph ph-warning" aria-hidden="true"></i> ${n} versement${n > 1 ? 's' : ''} exclu${n > 1 ? 's' : ''} des totaux : montant invalide ou taux de change historique indisponible.`
            : '';
    }

    _renderKpis() {
        const k = this.data.kpis;
        const tile = (icon, label, value, sub = '', title = '') => `
            <div class="div-kpi"${title ? ` title="${esc(title)}"` : ''}>
                <div class="div-kpi-label"><i class="ph ${icon}" aria-hidden="true"></i> ${label}</div>
                <div class="div-kpi-value">${value}</div>
                <div class="div-kpi-sub">${sub}</div>
            </div>`;
        const vsLabel = (growth, prev, label) => Number.isFinite(growth)
            ? `<span class="${trendClass(growth)}">${signedPct(growth)}</span> vs ${label} (${eur(prev, 0)})`
            : `Pas de comparaison ${label}`;

        document.getElementById('div-kpi-grid').innerHTML = [
            tile('ph-coins', 'Total perçu', eur(k.total), k.firstDate ? `${k.count} versements depuis ${fmtDate(k.firstDate)}` : 'Aucun versement'),
            tile('ph-calendar-check', '12 derniers mois', eur(k.ttm), vsLabel(k.ttmGrowthPct, k.prevTtm, '12 mois préc.')),
            tile('ph-calendar-blank', `Année ${new Date().getFullYear()}`, eur(k.ytd), vsLabel(k.ytdGrowthPct, k.prevYtd, 'même période N-1')),
            tile('ph-chart-line', 'Moyenne mensuelle', eur(k.monthlyAvg), k.bestMonth ? `Meilleur mois : ${fmtMonth(k.bestMonth.key)} (${eur(k.bestMonth.amount, 0)})` : '—'),
            tile('ph-rocket-launch', 'Revenu annuel projeté', eur(k.projectedAnnual), `soit ${eur(k.projectedMonthly)} / mois`, 'Pour chaque actif encore détenu : moyenne de ses derniers versements × fréquence observée (mensuel, trimestriel…).'),
            tile('ph-target', 'Rendement sur PRU', pct(k.yieldOnCost), 'Revenu projeté / montant investi', 'Yield on cost : revenu annuel projeté rapporté au coût d’acquisition des actifs payeurs détenus.'),
            tile('ph-percent', 'Rendement actuel', pct(k.currentYield), Number.isFinite(k.portfolioYield) ? `${pct(k.portfolioYield)} du portefeuille total` : 'Revenu projeté / valeur actuelle', 'Revenu annuel projeté rapporté à la valeur de marché actuelle des actifs payeurs détenus.'),
            tile('ph-buildings', 'Actifs payeurs', `${k.heldPayerCount} <span style="font-size:13px;font-weight:500;color:var(--text-muted);">/ ${k.payerCount}</span>`, 'encore détenus / au total')
        ].join('');
    }

    _renderTab() {
        document.querySelectorAll('#dividend-detail-modal [data-div-tab]').forEach(b => b.classList.toggle('active', b.dataset.divTab === this.state.tab));
        document.querySelectorAll('#dividend-detail-modal [data-div-panel]').forEach(p => { p.hidden = p.dataset.divPanel !== this.state.tab; });
        if (this.state.tab === 'evolution') this._renderEvolution();
        else if (this.state.tab === 'assets') this._renderAssets();
        else if (this.state.tab === 'seasonality') this._renderSeasonality();
        else if (this.state.tab === 'forecast') this._renderForecast();
        else if (this.state.tab === 'history') this._renderHistory();
    }

    _chart(key, canvasId, config) {
        this.charts[key]?.destroy();
        const el = document.getElementById(canvasId);
        if (!el || typeof Chart === 'undefined') return null;
        this.charts[key] = new Chart(el.getContext('2d'), config);
        return this.charts[key];
    }

    _empty(canvasId, key) {
        this.charts[key]?.destroy();
        this.charts[key] = null;
        const el = document.getElementById(canvasId);
        if (el) el.getContext('2d').clearRect(0, 0, el.width, el.height);
    }

    // ---------- Évolution ----------
    _renderEvolution() {
        const { granularity, mode } = this.state;
        document.querySelectorAll('#div-granularity button').forEach(b => b.classList.toggle('active', b.dataset.granularity === granularity));
        document.querySelectorAll('#div-evo-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

        const legend = document.getElementById('div-evo-legend');
        const payments = this.data.payments;
        if (!payments.length) {
            this._empty('dividend-evolution-chart', 'evolution');
            legend.innerHTML = '<div class="div-empty">Aucun dividende enregistré.</div>';
        } else {
            const tickers = new Set(this.colorByTicker.keys());
            const series = aggregateByPeriod(payments, granularity, { tickers });
            const labels = series.labels.map(fmtMonth);
            let datasets;
            let stacked = false;
            legend.innerHTML = '';

            if (mode === 'stacked') {
                stacked = true;
                const keys = [...series.byAsset.keys()].sort((a, b) => {
                    const order = k => (k === '__other__' ? 99 : SERIES_COLORS.indexOf(this._colorFor(k)));
                    return order(a) - order(b);
                });
                datasets = keys.map(key => {
                    const asset = this.data.assets.find(a => a.ticker.toUpperCase() === key);
                    const color = key === '__other__' ? OTHER_COLOR : this._colorFor(key);
                    return {
                        label: key === '__other__' ? 'Autres' : (asset?.ticker || key),
                        data: series.byAsset.get(key),
                        backgroundColor: color,
                        borderColor: SURFACE,
                        borderWidth: { top: 1, bottom: 0, left: 0, right: 0 },
                        borderRadius: 3,
                        borderSkipped: 'bottom'
                    };
                });
                legend.innerHTML = datasets.map(d => `<span><i class="sw" style="background:${d.backgroundColor}"></i>${esc(d.label)}</span>`).join('');
            } else if (mode === 'cumulative') {
                let run = 0;
                datasets = [{
                    label: 'Cumul perçu',
                    data: series.total.map(v => (run += v)),
                    borderColor: TOTAL_COLOR,
                    backgroundColor: 'rgba(16, 185, 129, 0.12)',
                    fill: true, tension: 0.25, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5,
                    type: 'line'
                }];
            } else {
                datasets = [{ label: 'Dividendes', data: series.total, backgroundColor: TOTAL_COLOR, borderRadius: 4, maxBarThickness: 48 }];
            }

            this._chart('evolution', 'dividend-evolution-chart', {
                type: mode === 'cumulative' ? 'line' : 'bar',
                data: { labels, datasets },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            ...moneyTooltip,
                            filter: item => item.parsed.y > 0,
                            itemSort: (a, b) => b.parsed.y - a.parsed.y,
                            callbacks: {
                                ...moneyTooltip.callbacks,
                                footer: items => (stacked && items.length > 1 ? `Total : ${eur(items.reduce((s, i) => s + i.parsed.y, 0))}` : '')
                            }
                        }
                    },
                    scales: baseScales({ stacked })
                }
            });
        }
        this._renderYearlyTable();
        this._renderBrokers();
    }

    _renderYearlyTable() {
        const el = document.getElementById('div-yearly-table');
        const rows = [...this.data.seasonality].reverse();
        if (!rows.length) { el.innerHTML = '<tbody><tr><td class="div-empty">—</td></tr></tbody>'; return; }
        const now = new Date();
        el.innerHTML = `<thead><tr><th>Année</th><th class="num">Total</th><th class="num">Moy./mois</th><th class="num">Variation</th></tr></thead><tbody>`
            + rows.map((r, i) => {
                const prev = rows[i + 1];
                const growth = prev && prev.total > 0 ? ((r.total - prev.total) / prev.total) * 100 : null;
                const months = r.year === now.getFullYear() ? now.getMonth() + 1 : 12;
                const ongoing = r.year === now.getFullYear() ? ' <span class="div-badge">en cours</span>' : '';
                return `<tr><td>${r.year}${ongoing}</td><td class="num">${eur(r.total)}</td><td class="num">${eur(r.total / months)}</td><td class="num ${trendClass(growth)}">${signedPct(growth)}</td></tr>`;
            }).join('') + '</tbody>';
    }

    _renderBrokers() {
        const el = document.getElementById('div-broker-breakdown');
        const brokers = this.data.brokers;
        const total = this.data.kpis.total;
        el.innerHTML = brokers.length
            ? brokers.map(b => `
                <div class="div-bar-row">
                    <span>${esc(b.broker)}</span>
                    <div class="div-bar-track"><div class="div-bar-fill" style="width:${total > 0 ? (b.amount / total) * 100 : 0}%"></div></div>
                    <span style="font-variant-numeric:tabular-nums;">${eur(b.amount)} <span class="div-hint">${pct(total > 0 ? (b.amount / total) * 100 : 0, 0)}</span></span>
                </div>`).join('')
            : '<div class="div-empty">—</div>';
    }

    // ---------- Par actif ----------
    _renderAssets() {
        const assets = this.data.assets;
        if (!assets.length) {
            this._empty('div-asset-share-chart', 'share');
            this._empty('div-asset-growth-chart', 'growth');
        } else {
            const top = assets.slice(0, MAX_SERIES).filter(a => this.colorByTicker.has(a.ticker.toUpperCase()));
            const topSet = new Set(top.map(a => a.ticker));
            const others = assets.filter(a => !topSet.has(a.ticker));
            const shareItems = [...top.map(a => ({ label: a.ticker, value: a.total, color: this._colorFor(a.ticker) }))];
            if (others.length) shareItems.push({ label: `Autres (${others.length})`, value: others.reduce((s, a) => s + a.total, 0), color: OTHER_COLOR });

            this._chart('share', 'div-asset-share-chart', {
                type: 'doughnut',
                data: {
                    labels: shareItems.map(i => i.label),
                    datasets: [{ data: shareItems.map(i => i.value), backgroundColor: shareItems.map(i => i.color), borderColor: SURFACE, borderWidth: 2 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, cutout: '62%',
                    plugins: {
                        legend: { position: 'right', labels: { color: AXIS_COLOR, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
                        tooltip: { ...moneyTooltip, callbacks: { label: ctx => `${ctx.label} : ${eur(ctx.parsed)} (${pct(this.data.kpis.total > 0 ? ctx.parsed / this.data.kpis.total * 100 : 0, 1)})` } }
                    }
                }
            });

            const growthAssets = assets.filter(a => a.ttm > 0 || a.prevTtm > 0).sort((a, b) => b.ttm - a.ttm).slice(0, 12);
            this._chart('growth', 'div-asset-growth-chart', {
                type: 'bar',
                data: {
                    labels: growthAssets.map(a => a.ticker),
                    datasets: [
                        { label: '12 mois précédents', data: growthAssets.map(a => a.prevTtm), backgroundColor: PREV_COLOR, borderRadius: 3, maxBarThickness: 18 },
                        { label: '12 derniers mois', data: growthAssets.map(a => a.ttm), backgroundColor: TOTAL_COLOR, borderRadius: 3, maxBarThickness: 18 }
                    ]
                },
                options: {
                    indexAxis: 'y', responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false, axis: 'y' },
                    plugins: {
                        legend: { position: 'bottom', labels: { color: AXIS_COLOR, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
                        tooltip: { ...moneyTooltip, callbacks: { label: ctx => `${ctx.dataset.label} : ${eur(ctx.parsed.x)}` } }
                    },
                    scales: {
                        x: { beginAtZero: true, ticks: { color: AXIS_COLOR, callback: v => `${Number(v).toLocaleString('fr-FR')} €` }, grid: { color: GRID_COLOR }, border: { display: false } },
                        y: { ticks: { color: AXIS_COLOR }, grid: { display: false } }
                    }
                }
            });
        }
        this._renderAssetTable();
        this._renderAssetDetail();
    }

    _renderAssetTable() {
        const el = document.getElementById('div-asset-table');
        const { sortKey, sortDir, selectedTicker } = this.state;
        const value = (a) => ({
            ticker: a.ticker.toLowerCase(), total: a.total, ttm: a.ttm, growth: a.growthPct ?? -Infinity,
            count: a.count, first: a.first.getTime(), last: a.last.getTime(), frequency: a.frequencyPerYear ?? 0,
            projected: a.projectedAnnual, yoc: a.yieldOnCost ?? -Infinity, yield: a.currentYield ?? -Infinity,
            share: a.sharePct, next: a.nextExpected ? a.nextExpected.getTime() : Infinity
        }[sortKey]);
        const assets = [...this.data.assets].sort((a, b) => {
            const va = value(a), vb = value(b);
            return (va < vb ? -1 : va > vb ? 1 : 0) * sortDir;
        });
        if (!assets.length) { el.innerHTML = '<tbody><tr><td class="div-empty">Aucun actif n’a versé de dividende.</td></tr></tbody>'; return; }

        const th = (key, label, num = true, title = '') => {
            const arrow = sortKey === key ? (sortDir > 0 ? ' ▲' : ' ▼') : '';
            return `<th data-sort="${key}" class="${num ? 'num' : ''}"${title ? ` title="${esc(title)}"` : ''}>${label}${arrow}</th>`;
        };
        el.innerHTML = `<thead><tr>
                ${th('ticker', 'Actif', false)}
                ${th('total', 'Total perçu')}
                ${th('share', 'Part')}
                ${th('ttm', '12 mois')}
                ${th('growth', 'Évol.', true, '12 derniers mois vs 12 mois précédents')}
                ${th('count', 'Versements')}
                ${th('frequency', 'Fréquence', false)}
                ${th('first', 'Depuis', false)}
                ${th('last', 'Dernier', false)}
                ${th('projected', 'Projeté/an')}
                ${th('yoc', 'Rdt PRU', true, 'Revenu projeté / montant investi')}
                ${th('yield', 'Rdt actuel', true, 'Revenu projeté / valeur actuelle')}
                ${th('next', 'Prochain (est.)', false)}
            </tr></thead><tbody>`
            + assets.map(a => `
                <tr class="clickable${selectedTicker === a.ticker ? ' selected' : ''}" data-ticker="${esc(a.ticker)}">
                    <td><div class="div-asset-cell"><i class="sw" style="background:${this._colorFor(a.ticker)}"></i>
                        <div><strong>${esc(a.ticker)}</strong> ${a.held ? '' : '<span class="div-badge">soldé</span>'}<span class="div-asset-name" title="${esc(a.name)}">${esc(a.name)}</span></div></div></td>
                    <td class="num"><strong>${eur(a.total)}</strong></td>
                    <td class="num">${pct(a.sharePct, 1)}</td>
                    <td class="num">${eur(a.ttm)}</td>
                    <td class="num ${trendClass(a.growthPct)}">${signedPct(a.growthPct)}</td>
                    <td class="num">${a.count}</td>
                    <td>${a.frequency}</td>
                    <td>${fmtDate(a.first)}</td>
                    <td>${fmtDate(a.last)}</td>
                    <td class="num">${a.held ? eur(a.projectedAnnual) : '—'}</td>
                    <td class="num">${pct(a.yieldOnCost)}</td>
                    <td class="num">${pct(a.currentYield)}</td>
                    <td>${a.nextExpected ? fmtDate(a.nextExpected) : '—'}</td>
                </tr>`).join('') + '</tbody>';
    }

    _renderAssetDetail() {
        const box = document.getElementById('div-asset-detail');
        const asset = this.data.assets.find(a => a.ticker === this.state.selectedTicker);
        if (!asset) { box.hidden = true; this._empty('div-asset-detail-chart', 'detail'); return; }
        box.hidden = false;
        const color = this._colorFor(asset.ticker);
        const years = Object.keys(asset.byYear).sort();
        box.innerHTML = `
            <div class="div-detail-head">
                <div class="div-asset-cell"><i class="sw" style="background:${color}"></i>
                    <div><h4 style="margin:0;">${esc(asset.ticker)} — ${esc(asset.name)}</h4>
                    <span class="div-hint">${asset.held ? '<span class="div-badge held">En portefeuille</span>' : '<span class="div-badge">Position soldée</span>'} · ${asset.frequency} · ${asset.count} versements du ${fmtDate(asset.first)} au ${fmtDate(asset.last)}</span></div>
                </div>
                <button class="modal-close" data-div-close-detail aria-label="Fermer le détail" style="font-size:20px;">×</button>
            </div>
            <div class="div-detail-stats">
                <div><small>Total perçu</small><strong>${eur(asset.total)}</strong></div>
                <div><small>12 derniers mois</small><strong>${eur(asset.ttm)}</strong> <span class="${trendClass(asset.growthPct)}" style="font-size:12px;">${signedPct(asset.growthPct)}</span></div>
                <div><small>Versement moyen</small><strong>${eur(asset.avgAmount)}</strong></div>
                <div><small>Dernier versement</small><strong>${eur(asset.lastAmount)}</strong></div>
                <div><small>Projeté / an</small><strong>${asset.held ? eur(asset.projectedAnnual) : '—'}</strong></div>
                <div><small>Rendement sur PRU</small><strong>${pct(asset.yieldOnCost)}</strong></div>
                <div><small>Rendement actuel</small><strong>${pct(asset.currentYield)}</strong></div>
                <div><small>Prochain versement (est.)</small><strong>${asset.nextExpected ? fmtDate(asset.nextExpected) : '—'}</strong></div>
            </div>
            <div class="div-subgrid" style="margin-top:0;">
                <div><h4>Chaque versement</h4><div class="div-chart-box" style="height:220px;"><canvas id="div-asset-detail-chart"></canvas></div></div>
                <div><h4>Par année</h4><div class="div-chart-box" style="height:220px;"><canvas id="div-asset-year-chart"></canvas></div></div>
            </div>`;

        this._chart('detail', 'div-asset-detail-chart', {
            type: 'bar',
            data: {
                labels: asset.payments.map(p => fmtDate(p.date)),
                datasets: [{ label: asset.ticker, data: asset.payments.map(p => p.amount), backgroundColor: color, borderRadius: 4, maxBarThickness: 32 }]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { ...moneyTooltip, callbacks: { label: ctx => eur(ctx.parsed.y), afterLabel: ctx => asset.payments[ctx.dataIndex].broker } } },
                scales: baseScales()
            }
        });
        this._chart('detailYear', 'div-asset-year-chart', {
            type: 'bar',
            data: { labels: years, datasets: [{ label: asset.ticker, data: years.map(y => asset.byYear[y]), backgroundColor: color, borderRadius: 4, maxBarThickness: 48 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false }, tooltip: { ...moneyTooltip, callbacks: { label: ctx => eur(ctx.parsed.y) } } },
                scales: baseScales()
            }
        });
    }

    // ---------- Saisonnalité ----------
    _renderSeasonality() {
        const seasons = this.data.seasonality;
        if (!seasons.length) {
            this._empty('div-season-chart', 'season');
        } else {
            // Années récentes en couleurs pleines (ordre fixe), anciennes en gris.
            const recent = seasons.slice(-MAX_SERIES);
            this._chart('season', 'div-season-chart', {
                type: 'bar',
                data: {
                    labels: MONTH_LABELS,
                    datasets: recent.map((s, i) => ({
                        label: String(s.year), data: s.months,
                        backgroundColor: SERIES_COLORS[i], borderRadius: 3, maxBarThickness: 22
                    }))
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'bottom', labels: { color: AXIS_COLOR, boxWidth: 10, boxHeight: 10 } },
                        tooltip: moneyTooltip
                    },
                    scales: baseScales()
                }
            });
        }

        // Heatmap actif × mois (séquentielle, une seule teinte).
        const el = document.getElementById('div-heatmap');
        const assets = this.data.assets;
        if (!assets.length) { el.innerHTML = '<div class="div-empty">—</div>'; return; }
        const max = Math.max(...assets.flatMap(a => a.byMonthOfYear), 0);
        const totalsByMonth = Array(12).fill(0);
        assets.forEach(a => a.byMonthOfYear.forEach((v, i) => { totalsByMonth[i] += v; }));
        const cell = v => {
            if (!(v > 0)) return '<td class="cell" style="color:var(--text-muted);">·</td>';
            const t = max > 0 ? v / max : 0;
            const alpha = (0.18 + 0.72 * Math.sqrt(t)).toFixed(2);
            return `<td class="cell" style="background:rgba(57,135,229,${alpha});" title="${eur(v)}">${Math.round(v).toLocaleString('fr-FR')}</td>`;
        };
        el.innerHTML = `<table class="div-table div-heat">
            <thead><tr><th>Actif</th>${MONTH_LABELS.map(m => `<th class="num" style="text-align:center;">${m}</th>`).join('')}<th class="num">Total</th></tr></thead>
            <tbody>${assets.map(a => `<tr class="clickable" data-ticker="${esc(a.ticker)}"><td><div class="div-asset-cell"><i class="sw" style="background:${this._colorFor(a.ticker)}"></i><strong>${esc(a.ticker)}</strong></div></td>${a.byMonthOfYear.map(cell).join('')}<td class="num">${eur(a.total, 0)}</td></tr>`).join('')}
            <tr><td><strong>Total</strong></td>${totalsByMonth.map(v => `<td class="cell"><strong>${v > 0 ? Math.round(v).toLocaleString('fr-FR') : '·'}</strong></td>`).join('')}<td class="num"><strong>${eur(this.data.kpis.total, 0)}</strong></td></tr>
            </tbody></table>`;
    }

    // ---------- Prévisionnel ----------
    _renderForecast() {
        const months = this.data.forecastMonths;
        const hasData = months.some(m => m.amount > 0);
        if (!hasData) this._empty('div-forecast-chart', 'forecast');
        else {
            // Comparaison avec le même mois de l'année précédente (réalisé).
            const realized = new Map();
            this.data.payments.forEach(p => { const k = monthKey(p.date); realized.set(k, (realized.get(k) || 0) + p.amount); });
            const prevYearKey = key => { const [y, m] = key.split('-'); return `${Number(y) - 1}-${m}`; };
            this._chart('forecast', 'div-forecast-chart', {
                type: 'bar',
                data: {
                    labels: months.map(m => fmtMonth(m.key)),
                    datasets: [
                        { label: 'Perçu un an plus tôt', data: months.map(m => realized.get(prevYearKey(m.key)) || 0), backgroundColor: PREV_COLOR, borderRadius: 3, maxBarThickness: 22 },
                        { label: 'Estimé', data: months.map(m => m.amount), backgroundColor: TOTAL_COLOR, borderRadius: 3, maxBarThickness: 22 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: { legend: { position: 'bottom', labels: { color: AXIS_COLOR, boxWidth: 10, boxHeight: 10 } }, tooltip: moneyTooltip },
                    scales: baseScales()
                }
            });
        }

        const el = document.getElementById('div-upcoming-table');
        const upcoming = this.data.upcoming;
        const total = upcoming.reduce((s, u) => s + u.amount, 0);
        el.innerHTML = upcoming.length
            ? `<thead><tr><th>Date estimée</th><th>Actif</th><th>Fréquence</th><th class="num">Montant estimé</th></tr></thead><tbody>`
                + upcoming.map(u => `<tr class="clickable" data-ticker="${esc(u.ticker)}"><td>${fmtDate(u.date)}</td><td><div class="div-asset-cell"><i class="sw" style="background:${this._colorFor(u.ticker)}"></i><strong>${esc(u.ticker)}</strong> <span class="div-asset-name">${esc(u.name)}</span></div></td><td>${u.frequency}</td><td class="num">${eur(u.amount)}</td></tr>`).join('')
                + `<tr><td colspan="3"><strong>Total 12 mois</strong></td><td class="num"><strong>${eur(total)}</strong></td></tr></tbody>`
            : '<tbody><tr><td class="div-empty">Pas assez d’historique pour estimer les prochains versements (au moins 2 versements par actif détenu).</td></tr></tbody>';
    }

    // ---------- Historique ----------
    _filteredPayments() {
        const q = this.state.search;
        const rows = [...this.data.payments].reverse();
        return q ? rows.filter(p => `${p.ticker} ${p.name} ${p.broker}`.toLowerCase().includes(q)) : rows;
    }

    _renderHistory() {
        const el = document.getElementById('div-history-table');
        const rows = this._filteredPayments();
        const total = rows.reduce((s, p) => s + p.amount, 0);
        el.innerHTML = rows.length
            ? `<thead><tr><th>Date</th><th>Actif</th><th>Courtier</th><th class="num">Montant</th></tr></thead><tbody>`
                + rows.map(p => `<tr class="clickable" data-ticker="${esc(p.ticker)}"><td>${fmtDate(p.date)}</td><td><div class="div-asset-cell"><i class="sw" style="background:${this._colorFor(p.ticker)}"></i><strong>${esc(p.ticker)}</strong> <span class="div-asset-name">${esc(p.name)}</span></div></td><td>${esc(p.broker)}</td><td class="num">${eur(p.amount)}</td></tr>`).join('')
                + `<tr><td colspan="3"><strong>${rows.length} versements</strong></td><td class="num"><strong>${eur(total)}</strong></td></tr></tbody>`
            : '<tbody><tr><td class="div-empty">Aucun versement.</td></tr></tbody>';
    }

    _exportCsv() {
        const rows = this._filteredPayments();
        const cell = v => `"${String(v).replace(/"/g, '""')}"`;
        const csv = ['Date;Ticker;Nom;Courtier;Montant EUR']
            .concat(rows.map(p => [p.date.toISOString().slice(0, 10), p.ticker, p.name, p.broker, p.amount.toFixed(2).replace('.', ',')].map(cell).join(';')))
            .join('\r\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `dividendes-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
}
