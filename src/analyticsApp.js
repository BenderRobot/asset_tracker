// ========================================
// analyticsApp.js - (v2 - Avec MarketStatus)
// ========================================

import { Storage } from './storage.js';
import { formatCurrency, formatPercent } from './utils.js';

// === CHANGEMENT 1 : Importer les nouvelles dépendances ===
import { PriceAPI } from './api.js';
import { DataManager } from './dataManager.js';
import { DividendManager } from './dividendManager.js'; // NEW: Import Dividend Manager
// AJOUT : Importer MarketStatus (avec le cache buster)
import { MarketStatus } from './marketStatus.js?v=2';
import { fetchGeminiDiversificationAdvice } from './geminiService.js'; // Import Gemini AI
import { getBrokersSync, populateSelect } from './brokerService.js';

class AnalyticsApp {
    constructor() {
        // === CHANGEMENT 2 : Construire la chaîne complète ===
        this.storage = new Storage();
        this.api = new PriceAPI(this.storage); // <-- NÉCESSAIRE
        this.dataManager = new DataManager(this.storage, this.api); // <-- NÉCESSAIRE

        // AJOUT : Initialiser MarketStatus
        this.marketStatus = new MarketStatus(this.storage);
        this.dividendManager = new DividendManager(this.storage, this.dataManager);

        this.allocationChart = null;
    }

    async init() {
        console.log('📊 Initialisation Analytics...');

        // AJOUT : Démarrer l'auto-refresh du statut marché
        this.marketStatus.startAutoRefresh('market-status-container', 'full');

        // === CHANGEMENT 3 : Rafraîchir les prix avant de rendre ===
        // (Optionnel, mais garantit des données à jour à l'ouverture)
        try {
            const purchases = this.storage.getPurchases();
            // FILTER: Real Estate assets don't have market prices
            const tickers = [...new Set(purchases
                .filter(p => {
                    const type = (p.assetType || 'Stock').toLowerCase();
                    return type !== 'cash' && type !== 'dividend' && p.type !== 'dividend' && type !== 'real estate';
                })
                .map(p => p.ticker.toUpperCase()))];

            if (tickers.length > 0) {
                console.log('📊 Rafraîchissement des prix pour les analyses...');
                await this.api.fetchBatchPrices(tickers);
            }
        } catch (e) {
            console.error("Erreur de rafraîchissement initial des prix:", e);
        }
        // =======================================================

        await this.render();
        this.setupEventListeners();

        // Populer le filtre broker dynamiquement
        populateSelect(
            document.getElementById('allocation-broker-filter'),
            { includeAll: 'Tous les courtiers', includeAdd: false }
        );

        console.log('✅ Analytics prêt');
    }

    // ... (Le reste de votre fichier analyticsApp.js est inchangé) ...
    // render()
    // updateSummary()
    // updatePerformance()
    // etc...

    // (Collez le reste de votre fichier analyticsApp.js ici)
    async render() {
        // Get purchases and generate report using dataManager
        const purchases = this.storage.getPurchases();
        const report = this.dataManager.generateFullReport(purchases);

        // Store report for modals to access
        this.lastReport = report;

        console.log('📊 Rapport:', report);

        // Résumé
        this.updateSummary(report.summary);
        // ... (le reste de la fonction est inchangé)
        this.updatePerformance(report.performance);
        this.updateDiversification(report.diversification);
        this.updateRisk(report.risk);
        this.updatePerformers(report.performance);
        this.renderAllocationChart(report.assets);
        this.updateAssetAllocations(report.assets);  // NEW: Asset Allocations Treemap

        // NOUVEAU: Passive Income
        const passiveIncome = await this.calculatePassiveIncome();
        this.updatePassiveIncome(passiveIncome);

        // NOUVEAU: Investment Timeline
        this.renderInvestmentTimeline('monthly');
    }

    // ... (TOUT LE RESTE DU FICHIER : updateSummary, updatePerformance, ... est INCHANGÉ) ...

    updateSummary(summary) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        // Total Value: assets (incl. RE) + cash deposits only (matches investments page + RE)
        const dividends = summary.dividendsReceived || 0;
        const displayValue = summary.totalValue + (summary.cashReserve || 0) - dividends;
        setValue('total-value', this.formatEUR(displayValue));
        setValue('total-invested', `Invested: ${this.formatEUR(summary.totalInvested)}`);

        // Total Return: matches investments page formula (financial gain - dividends + RE gain)
        const displayReturn = summary.totalGain - dividends;
        const returnEl = document.getElementById('total-return');
        if (returnEl) {
            returnEl.textContent = this.formatEUR(displayReturn);
            returnEl.style.color = displayReturn >= 0 ? '#10b981' : '#ef4444';
        }

        const pctEl = document.getElementById('return-pct');
        if (pctEl) {
            const displayReturnPct = summary.totalInvested > 0 ? (displayReturn / summary.totalInvested) * 100 : 0;
            pctEl.textContent = this.formatPct(displayReturnPct);
            pctEl.style.color = displayReturnPct >= 0 ? '#10b981' : '#ef4444';
        }

        // Update Win Rate from summary
        setValue('win-rate', summary.winRate + '%');
    }

    updatePerformance(performance) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('avg-gain', performance.avgGain + '%');
        setValue('winners-count', performance.winners);
        setValue('losers-count', performance.losers);
        setValue('win-rate', performance.winRate + '%');
        setValue('performance-summary', performance.summary);
    }

    updateDiversification(diversification) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('diversity-score', diversification.diversityScore + '/100');
        setValue('effective-assets', diversification.effectiveAssets);
        setValue('total-assets', diversification.totalAssets);
        setValue('diversity-recommendation', diversification.recommendation);
    }

    updateRisk(risk) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        setValue('volatility', risk.volatility + '%');
        setValue('max-drawdown', risk.maxDrawdown + '%');

        const levelEl = document.getElementById('risk-level');
        if (levelEl) {
            levelEl.textContent = risk.riskLevel;
            levelEl.className = 'metric-value risk-badge';

            if (risk.riskLevel === 'Faible') {
                levelEl.classList.add('risk-low');
            } else if (risk.riskLevel === 'Modéré') {
                levelEl.classList.add('risk-moderate');
            } else {
                levelEl.classList.add('risk-high');
            }
        }

        setValue('risk-recommendation', risk.recommendation);
    }

    async calculatePassiveIncome() {
        const purchases = this.storage.getPurchases();

        // 1. Dividendes RÉELS (Basés sur l'historique des transactions)
        // On ne fait plus d'estimation, on prend ce qui est en base.
        let totalRealizedDividends = 0;
        const dividendsByBroker = {};

        // Pour la moyenne mensuelle
        let firstDividendDate = new Date();
        let hasDividends = false;

        // Mapping dynamique des codes courtiers vers noms lisibles
        const brokerMap = {};
        getBrokersSync().forEach(b => { brokerMap[b.value] = b.label; });

        const dividendTransactions = purchases.filter(p => p.type === 'dividend');

        dividendTransactions.forEach(div => {
            const amount = parseFloat(div.price) || parseFloat(div.quantity) || 0;
            const date = new Date(div.date);

            if (amount > 0) {
                totalRealizedDividends += amount;
                hasDividends = true;

                if (date < firstDividendDate) {
                    firstDividendDate = date;
                }

                const brokerCode = div.broker || 'Unknown';
                const brokerName = brokerMap[brokerCode] || brokerCode;

                if (!dividendsByBroker[brokerName]) {
                    dividendsByBroker[brokerName] = 0;
                }
                dividendsByBroker[brokerName] += amount;
            }
        });

        // Calcul Moyenne Mensuelle
        let monthlyAverage = 0;
        if (hasDividends) {
            const today = new Date();
            // Nombre de mois écoulés depuis le premier dividende
            const monthsDiff = (today.getFullYear() - firstDividendDate.getFullYear()) * 12 + (today.getMonth() - firstDividendDate.getMonth()) + 1; // +1 pour inclure le mois courant
            const activeMonths = Math.max(1, monthsDiff);
            monthlyAverage = totalRealizedDividends / activeMonths;
        }

        // 2. Intérêts Immo (Simple Interest Annualized) & Accrued
        let estRealEstateInterests = 0;
        let accruedRealEstateInterests = 0; // Ce qui est déjà gagné

        const reProjects = purchases.filter(p => p.assetType === 'Real Estate');
        reProjects.forEach(p => {
            const invested = p.price * p.quantity;
            const yieldPct = p.yield || 0;

            // Revenu annuel théorique = Investi * Yield
            estRealEstateInterests += (invested * (yieldPct / 100));

            // Gain Latent (Acquis)
            const startDate = new Date(p.date);
            const today = new Date();
            const daysHeld = Math.max(0, (today - startDate) / (1000 * 60 * 60 * 24));
            const accrued = invested * (yieldPct / 100) * (daysHeld / 365);
            accruedRealEstateInterests += accrued;
        });

        return {
            dividendsRealized: totalRealizedDividends,
            dividendsMonthlyAvg: monthlyAverage,
            dividendsByBroker: dividendsByBroker, // Object { 'Revolut': 50, 'Trade Republic': 20 }
            realEstate: estRealEstateInterests,
            realEstateAccrued: accruedRealEstateInterests,
            total: totalRealizedDividends + estRealEstateInterests // Total Mixed (Realized Divs + Projected Immo ? Un peu bizarre mais bon pour l'instant)
        };
    }

    updatePassiveIncome(data) {
        const setValue = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        // Carte Dividendes (REALIZED)
        setValue('realized-dividends-total', this.formatEUR(data.dividendsRealized));
        setValue('realized-dividends-monthly', this.formatEUR(data.dividendsMonthlyAvg));

        // Liste des courtiers
        const brokerListEl = document.getElementById('dividend-broker-list');
        if (brokerListEl) {
            if (Object.keys(data.dividendsByBroker).length > 0) {
                const html = Object.entries(data.dividendsByBroker)
                    .sort((a, b) => b[1] - a[1]) // Tri décroissant par montant
                    .map(([name, amount]) => `
                        <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px;">
                            <span style="color: var(--text-secondary); opacity:0.8;">${name}</span>
                            <span style="font-weight: 500; color: var(--text-primary);">${this.formatEUR(amount)}</span>
                        </div>
                    `).join('');
                brokerListEl.innerHTML = html;
            } else {
                brokerListEl.innerHTML = '<p style="font-size:12px; color:var(--text-muted); text-align:center;">Aucun dividende enregistré</p>';
            }
        }

        // Carte Immobilier
        setValue('passive-realestate', this.formatEUR(data.realEstate));
        setValue('passive-realestate-accrued', this.formatEUR(data.realEstateAccrued));

        const reMonthly = document.getElementById('passive-realestate-monthly');
        if (reMonthly) reMonthly.innerHTML = `Mensuel (Lissé): <strong>${this.formatEUR(data.realEstate / 12)}</strong>`;
    }

    updatePerformance(performance) {
        // Populate Performance Card KPIs
        document.getElementById('avg-gain').textContent = performance.avgGain + '%';
        document.getElementById('avg-gain').style.color = parseFloat(performance.avgGain) >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('win-rate-card').textContent = performance.winRate + '%';

        document.getElementById('winners-count').textContent = performance.winners;
        document.getElementById('losers-count').textContent = performance.losers;
    }

    updatePerformers(performance) {
        const topEl = document.getElementById('top-performers');
        if (topEl && performance.topPerformers.length > 0) {
            topEl.innerHTML = performance.topPerformers.map(asset => `
                <div class="performer-item">
                    <div>
                        <div class="performer-ticker">${asset.ticker}</div>
                        <div style="font-size: 12px; color: var(--text-muted);">${asset.name}</div>
                    </div>
                    <div class="performer-gain" style="color: #10b981;">
                        +${asset.gainPct.toFixed(2)}%
                    </div>
                </div>
            `).join('');
        } else if (topEl) {
            topEl.innerHTML = '<p style="color: var(--text-muted); text-align: center;">Aucune donnée</p>';
        }

        const worstEl = document.getElementById('worst-performers');
        if (worstEl && performance.worstPerformers.length > 0) {
            worstEl.innerHTML = performance.worstPerformers.map(asset => `
                <div class="performer-item">
                    <div>
                        <div class="performer-ticker">${asset.ticker}</div>
                        <div style="font-size: 12px; color: var(--text-muted);">${asset.name}</div>
                    </div>
                    <div class="performer-gain" style="color: #ef4444;">
                        ${asset.gainPct.toFixed(2)}%
                    </div>
                </div>
            `).join('');
        } else if (worstEl) {
            worstEl.innerHTML = '<p style="color: var(--text-muted); text-align: center;">Aucune donnée</p>';
        }
    }

    updateAssetAllocations(assets) {
        const svg = d3.select('#treemap-container');
        if (!svg.node() || !assets || assets.length === 0) return;

        // Filter valid assets
        const validAssets = assets.filter(a => a.currentValue && a.currentValue > 0);
        if (validAssets.length === 0) {
            svg.selectAll('*').remove();
            svg.append('text')
                .attr('x', '50%')
                .attr('y', '50%')
                .attr('text-anchor', 'middle')
                .attr('fill', 'var(--text-muted)')
                .text('Aucune donnée disponible');
            return;
        }

        // Get SVG dimensions
        const width = svg.node().clientWidth || 800;
        const height = 400;

        // Clear previous content
        svg.selectAll('*').remove();

        // Create hierarchy from data
        const root = d3.hierarchy({
            children: validAssets.map(asset => ({
                ticker: asset.ticker,
                name: asset.name,
                value: asset.currentValue,
                ...asset
            }))
        })
            .sum(d => d.value)
            .sort((a, b) => b.value - a.value);

        // Create treemap layout
        d3.treemap()
            .size([width, height])
            .padding(2)
            .round(true)
            (root);

        // Create cells
        const cell = svg.selectAll('g')
            .data(root.leaves())
            .join('g')
            .attr('transform', d => `translate(${d.x0},${d.y0})`);

        // Add rectangles
        cell.append('rect')
            .attr('width', d => d.x1 - d.x0)
            .attr('height', d => d.y1 - d.y0)
            .attr('fill', d => this.getColorFromDayChange(d.data.dayPct || 0))
            .attr('stroke', '#1e293b')
            .attr('stroke-width', 1.5)
            .attr('rx', 6)
            .style('cursor', 'pointer')
            .on('mouseover', function () {
                d3.select(this).attr('opacity', 0.8);
            })
            .on('mouseout', function () {
                d3.select(this).attr('opacity', 1);
            });

        // Add ticker/name text (centered vertically)
        const self = this; // Store reference to AnalyticsApp instance
        cell.each(function (d) {
            const cellGroup = d3.select(this);
            const ticker = d.data.ticker || '';
            const name = d.data.name || '';
            const width = d.x1 - d.x0;
            const height = d.y1 - d.y0;
            const area = width * height;
            const textColor = self.getTextColorForBackground(d.data.dayPct || 0);

            // Uniform font size
            const fontSize = Math.max(10, Math.min(16, Math.sqrt(area) / 8));

            // Check if asset has NO ticker (crowdfunding/real estate only)
            if (!ticker) {
                // No ticker: show wrapped NAME only - VERY SMALL FONT
                const smallFontSize = Math.max(4, Math.min(6, Math.sqrt(area) / 18)); // Very small
                const words = name.split(' ');
                const lineHeight = smallFontSize * 1.5;
                const maxWidth = width - 20; // Maximum padding
                let lines = [];
                let currentLine = '';

                words.forEach(word => {
                    const testLine = currentLine ? currentLine + ' ' + word : word;
                    const estimatedWidth = testLine.length * smallFontSize * 0.65;
                    if (estimatedWidth < maxWidth) {
                        currentLine = testLine;
                    } else {
                        if (currentLine) lines.push(currentLine);
                        currentLine = word;
                    }
                });
                if (currentLine) lines.push(currentLine);

                // Limit to 6 lines
                if (lines.length > 6) {
                    lines = lines.slice(0, 6);
                    lines[5] = lines[5].substring(0, 6) + '...';
                }

                // Center vertically
                const totalHeight = lines.length * lineHeight;
                const startY = (height - totalHeight) / 2 + lineHeight * 0.55;

                lines.forEach((line, i) => {
                    cellGroup.append('text')
                        .attr('x', width / 2)
                        .attr('y', startY + i * lineHeight)
                        .attr('text-anchor', 'middle')
                        .attr('fill', textColor)
                        .attr('font-size', smallFontSize + 'px')
                        .attr('font-weight', '600')
                        .text(line);
                });
            } else {
                // Normal assets: show TICKER only
                cellGroup.append('text')
                    .attr('x', width / 2)
                    .attr('y', height / 2)
                    .attr('text-anchor', 'middle')
                    .attr('dominant-baseline', 'middle')
                    .attr('fill', textColor)
                    .attr('font-size', fontSize + 'px')
                    .attr('font-weight', '700')
                    .text(ticker);
            }
        });

        // Create custom tooltip div if it doesn't exist
        let tooltip = d3.select('#treemap-tooltip');
        if (tooltip.empty()) {
            tooltip = d3.select('body').append('div')
                .attr('id', 'treemap-tooltip')
                .style('position', 'absolute')
                .style('background', 'rgba(30, 41, 59, 0.95)')
                .style('color', '#f1f5f9')
                .style('padding', '12px 16px')
                .style('border-radius', '8px')
                .style('border', '1px solid rgba(148, 163, 184, 0.2)')
                .style('font-size', '13px')
                .style('pointer-events', 'none')
                .style('opacity', 0)
                .style('z-index', '10000')
                .style('box-shadow', '0 4px 6px -1px rgba(0, 0, 0, 0.3)')
                .style('font-family', '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif');
        }

        // Add hover events for custom tooltip
        cell.on('mouseover', function (event, d) {
            const ticker = d.data.ticker || '';
            const name = d.data.name || '';
            const value = self.formatEUR(d.data.currentValue);
            const variation = self.formatPct(d.data.dayPct || 0);
            const weight = d.data.weight?.toFixed(2) || '0';
            const varColor = (d.data.dayPct || 0) >= 0 ? '#10b981' : '#ef4444';

            let html = '';
            if (ticker) {
                html = `<div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">${ticker}</div>`;
                html += `<div style="color: #cbd5e1; font-size: 12px; margin-bottom: 8px;">${name}</div>`;
            } else {
                html = `<div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">${name}</div>`;
            }
            html += `<div style="margin-top: 4px;"><span style="color: #94a3b8;">Valeur:</span> <span style="font-weight: 600;">${value}</span></div>`;
            html += `<div style="margin-top: 4px;"><span style="color: #94a3b8;">Variation:</span> <span style="font-weight: 600; color: ${varColor};">${variation}</span></div>`;
            html += `<div style="margin-top: 4px;"><span style="color: #94a3b8;">Poids:</span> <span style="font-weight: 600;">${weight}%</span></div>`;

            // Smart positioning: show on left if near right edge
            const windowWidth = window.innerWidth;
            const tooltipWidth = 220; // More accurate tooltip width
            const showOnLeft = event.pageX > windowWidth - tooltipWidth - 40;

            const leftPos = showOnLeft ? (event.pageX - tooltipWidth + 5) : (event.pageX + 5);

            tooltip.html(html)
                .style('opacity', 1)
                .style('left', leftPos + 'px')
                .style('top', (event.pageY - 10) + 'px');
        })
            .on('mousemove', function (event) {
                // Smart positioning on move too
                const windowWidth = window.innerWidth;
                const tooltipWidth = 220;
                const showOnLeft = event.pageX > windowWidth - tooltipWidth - 40;
                const leftPos = showOnLeft ? (event.pageX - tooltipWidth + 5) : (event.pageX + 5);

                tooltip
                    .style('left', leftPos + 'px')
                    .style('top', (event.pageY - 10) + 'px');
            })
            .on('mouseout', function () {
                tooltip.style('opacity', 0);
            });
    }

    getColorFromDayChange(dayPct) {
        // Match the color scale legend exactly
        if (dayPct >= 3) return '#10b981';      // ≥+3: dark green
        if (dayPct >= 2) return '#34d399';      // +2: medium green
        if (dayPct >= 1) return '#6ee7b7';      // +1: light green
        if (dayPct > 0) return '#a7f3d0';       // >0: very light green
        if (dayPct === 0) return '#9ca3af';     // 0: gray
        if (dayPct > -1) return '#fecaca';      // >-1: very light red
        if (dayPct > -2) return '#fca5a5';      // >-2: light red
        if (dayPct > -3) return '#f87171';      // >-3: medium red
        return '#ef4444';                        // ≤-3: dark red
    }

    getTextColorForBackground(dayPct) {
        // Return white for dark colors, dark for light colors
        if (Math.abs(dayPct) >= 2) return '#ffffff';
        if (Math.abs(dayPct) >= 1) return '#1f2937';
        return '#1f2937';
    }


    renderAllocationChart(assets) {
        const canvas = document.getElementById('allocation-chart');
        if (!canvas) return;

        if (this.allocationChart) {
            this.allocationChart.destroy();
        }

        // Get filter values
        const typeFilter = document.getElementById('allocation-type-filter')?.value || '';
        const brokerFilter = document.getElementById('allocation-broker-filter')?.value || '';

        // Filter assets based on selections
        let filteredAssets = [...assets];
        if (typeFilter) {
            filteredAssets = filteredAssets.filter(a => a.assetType === typeFilter);
        }
        if (brokerFilter) {
            // Filter by broker - need to check transactions for this asset
            const purchases = this.storage.getPurchases();
            filteredAssets = filteredAssets.filter(asset => {
                const assetTransactions = purchases.filter(p => p.ticker === asset.ticker);
                return assetTransactions.some(t => t.broker === brokerFilter);
            });
        }

        const sorted = filteredAssets.sort((a, b) => b.currentValue - a.currentValue);

        // LIMIT: Show top 20, group rest as "Autres"
        const limit = 20;
        const topAssets = sorted.slice(0, limit);
        const others = sorted.slice(limit);

        const labels = topAssets.map(a => a.name || a.ticker);
        const data = topAssets.map(a => a.currentValue);

        if (others.length > 0) {
            const othersTotal = others.reduce((sum, a) => sum + a.currentValue, 0);
            labels.push('Autres (' + others.length + ')');
            data.push(othersTotal);
        }

        const canvasEl = document.getElementById('allocation-chart');
        if (!canvasEl) return;

        const ctx = canvasEl.getContext('2d');

        this.allocationChart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: data,
                    backgroundColor: [
                        '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
                        '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
                        '#64748b', '#94a3b8', '#cbd5e1', '#a8a29e', '#78716c',
                        '#d97706', '#059669', '#2563eb', '#db2777', '#7c3aed'
                    ],
                    borderWidth: 2,
                    borderColor: '#1a2238'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'right',
                        labels: {
                            color: '#ffffff',
                            font: { size: 11 },
                            padding: 10,
                            boxWidth: 12
                        }
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 0, 0, 0.9)',
                        padding: 12,
                        callbacks: {
                            label: (context) => {
                                const index = context.dataIndex;
                                const originalAsset = index < topAssets.length ? topAssets[index] : null;
                                const label = context.label || '';
                                const value = context.parsed;
                                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                                const pct = ((value / total) * 100).toFixed(1);

                                let text = `${label}: ${value.toLocaleString('fr-FR', {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })} € (${pct}%)`;

                                if (originalAsset) {
                                    text += ` [${originalAsset.ticker}]`;
                                }
                                return text;
                            }
                        }
                    }
                }
            }
        });
    }

    // === DIVIDEND MODAL LOGIC ===
    openDividendModal() {
        console.log('🚀 openDividendModal EXECUTED!');
        const modal = document.getElementById('dividend-detail-modal');
        if (!modal) {
            console.error('❌ Modal #dividend-detail-modal NOT FOUND');
            return;
        }

        // FORCE STYLES (Nuclear Option for Visibility)
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw'; // Use VW
        modal.style.height = '100vh'; // Use VH
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        // Also force content visibility
        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b'; // Force dark bg
        }

        console.log('✅ Modal Forced Display', modal);

        // Default View: Monthly
        this.updateDividendChart('monthly');
    }

    updateDividendChart(viewMode) {
        console.log('📊 Update Dividend Chart:', viewMode);
        const purchases = this.storage.getPurchases();
        const dividends = purchases.filter(p => p.type === 'dividend');

        // Aggregate
        const aggregated = {};

        dividends.forEach(d => {
            const date = new Date(d.date);
            const amount = parseFloat(d.price) || parseFloat(d.quantity) || 0;

            let key;
            if (viewMode === 'monthly') {
                key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; // YYYY-MM
            } else {
                key = `${date.getFullYear()}`; // YYYY
            }

            if (!aggregated[key]) aggregated[key] = 0;
            aggregated[key] += amount;
        });

        // Sort keys
        const sortedKeys = Object.keys(aggregated).sort();
        const data = sortedKeys.map(k => aggregated[k]);

        // Render Chart
        const ctxEl = document.getElementById('dividend-evolution-chart');
        if (!ctxEl) {
            console.error('❌ Chart context #dividend-evolution-chart NOT FOUND');
            return;
        }
        const ctx = ctxEl.getContext('2d');

        if (this.dividendChartInstance) {
            this.dividendChartInstance.destroy();
        }

        this.dividendChartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sortedKeys,
                datasets: [{
                    label: 'Dividendes Reçus (€)',
                    data: data,
                    backgroundColor: '#10b981',
                    borderRadius: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y.toFixed(2)} €`
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8' },
                        grid: { display: false }
                    },
                    y: {
                        ticks: { color: '#94a3b8' },
                        grid: { color: '#1e293b' },
                        beginAtZero: true
                    }
                }
            }
        });

        // Update active buttons
        const btnMonthly = document.getElementById('view-monthly-btn');
        const btnYearly = document.getElementById('view-yearly-btn');
        if (btnMonthly) btnMonthly.className = viewMode === 'monthly' ? 'btn-primary' : 'btn-secondary';
        if (btnYearly) btnYearly.className = viewMode === 'yearly' ? 'btn-primary' : 'btn-secondary';
    }

    openRealEstateModal() {
        console.log('🚀 openRealEstateModal EXECUTED!');
        const modal = document.getElementById('real-estate-detail-modal');
        if (!modal) {
            console.error('❌ Modal #real-estate-detail-modal NOT FOUND');
            return;
        }

        // 1. Populate Table
        const tbody = document.getElementById('real-estate-table-body');
        tbody.innerHTML = ''; // Clear previous

        const purchases = this.storage.getPurchases();
        const reProjects = purchases.filter(p => p.assetType === 'Real Estate');

        let totalInvested = 0;
        let totalAnnual = 0;
        let totalAccrued = 0;

        reProjects.forEach(p => {
            const invested = p.price * p.quantity;
            const yieldPct = p.yield || 0;
            const annual = invested * (yieldPct / 100);

            // Accrued calculation
            const startDate = new Date(p.date);
            const today = new Date();
            const daysHeld = Math.max(0, (today - startDate) / (1000 * 60 * 60 * 24));
            const accrued = invested * (yieldPct / 100) * (daysHeld / 365);

            totalInvested += invested;
            totalAnnual += annual;
            totalAccrued += accrued;

            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid var(--border-color)';
            row.innerHTML = `
                <td style="padding: 12px 8px;">
                    <div style="font-weight: 600; color: var(--text-primary);">${p.symbol}</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">${new Date(p.date).toLocaleDateString()}</div>
                </td>
                <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace;">${this.formatEUR(invested)}</td>
                <td style="padding: 12px 8px; text-align: right;">
                    <span style="background: rgba(16, 185, 129, 0.1); color: #10b981; padding: 2px 6px; border-radius: 4px; font-weight: 500; font-size: 12px;">
                        ${yieldPct.toFixed(2)}%
                    </span>
                </td>
                <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace;">${this.formatEUR(annual)}</td>
                <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; color: #10b981; font-weight: 600;">+${this.formatEUR(accrued)}</td>
            `;
            tbody.appendChild(row);
        });

        // Add Total Row
        const totalRow = document.createElement('tr');
        totalRow.style.backgroundColor = 'var(--bg-secondary)';
        totalRow.innerHTML = `
            <td style="padding: 12px 8px; font-weight: 700;">TOTAL</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; font-weight: 700;">${this.formatEUR(totalInvested)}</td>
            <td style="padding: 12px 8px; text-align: right;">-</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; font-weight: 700;">${this.formatEUR(totalAnnual)}</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; font-weight: 700; color: #10b981;">+${this.formatEUR(totalAccrued)}</td>
        `;
        tbody.appendChild(totalRow);


        // 2. FORCE VISIBILITY
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }
    }

    openTopPerformersModal() {
        console.log('🚀 openTopPerformersModal EXECUTED!');
        const modal = document.getElementById('top-performers-modal');
        if (!modal) {
            console.error('❌ Modal #top-performers-modal NOT FOUND');
            return;
        }

        // Populate Table with all gainers
        const tbody = document.getElementById('top-performers-table-body');
        tbody.innerHTML = '';

        const report = this.lastReport;
        if (!report || !report.assets) {
            console.error('❌ No report data available');
            return;
        }

        console.log('🔍 DEBUG: report.assets:', report.assets);
        console.log('🔍 DEBUG: Total assets:', report.assets.length);

        // Get all assets with positive gains and sort by absolute gain descending
        const gainers = report.assets
            .filter(a => {
                console.log(`🔍 Asset ${a.ticker}: gainEUR=${a.gainEUR}`);
                return a.gainEUR > 0;
            })
            .sort((a, b) => b.gainEUR - a.gainEUR);

        console.log('🔍 DEBUG: Gainers found:', gainers.length);

        let totalGain = 0;
        let totalInvested = 0;

        gainers.forEach(asset => {
            totalGain += asset.gainEUR;
            totalInvested += asset.invested || 0;

            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid var(--border-color)';
            row.innerHTML = `
                <td style="padding: 12px 8px;">
                    <div style="font-weight: 600; color: var(--text-primary);">${asset.name}</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">${asset.ticker}</div>
                </td>
                <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; color: #10b981; font-weight: 600;">+${this.formatEUR(asset.gainEUR)}</td>
                <td style="padding: 12px 8px; text-align: right;">
                    <span style="background: rgba(16, 185, 129, 0.1); color: #10b981; padding: 2px 6px; border-radius: 4px; font-weight: 500; font-size: 12px;">
                        +${asset.gainPct.toFixed(2)}%
                    </span>
                </td>
            `;
            tbody.appendChild(row);
        });

        // Calculate weighted average percentage
        const avgPct = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;

        // Add Total Row
        const totalRow = document.createElement('tr');
        totalRow.style.backgroundColor = 'var(--bg-secondary)';
        totalRow.innerHTML = `
            <td style="padding: 12px 8px; font-weight: 700;">TOTAL GAINS</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; font-weight: 700; color: #10b981;">+${this.formatEUR(totalGain)}</td>
            <td style="padding: 12px 8px; text-align: right;">
                <span style="background: rgba(16, 185, 129, 0.1); color: #10b981; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 12px;">
                    +${avgPct.toFixed(2)}%
                </span>
            </td>
        `;
        tbody.appendChild(totalRow);

        // Force visibility
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }
    }

    openWorstPerformersModal() {
        console.log('🚀 openWorstPerformersModal EXECUTED!');
        const modal = document.getElementById('worst-performers-modal');
        if (!modal) {
            console.error('❌ Modal #worst-performers-modal NOT FOUND');
            return;
        }

        // Populate Table with all losers
        const tbody = document.getElementById('worst-performers-table-body');
        tbody.innerHTML = '';

        const report = this.lastReport;
        if (!report || !report.assets) {
            console.error('❌ No report data available');
            return;
        }

        // Get all assets with negative gains and sort by absolute loss descending (most negative first)
        const losers = report.assets
            .filter(a => a.gainEUR < 0)
            .sort((a, b) => a.gainEUR - b.gainEUR);

        let totalLoss = 0;
        let totalInvested = 0;

        losers.forEach(asset => {
            totalLoss += asset.gainEUR;
            totalInvested += asset.invested || 0;

            const row = document.createElement('tr');
            row.style.borderBottom = '1px solid var(--border-color)';
            row.innerHTML = `
                <td style="padding: 12px 8px;">
                    <div style="font-weight: 600; color: var(--text-primary);">${asset.name}</div>
                    <div style="font-size: 12px; color: var(--text-secondary);">${asset.ticker}</div>
                </td>
                <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; color: #ef4444; font-weight: 600;">${this.formatEUR(asset.gainEUR)}</td>
                <td style="padding: 12px 8px; text-align: right;">
                    <span style="background: rgba(239, 68, 68, 0.1); color: #ef4444; padding: 2px 6px; border-radius: 4px; font-weight: 500; font-size: 12px;">
                        ${asset.gainPct.toFixed(2)}%
                    </span>
                </td>
            `;
            tbody.appendChild(row);
        });

        // Calculate weighted average percentage
        const avgPct = totalInvested > 0 ? (totalLoss / totalInvested) * 100 : 0;

        // Add Total Row
        const totalRow = document.createElement('tr');
        totalRow.style.backgroundColor = 'var(--bg-secondary)';
        totalRow.innerHTML = `
            <td style="padding: 12px 8px; font-weight: 700;">TOTAL PERTES</td>
            <td style="padding: 12px 8px; text-align: right; font-family: 'Roboto Mono', monospace; font-weight: 700; color: #ef4444;">${this.formatEUR(totalLoss)}</td>
            <td style="padding: 12px 8px; text-align: right;">
                <span style="background: rgba(239, 68, 68, 0.1); color: #ef4444; padding: 2px 6px; border-radius: 4px; font-weight: 700; font-size: 12px;">
                    ${avgPct.toFixed(2)}%
                </span>
            </td>
        `;
        tbody.appendChild(totalRow);

        // Force visibility
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }
    }

    openPerformanceModal() {
        console.log('🚀 openPerformanceModal EXECUTED!');
        const modal = document.getElementById('performance-modal');
        if (!modal) {
            console.error('❌ Modal #performance-modal NOT FOUND');
            return;
        }

        const report = this.lastReport;
        if (!report || !report.assets) {
            console.error('❌ No report data available');
            return;
        }

        const assets = report.assets;
        const performance = report.performance;

        // Calculate Total Gains and Losses in EUR
        let totalGainsEUR = 0;
        let totalLossesEUR = 0;
        let totalInvested = 0;
        const gains = [];

        assets.forEach(asset => {
            if (asset.gainEUR > 0) {
                totalGainsEUR += asset.gainEUR;
            } else if (asset.gainEUR < 0) {
                totalLossesEUR += asset.gainEUR;
            }
            totalInvested += asset.invested || 0;
            if (asset.gainPct !== null) {
                gains.push(asset.gainPct);
            }
        });

        // Calculate Weighted Average Performance
        const weightedAvg = totalInvested > 0 ? ((totalGainsEUR + totalLossesEUR) / totalInvested) * 100 : 0;

        // Calculate Standard Deviation
        const avgGain = parseFloat(performance.avgGain);
        const variance = gains.reduce((sum, g) => sum + Math.pow(g - avgGain, 2), 0) / gains.length;
        const stdDev = Math.sqrt(variance);

        // Find Min/Max Performance
        const minPerf = Math.min(...gains);
        const maxPerf = Math.max(...gains);

        // Find Best Gain and Worst Loss in EUR (with asset info)
        const bestGainAsset = assets.reduce((max, a) => (a.gainEUR > max.gainEUR ? a : max), assets[0]);
        const worstLossAsset = assets.reduce((min, a) => (a.gainEUR < min.gainEUR ? a : min), assets[0]);

        // Find assets with min/max performance %
        const minPerfAsset = assets.find(a => a.gainPct === minPerf);
        const maxPerfAsset = assets.find(a => a.gainPct === maxPerf);

        // Populate Overview Section
        document.getElementById('perf-avg-gain').textContent = performance.avgGain + '%';
        document.getElementById('perf-avg-gain').style.color = parseFloat(performance.avgGain) >= 0 ? '#10b981' : '#ef4444';
        document.getElementById('perf-win-rate').textContent = performance.winRate + '%';
        document.getElementById('perf-total-gains').textContent = '+' + this.formatEUR(totalGainsEUR);
        document.getElementById('perf-total-losses').textContent = this.formatEUR(totalLossesEUR);

        // Populate Top 5 Performers
        const sorted = [...assets].sort((a, b) => b.gainPct - a.gainPct);
        const top5 = sorted.slice(0, 5);
        const top5HTML = top5.map(asset => `
            <div style="display: flex; justify-content: space-between; padding: 8px; background: var(--bg-card); border-radius: 6px; margin-bottom: 6px;">
                <div style="flex: 1; min-width: 0; margin-right: 12px;">
                    <div style="font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${asset.name}</div>
                    <div style="font-size: 11px; color: var(--text-secondary);">${asset.ticker}</div>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                    <div style="font-weight: 600; color: #10b981;">+${this.formatEUR(asset.gainEUR)}</div>
                    <div style="font-size: 11px; color: #10b981;">+${asset.gainPct.toFixed(2)}%</div>
                </div>
            </div>
        `).join('');
        document.getElementById('perf-top-5').innerHTML = top5HTML;

        // Populate Worst 5 Performers
        const worst5 = sorted.slice(-5).reverse();
        const worst5HTML = worst5.map(asset => `
            <div style="display: flex; justify-content: space-between; padding: 8px; background: var(--bg-card); border-radius: 6px; margin-bottom: 6px;">
                <div style="flex: 1; min-width: 0; margin-right: 12px;">
                    <div style="font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${asset.name}</div>
                    <div style="font-size: 11px; color: var(--text-secondary);">${asset.ticker}</div>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                    <div style="font-weight: 600; color: #ef4444;">${this.formatEUR(asset.gainEUR)}</div>
                    <div style="font-size: 11px; color: #ef4444;">${asset.gainPct.toFixed(2)}%</div>
                </div>
            </div>
        `).join('');
        document.getElementById('perf-worst-5').innerHTML = worst5HTML;

        // Populate Advanced Statistics
        document.getElementById('perf-weighted-avg').textContent = (weightedAvg >= 0 ? '+' : '') + weightedAvg.toFixed(2) + '%';
        document.getElementById('perf-weighted-avg').style.color = weightedAvg >= 0 ? '#10b981' : '#ef4444';

        document.getElementById('perf-std-dev').textContent = stdDev.toFixed(2) + '%';

        document.getElementById('perf-best-gain').textContent = '+' + this.formatEUR(bestGainAsset.gainEUR);
        document.getElementById('perf-best-gain-ticker').textContent = bestGainAsset.ticker;

        document.getElementById('perf-worst-loss').textContent = this.formatEUR(worstLossAsset.gainEUR);
        document.getElementById('perf-worst-loss-ticker').textContent = worstLossAsset.ticker;

        document.getElementById('perf-min').textContent = minPerf.toFixed(2) + '%';
        document.getElementById('perf-min').style.color = minPerf >= 0 ? '#10b981' : '#ef4444';
        document.getElementById('perf-min-ticker').textContent = minPerfAsset ? minPerfAsset.ticker : '';

        document.getElementById('perf-max').textContent = '+' + maxPerf.toFixed(2) + '%';
        document.getElementById('perf-max').style.color = '#10b981';
        document.getElementById('perf-max-ticker').textContent = maxPerfAsset ? maxPerfAsset.ticker : '';

        // Force visibility
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }
    }

    async openDiversificationModal() {
        console.log('🚀 openDiversificationModal EXECUTED!');
        const modal = document.getElementById('diversification-modal');
        if (!modal) {
            console.error('❌ Modal #diversification-modal NOT FOUND');
            return;
        }

        const report = this.lastReport;
        if (!report || !report.assets) {
            console.error('❌ No report data available');
            return;
        }

        const assets = report.assets;
        const diversification = report.diversification;

        // Calculate Top 3 Weight
        const sorted = [...assets].sort((a, b) => b.weight - a.weight);
        const top3Weight = sorted.slice(0, 3).reduce((sum, a) => sum + a.weight, 0);

        // Group by Asset Type
        const byType = {};
        assets.forEach(a => {
            const type = a.assetType || 'Other';
            if (!byType[type]) byType[type] = { count: 0, value: 0, weight: 0 };
            byType[type].count++;
            byType[type].value += a.currentValue || 0;
            byType[type].weight += a.weight;
        });

        // Concentration Analysis
        const heavy = assets.filter(a => a.weight > 10);
        const medium = assets.filter(a => a.weight >= 5 && a.weight <= 10);
        const light = assets.filter(a => a.weight < 5);
        const largest = sorted[0];

        // Populate Overview
        const score = parseFloat(diversification.diversityScore);
        document.getElementById('div-score').textContent = diversification.diversityScore + '/100';
        document.getElementById('div-score').style.color = score >= 70 ? '#10b981' : score >= 40 ? '#f59e0b' : '#ef4444';
        document.getElementById('div-hhi').textContent = diversification.herfindahl;
        document.getElementById('div-effective').textContent = diversification.effectiveAssets;
        document.getElementById('div-top3-weight').textContent = top3Weight.toFixed(1) + '%';

        // Populate Asset Types
        const typesHTML = Object.entries(byType)
            .sort((a, b) => b[1].weight - a[1].weight)
            .map(([type, data]) => `
                <div style="display: flex; justify-content: space-between; padding: 8px; background: var(--bg-card); border-radius: 6px; margin-bottom: 6px;">
                    <div>
                        <div style="font-weight: 600; color: var(--text-primary);">${type}</div>
                        <div style="font-size: 11px; color: var(--text-secondary);">${data.count} actif${data.count > 1 ? 's' : ''}</div>
                    </div>
                    <div style="text-align: right;">
                        <div style="font-weight: 600; color: var(--text-primary);">${this.formatEUR(data.value)}</div>
                        <div style="font-size: 11px; color: var(--text-secondary);">${data.weight.toFixed(1)}%</div>
                    </div>
                </div>
            `).join('');
        document.getElementById('div-asset-types').innerHTML = typesHTML;

        // Populate Concentration
        document.getElementById('div-heavy-count').textContent = heavy.length;
        document.getElementById('div-medium-count').textContent = medium.length;
        document.getElementById('div-light-count').textContent = light.length;
        document.getElementById('div-largest-position').textContent = largest.name;
        document.getElementById('div-largest-weight').textContent = largest.weight.toFixed(1) + '%';

        // Force modal visibility BEFORE calling Gemini (non-blocking)
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }

        // Fetch Gemini Advice (async, non-blocking)
        this.loadGeminiDiversificationAdvice({
            score: score,
            hhi: diversification.herfindahl,
            effectiveAssets: parseFloat(diversification.effectiveAssets),
            totalAssets: diversification.totalAssets,
            top3Weight: top3Weight,
            assetTypeBreakdown: byType,
            heavyCount: heavy.length,
            largestPosition: { name: largest.name, weight: largest.weight }
        });
    }

    async loadGeminiDiversificationAdvice(portfolioData) {
        const contentDiv = document.getElementById('gemini-advice-content');

        // Show loading state
        contentDiv.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--text-secondary);">
                <div class="spinner" style="border: 3px solid rgba(139, 92, 246, 0.2); border-top: 3px solid #a78bfa; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 12px;"></div>
                <div>Analyse en cours...</div>
            </div>
        `;

        try {
            const advice = await fetchGeminiDiversificationAdvice(portfolioData);
            contentDiv.innerHTML = advice;
        } catch (error) {
            console.error('Error fetching Gemini advice:', error);
            contentDiv.innerHTML = `
                <div style="color: var(--text-secondary); text-align: center; padding: 20px;">
                    ⚠️ Impossible de charger les conseils AI. 
                    <button id="retry-gemini" style="margin-top: 12px; background: rgba(139, 92, 246, 0.2); border: 1px solid rgba(139, 92, 246, 0.4); color: #a78bfa; padding: 6px 12px; border-radius: 6px; cursor: pointer;">Réessayer</button>
                </div>
            `;

            // Add retry listener
            document.getElementById('retry-gemini')?.addEventListener('click', () => {
                this.loadGeminiDiversificationAdvice(portfolioData);
            });
        }
    }

    openRiskModal() {
        console.log('🚀 openRiskModal EXECUTED!');
        const modal = document.getElementById('risk-modal');
        if (!modal) {
            console.error('❌ Modal #risk-modal NOT FOUND');
            return;
        }

        const report = this.lastReport;
        if (!report || !report.assets || !report.risk) {
            console.error('❌ No report data available');
            return;
        }

        const assets = report.assets;
        const risk = report.risk;

        // Populate Modal Metrics
        document.getElementById('risk-volatility').textContent = risk.volatility + '%';
        document.getElementById('risk-drawdown').textContent = risk.maxDrawdown + '%';

        // Risk Level Badge
        const levelEl = document.getElementById('risk-level-modal');
        if (levelEl) {
            levelEl.textContent = risk.riskLevel;
            // Apply color based on risk level
            if (risk.riskLevel === 'Faible') {
                levelEl.style.background = 'rgba(16, 185, 129, 0.2)';
                levelEl.style.color = '#10b981';
            } else if (risk.riskLevel === 'Modéré') {
                levelEl.style.background = 'rgba(251, 191, 36, 0.2)';
                levelEl.style.color = '#fbbf24';
            } else {
                levelEl.style.background = 'rgba(239, 68, 68, 0.2)';
                levelEl.style.color = '#ef4444';
            }
        }


        // Sharpe Ratio (simplified calculation: avg return / volatility)
        // Note: True Sharpe uses risk-free rate, but we use 0% for simplicity
        const sharpeEl = document.getElementById('risk-sharpe');
        if (sharpeEl) {
            const avgReturn = assets.length > 0
                ? assets.reduce((sum, a) => sum + (a.gainPct || 0), 0) / assets.length
                : 0;
            const volatility = parseFloat(risk.volatility) || 1; // Avoid division by zero

            if (volatility > 0 && assets.length > 0) {
                const sharpe = avgReturn / volatility;
                sharpeEl.textContent = sharpe.toFixed(2);

                // Color coding: >1 = good (green), 0-1 = ok (yellow), <0 = bad (red)
                if (sharpe > 1) {
                    sharpeEl.style.color = '#10b981';
                } else if (sharpe > 0) {
                    sharpeEl.style.color = '#f59e0b';
                } else {
                    sharpeEl.style.color = '#ef4444';
                }
            } else {
                sharpeEl.textContent = '-';
                sharpeEl.style.color = 'var(--text-primary)';
            }
        }

        // Risk Distribution by Volatility
        // NOTE: Since individual asset volatility is not calculated in dataManager,
        // we use absolute gainPct as a proxy for risk assessment
        const totalValue = assets.reduce((sum, a) => sum + (a.currentValue || 0), 0);

        // Use absolute gainPct as volatility proxy
        const assetsWithRisk = assets.map(a => ({
            ...a,
            volatilityProxy: Math.abs(a.gainPct || 0)
        }));

        const lowRisk = assetsWithRisk.filter(a => a.volatilityProxy < 10);
        const medRisk = assetsWithRisk.filter(a => a.volatilityProxy >= 10 && a.volatilityProxy <= 20);
        const highRisk = assetsWithRisk.filter(a => a.volatilityProxy > 20);

        const lowValue = lowRisk.reduce((sum, a) => sum + (a.currentValue || 0), 0);
        const medValue = medRisk.reduce((sum, a) => sum + (a.currentValue || 0), 0);
        const highValue = highRisk.reduce((sum, a) => sum + (a.currentValue || 0), 0);

        document.getElementById('risk-low-count').textContent = lowRisk.length;
        document.getElementById('risk-low-pct').textContent = totalValue > 0 ? ((lowValue / totalValue) * 100).toFixed(1) + '% du total' : '0% du total';

        document.getElementById('risk-med-count').textContent = medRisk.length;
        document.getElementById('risk-med-pct').textContent = totalValue > 0 ? ((medValue / totalValue) * 100).toFixed(1) + '% du total' : '0% du total';

        document.getElementById('risk-high-count').textContent = highRisk.length;
        document.getElementById('risk-high-pct').textContent = totalValue > 0 ? ((highValue / totalValue) * 100).toFixed(1) + '% du total' : '0% du total';

        // Top 5 Most Volatile Assets (using absolute gainPct as proxy)
        const sortedByVolatility = [...assetsWithRisk]
            .filter(a => a.volatilityProxy > 0)
            .sort((a, b) => b.volatilityProxy - a.volatilityProxy)
            .slice(0, 5);

        const topVolatileHTML = sortedByVolatility.map(asset => `
            <div style="display: flex; justify-content: space-between; padding: 8px; background: var(--bg-card); border-radius: 6px; margin-bottom: 6px;">
                <div style="flex: 1; min-width: 0; margin-right: 12px;">
                    <div style="font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${asset.name}</div>
                    <div style="font-size: 11px; color: var(--text-secondary);">${asset.ticker}</div>
                </div>
                <div style="text-align: right; flex-shrink: 0;">
                    <div style="font-weight: 600; color: ${asset.volatilityProxy > 20 ? '#ef4444' : asset.volatilityProxy > 10 ? '#f59e0b' : '#10b981'};">${asset.volatilityProxy.toFixed(2)}%</div>
                    <div style="font-size: 11px; color: var(--text-secondary);">${this.formatEUR(asset.currentValue)}</div>
                </div>
            </div>
        `).join('');
        document.getElementById('risk-top-volatile').innerHTML = topVolatileHTML || '<p style="color: var(--text-muted); text-align: center;">Aucune donnée</p>';

        // Force visibility
        modal.style.display = 'flex';
        modal.style.setProperty('display', 'flex', 'important');
        modal.style.zIndex = '9999999';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100vw';
        modal.style.height = '100vh';
        modal.style.backgroundColor = 'rgba(0,0,0,0.85)';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';

        const content = modal.querySelector('.modal-content');
        if (content) {
            content.style.display = 'block';
            content.style.visibility = 'visible';
            content.style.opacity = '1';
            content.style.zIndex = '10000000';
            content.style.backgroundColor = '#1e293b';
        }

        // Load Gemini AI Risk Advice automatically
        const adviceContent = document.getElementById('risk-advice-content');
        if (adviceContent && report && report.risk) {
            // Simulate loading delay then show placeholder
            setTimeout(() => {
                adviceContent.innerHTML = `
                    <p style="margin: 0; line-height: 1.6;">
                        <strong>Analyse de votre profil de risque:</strong><br><br>
                        Votre portefeuille présente une volatilité de ${risk.volatility}% et un max drawdown de ${risk.maxDrawdown}%, 
                        classifié comme <strong>${risk.riskLevel}</strong>.<br><br>
                        ${sortedByVolatility.length > 0
                        ? `Les actifs les plus volatils de votre portefeuille sont : ${sortedByVolatility.slice(0, 3).map(a => a.ticker).join(', ')}. 
                               Considérez une diversification accrue si votre tolérance au risque est modérée.`
                        : 'Votre diversification actuelle semble appropriée pour votre profil.'}
                        <br><br>
                        <em style="opacity: 0.8; font-size: 12px;">Note : L'intégration complète de Gemini AI est en cours de développement.</em>
                    </p>
                `;
            }, 800);
        }
    }

    setupEventListeners() {
        console.log('🔌 setupEventListeners initialized');

        // Refresh Button
        const refreshBtn = document.getElementById('refresh-analytics');
        if (refreshBtn) {
            refreshBtn.addEventListener('click', async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = '🔄 Rafraîchissement...';

                try {
                    // === Fetch Prices ===
                    const purchases = this.storage.getPurchases();
                    const tickers = [...new Set(purchases
                        .filter(p => !['Real Estate', 'Cash', 'Dividend'].includes(p.assetType))
                        .map(p => p.ticker))];

                    if (tickers.length > 0) {
                        await this.api.fetchBatchPrices(tickers);
                    }

                    // === Render ===
                    await this.render();
                    this.showNotification('✅ Analytics mis à jour', 'success');
                } catch (error) {
                    console.error('Erreur refresh:', error);
                    this.showNotification('❌ Erreur lors du rafraîchissement', 'error');
                } finally {
                    refreshBtn.disabled = false;
                    refreshBtn.textContent = 'Refresh Analytics';
                }
            });
        }

        // =============================================
        // EVENT DELEGATION: Dividend Modal Listeners (DEBUG MODE)
        // =============================================
        const self = this;
        document.body.addEventListener('click', (e) => {
            // Debug Log
            if (e.target.closest('#dividend-card')) {
                console.log('🖱️ DEBUG: Detected click on #dividend-card (delegation)', e.target);
            }

            // Open Modal
            const divCard = e.target.closest('#dividend-card');
            if (divCard) {
                console.log('✅ DEBUG: Target is dividend card. Opening modal...');
                if (typeof self.openDividendModal === 'function') {
                    console.log('🚀 DEBUG: Calling self.openDividendModal()');
                    self.openDividendModal();
                } else {
                    console.error('❌ CRITICAL ERROR: openDividendModal is not a function!', self);
                }
            }

            // Close Modal (Button)
            if (e.target.id === 'close-dividend-modal' || e.target.closest('#close-dividend-modal')) {
                console.log('🔄 DEBUG: Closing modal (Button)');
                const modal = document.getElementById('dividend-detail-modal');
                if (modal) modal.style.display = 'none';
            }

            // Close Modal (Overlay Click)
            if (e.target.id === 'dividend-detail-modal') {
                console.log('🔄 DEBUG: Closing modal (Overlay)');
                e.target.style.display = 'none';
            }
        });

        // =============================================
        // REAL ESTATE CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#real-estate-card')) {
                console.log('🖱️ Click on Real Estate Card');
                if (typeof self.openRealEstateModal === 'function') {
                    self.openRealEstateModal();
                }
            }
        });

        // Close RE Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-re-modal' || e.target.id === 'real-estate-detail-modal') {
                const modal = document.getElementById('real-estate-detail-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // TOP PERFORMERS CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#top-performers-card')) {
                console.log('🖱️ Click on Top Performers Card');
                if (typeof self.openTopPerformersModal === 'function') {
                    self.openTopPerformersModal();
                }
            }
        });

        // Close Top Performers Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-top-modal' || e.target.id === 'top-performers-modal') {
                const modal = document.getElementById('top-performers-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // WORST PERFORMERS CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#worst-performers-card')) {
                console.log('🖱️ Click on Worst Performers Card');
                if (typeof self.openWorstPerformersModal === 'function') {
                    self.openWorstPerformersModal();
                }
            }
        });

        // Close Worst Performers Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-worst-modal' || e.target.id === 'worst-performers-modal') {
                const modal = document.getElementById('worst-performers-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // PERFORMANCE GLOBALE CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#performance-card')) {
                console.log('🖱️ Click on Performance Globale Card');
                if (typeof self.openPerformanceModal === 'function') {
                    self.openPerformanceModal();
                }
            }
        });

        // Close Performance Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-performance-modal' || e.target.id === 'performance-modal') {
                const modal = document.getElementById('performance-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // DIVERSIFICATION CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#diversification-card')) {
                console.log('🖱️ Click on Diversification Card');
                if (typeof self.openDiversificationModal === 'function') {
                    self.openDiversificationModal();
                }
            }
        });

        // Close Diversification Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-diversification-modal' || e.target.id === 'diversification-modal') {
                const modal = document.getElementById('diversification-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // TIMELINE VERSEMENTS CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            const card = e.target.closest('#investment-timeline-card');
            // Allow click on card only if it's NOT one of the buttons inside
            if (card && !e.target.closest('button')) {
                console.log('🖱️ Click on Timeline Card');
                if (typeof self.openInvestmentTimelineModal === 'function') {
                    self.openInvestmentTimelineModal();
                }
            }
        });

        // Close Timeline Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-timeline-modal' || e.target.id === 'timeline-detail-modal') {
                const modal = document.getElementById('timeline-detail-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // =============================================
        // RISK CARD LISTENER
        // =============================================
        document.body.addEventListener('click', (e) => {
            if (e.target.closest('#risk-card')) {
                console.log('🖱️ Click on Risk Card');
                if (typeof self.openRiskModal === 'function') {
                    self.openRiskModal();
                }
            }
        });

        // Close Risk Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'close-risk-modal' || e.target.id === 'risk-modal') {
                const modal = document.getElementById('risk-modal');
                if (modal) modal.style.display = 'none';
            }
        });

        // Refresh Risk Advice (Gemini AI)
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'refresh-risk-advice' || e.target.closest('#refresh-risk-advice')) {
                console.log('🔄 Refreshing Risk Gemini advice');
                const adviceContent = document.getElementById('risk-advice-content');
                if (adviceContent) {
                    const report = self.lastReport;
                    if (report && report.risk) {
                        // Show loading spinner
                        adviceContent.innerHTML = `
                            <div style="text-align: center; padding: 20px; color: var(--text-secondary);">
                                <div class="spinner" style="border: 3px solid rgba(239, 68, 68, 0.2); border-top: 3px solid #fca5a5; border-radius: 50%; width: 30px; height: 30px; animation: spin 1s linear infinite; margin: 0 auto 12px;"></div>
                                <div>Analyse en cours...</div>
                            </div>
                        `;
                        // TODO: Call Gemini API for risk-specific advice
                        // For now, show a placeholder message
                        setTimeout(() => {
                            adviceContent.innerHTML = `
                                <p style="margin: 0;">L'intégration de Gemini AI pour les conseils de gestion du risque sera disponible prochainement. Cette fonctionnalité analysera votre volatilité de portefeuille, votre max drawdown, et fournira des recommandations personnalisées pour optimiser votre profil de risque.</p>
                            `;
                        }, 1500);
                    }
                }
            }
        });

        // Refresh Gemini Advice
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'refresh-gemini-advice' || e.target.closest('#refresh-gemini-advice')) {
                console.log('🔄 Refreshing Gemini advice');
                // Get the portfolio data from the modal (reconstruct from DOM or store it)
                const report = self.lastReport;
                if (report) {
                    const assets = report.assets;
                    const diversification = report.diversification;
                    const sorted = [...assets].sort((a, b) => b.weight - a.weight);
                    const top3Weight = sorted.slice(0, 3).reduce((sum, a) => sum + a.weight, 0);
                    const byType = {};
                    assets.forEach(a => {
                        const type = a.assetType || 'Other';
                        if (!byType[type]) byType[type] = { count: 0, value: 0, weight: 0 };
                        byType[type].count++;
                        byType[type].value += a.currentValue || 0;
                        byType[type].weight += a.weight;
                    });
                    const heavy = assets.filter(a => a.weight > 10);
                    const largest = sorted[0];

                    self.loadGeminiDiversificationAdvice({
                        score: parseFloat(diversification.diversityScore),
                        hhi: diversification.herfindahl,
                        effectiveAssets: parseFloat(diversification.effectiveAssets),
                        totalAssets: diversification.totalAssets,
                        top3Weight: top3Weight,
                        assetTypeBreakdown: byType,
                        heavyCount: heavy.length,
                        largestPosition: { name: largest.name, weight: largest.weight }
                    });
                }
            }
        });

        // Boutons Vue Modal
        document.body.addEventListener('click', (e) => {
            if (e.target.id === 'view-monthly-btn') {
                console.log('🖱️ Switch Monthly');
                self.updateDividendChart('monthly');
            }
            if (e.target.id === 'view-yearly-btn') {
                console.log('🖱️ Switch Yearly');
                self.updateDividendChart('yearly');
            }
        });

        // === ALLOCATION FILTERS EVENT LISTENERS ===
        const allocationTypeFilter = document.getElementById('allocation-type-filter');
        const allocationBrokerFilter = document.getElementById('allocation-broker-filter');
        const clearAllocationFilters = document.getElementById('clear-allocation-filters');

        if (allocationTypeFilter) {
            allocationTypeFilter.addEventListener('change', () => {
                console.log('📊 Allocation type filter changed');
                // Re-render allocation chart with filters
                const report = this.lastReport;
                if (report && report.assets) {
                    this.renderAllocationChart(report.assets);
                }
            });
        }

        if (allocationBrokerFilter) {
            allocationBrokerFilter.addEventListener('change', () => {
                console.log('📊 Allocation broker filter changed');
                // Re-render allocation chart with filters
                const report = this.lastReport;
                if (report && report.assets) {
                    this.renderAllocationChart(report.assets);
                }
            });
        }

        if (clearAllocationFilters) {
            clearAllocationFilters.addEventListener('click', () => {
                console.log('📊 Clear allocation filters');
                if (allocationTypeFilter) allocationTypeFilter.value = '';
                if (allocationBrokerFilter) allocationBrokerFilter.value = '';
                // Re-render allocation chart
                const report = this.lastReport;
                if (report && report.assets) {
                    this.renderAllocationChart(report.assets);
                }
            });
        }
    }

    formatEUR(value) {
        if (value === null || isNaN(value)) return '-';
        return value.toLocaleString('fr-FR', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }) + ' €';
    }

    formatPct(value) {
        if (value === null || isNaN(value)) return '-';
        const sign = value >= 0 ? '+' : '';
        return sign + value.toFixed(2) + '%';
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
            animation: slideIn 0.3s ease;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.animation = 'slideOut 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, 3000);
    }

    // =============================================
    // INVESTMENT TIMELINE CARD
    // =============================================
    renderInvestmentTimeline(viewMode = 'monthly') {
        const purchases = this.storage.getPurchases();

        // Keep only real purchases (exclude dividends, sales, cash)
        const buys = purchases.filter(p => {
            const t = (p.type || '').toLowerCase();
            const at = (p.assetType || '').toLowerCase();
            return t !== 'dividend' && t !== 'sell' && t !== 'sale' && at !== 'cash';
        });

        if (buys.length === 0) return;

        // --- Aggregate invested per period ---
        const aggregated = {};
        let totalInvested = 0;
        let lastAmount = 0;
        let lastDate = null;

        buys.forEach(p => {
            const amount = (parseFloat(p.price) || 0) * (parseFloat(p.quantity) || 0);
            if (amount <= 0) return;

            totalInvested += amount;
            const d = new Date(p.date);
            const key = viewMode === 'monthly'
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
                : `${d.getFullYear()}`;

            aggregated[key] = (aggregated[key] || 0) + amount;

            if (!lastDate || d > lastDate) {
                lastDate = d;
                lastAmount = amount;
            }
        });

        // Sort keys
        const sortedKeys = Object.keys(aggregated).sort();
        const values = sortedKeys.map(k => aggregated[k]);

        // Format labels for display
        const labels = sortedKeys.map(k => {
            if (viewMode === 'yearly') return k;
            const [y, m] = k.split('-');
            return new Date(+y, +m - 1).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
        });

        // --- Update summary KPIs ---
        const totalEl = document.getElementById('timeline-total');
        if (totalEl) totalEl.textContent = this.formatEUR(totalInvested);

        const lastEl = document.getElementById('timeline-last');
        if (lastEl) lastEl.textContent = lastAmount > 0 ? this.formatEUR(lastAmount) : '-';

        const lastDateEl = document.getElementById('timeline-last-date');
        if (lastDateEl && lastDate) {
            lastDateEl.textContent = lastDate.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
        }

        // --- Render Chart ---
        const ctxEl = document.getElementById('investment-timeline-chart');
        if (!ctxEl) return;
        const ctx = ctxEl.getContext('2d');

        if (this.investmentTimelineChart) {
            this.investmentTimelineChart.destroy();
        }

        this.investmentTimelineChart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    label: 'Versé (€)',
                    data: values,
                    backgroundColor: 'rgba(59, 130, 246, 0.7)',
                    borderColor: '#3b82f6',
                    borderWidth: 1,
                    borderRadius: 3,
                    borderSkipped: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => `${c.parsed.y.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} €`
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8', font: { size: 9 }, maxRotation: 45, minRotation: 30 },
                        grid: { display: false }
                    },
                    y: {
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 9 },
                            callback: (v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                        beginAtZero: true
                    }
                }
            }
        });

        // --- Wire toggle buttons ---
        const btnMonthly = document.getElementById('timeline-btn-monthly');
        const btnYearly = document.getElementById('timeline-btn-yearly');

        if (btnMonthly && btnYearly) {
            // Avoid duplicate listeners by replacing with clones
            const newBtnMonthly = btnMonthly.cloneNode(true);
            const newBtnYearly = btnYearly.cloneNode(true);
            btnMonthly.replaceWith(newBtnMonthly);
            btnYearly.replaceWith(newBtnYearly);

            // Style-only: does NOT re-render (avoids infinite recursion)
            const setActiveStyle = (mode) => {
                const isMonthly = mode === 'monthly';
                newBtnMonthly.style.background = isMonthly ? 'var(--accent-blue)' : 'var(--bg-secondary)';
                newBtnMonthly.style.color = isMonthly ? 'white' : 'var(--text-secondary)';
                newBtnMonthly.style.borderColor = isMonthly ? 'var(--accent-blue)' : 'var(--border-color)';
                newBtnYearly.style.background = !isMonthly ? 'var(--accent-blue)' : 'var(--bg-secondary)';
                newBtnYearly.style.color = !isMonthly ? 'white' : 'var(--text-secondary)';
                newBtnYearly.style.borderColor = !isMonthly ? 'var(--accent-blue)' : 'var(--border-color)';
            };

            // Click handlers render with new mode then update style
            newBtnMonthly.addEventListener('click', () => {
                this.renderInvestmentTimeline('monthly');
            });
            newBtnYearly.addEventListener('click', () => {
                this.renderInvestmentTimeline('yearly');
            });

            // Set initial active style (no re-render needed — already rendered above)
            setActiveStyle(viewMode);
        }
    }

    // =============================================
    // MODAL: DETAIL VERSEMENTS (TIMELINE)
    // =============================================
    openInvestmentTimelineModal(viewMode = 'monthly') {
        console.log(`🚀 openInvestmentTimelineModal EXECUTED! (Mode: ${viewMode})`);
        const modal = document.getElementById('timeline-detail-modal');
        if (!modal) {
            console.error('❌ Modal #timeline-detail-modal NOT FOUND');
            return;
        }

        const purchases = this.storage.getPurchases();
        const buys = purchases.filter(p => {
            const t = (p.type || '').toLowerCase();
            const at = (p.assetType || '').toLowerCase();
            return t !== 'dividend' && t !== 'sell' && t !== 'sale' && at !== 'cash';
        });

        if (buys.length === 0) return;

        let totalInvested = 0;
        let totalTrades = 0;
        let firstDate = new Date();
        let lastDate = new Date(0);
        
        const monthlyAgg = {};
        const yearlyAgg = {};
        const assetTypeAgg = {};

        // Top 10 purchases
        const topPurchases = [];

        buys.forEach(p => {
            const amount = (parseFloat(p.price) || 0) * (parseFloat(p.quantity) || 0);
            if (amount <= 0) return;

            totalInvested += amount;
            totalTrades++;

            const d = new Date(p.date);
            if (d < firstDate) firstDate = d;
            if (d > lastDate) lastDate = d;

            // Monthly Aggregation
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            monthlyAgg[key] = (monthlyAgg[key] || 0) + amount;

            // Yearly Aggregation
            const yKey = `${d.getFullYear()}`;
            yearlyAgg[yKey] = (yearlyAgg[yKey] || 0) + amount;

            // Asset Type Aggregation
            const typeKey = p.assetType || 'Stock'; // Fallback
            assetTypeAgg[typeKey] = (assetTypeAgg[typeKey] || 0) + amount;

            // Store for Top 10
            topPurchases.push({
                date: d,
                ticker: p.ticker || 'N/A',
                amount: amount
            });
        });

        // Calculate Stats
        const monthsDiff = (lastDate.getFullYear() - firstDate.getFullYear()) * 12 + (lastDate.getMonth() - firstDate.getMonth()) + 1;
        const activeMonths = Object.keys(monthlyAgg).length;
        const avgMonthly = totalInvested / Math.max(1, monthsDiff);
        
        let bestMonth = '';
        let bestMonthValue = 0;
        for (const [m, val] of Object.entries(monthlyAgg)) {
            if (val > bestMonthValue) {
                bestMonthValue = val;
                const [y, mStr] = m.split('-');
                bestMonth = new Date(+y, +mStr - 1).toLocaleDateString('fr-FR', { month: 'short', year: 'numeric' });
            }
        }

        // Fill Stats
        const monthsEl = document.getElementById('timeline-active-months');
        if (monthsEl) monthsEl.textContent = `${monthsDiff} mois`; // e.g. "14 mois"

        const avgEl = document.getElementById('timeline-avg-month');
        if (avgEl) avgEl.textContent = this.formatEUR(avgMonthly);

        const bestEl = document.getElementById('timeline-best-month');
        if (bestEl) bestEl.textContent = `${this.formatEUR(bestMonthValue)} (${bestMonth})`;

        const tradesEl = document.getElementById('timeline-total-trades');
        if (tradesEl) tradesEl.textContent = totalTrades.toString();

        // Fill Top 10 Table
        topPurchases.sort((a, b) => b.amount - a.amount);
        const top10 = topPurchases.slice(0, 10);
        
        const tableBody = document.getElementById('timeline-top-table-body');
        if (tableBody) {
            tableBody.innerHTML = '';
            top10.forEach(p => {
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid var(--border-color)';
                
                const formattedDate = p.date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
                
                tr.innerHTML = `
                    <td style="padding: 10px 8px;">${formattedDate}</td>
                    <td style="padding: 10px 8px; font-weight: 600;">${p.ticker}</td>
                    <td style="padding: 10px 8px; text-align: right; color: var(--text-primary); font-family: 'Roboto Mono', monospace;">${this.formatEUR(p.amount)}</td>
                `;
                tableBody.appendChild(tr);
            });
        }

        // Render Doughnut Chart
        const ctxEl = document.getElementById('timeline-doughnut-chart');
        if (ctxEl) {
            const ctx = ctxEl.getContext('2d');
            if (this.timelineDoughnutChart) {
                this.timelineDoughnutChart.destroy();
            }

            const bgColors = {
                'Stock': '#3b82f6',
                'ETF': '#10b981',
                'Crypto': '#f59e0b',
                'Real Estate': '#8b5cf6'
            };
            const defaultColors = ['#ec4899', '#06b6d4', '#84cc16'];
            
            const labels = [];
            const data = [];
            const colors = [];

            let i = 0;
            for (const [type, val] of Object.entries(assetTypeAgg)) {
                labels.push(type);
                data.push(val);
                colors.push(bgColors[type] || defaultColors[i % defaultColors.length]);
                i++;
            }

            this.timelineDoughnutChart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: labels,
                    datasets: [{
                        data: data,
                        backgroundColor: colors,
                        borderWidth: 0,
                        hoverOffset: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '70%',
                    plugins: {
                        legend: {
                            position: 'right',
                            labels: {
                                color: '#94a3b8',
                                font: { size: 12 },
                                usePointStyle: true,
                                padding: 20
                            }
                        },
                        tooltip: {
                            callbacks: {
                                label: (c) => {
                                    const value = c.parsed;
                                    const pct = ((value / totalInvested) * 100).toFixed(1) + '%';
                                    return ` ${c.label}: ${value.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} € (${pct})`;
                                }
                            }
                        }
                    }
                }
            });
        }

        // ====================================================
        // Render Modal Bar Chart (Timeline)
        // ====================================================
        const barCtxEl = document.getElementById('timeline-modal-bar-chart');
        if (barCtxEl) {
            const barCtx = barCtxEl.getContext('2d');
            if (this.timelineModalBarChart) {
                this.timelineModalBarChart.destroy();
            }

            const aggData = viewMode === 'monthly' ? monthlyAgg : yearlyAgg;

            // Sort keys chronologically
            const sortedKeys = Object.keys(aggData).sort();

            let displayLabels = [];
            const displayData = [];

            if (viewMode === 'monthly') {
                sortedKeys.forEach(k => {
                    const [y, m] = k.split('-');
                    displayLabels.push(`${m}/${y.substring(2)}`);
                    displayData.push(aggData[k]);
                });
            } else {
                sortedKeys.forEach(k => {
                    displayLabels.push(k);
                    displayData.push(aggData[k]);
                });
            }

            this.timelineModalBarChart = new Chart(barCtx, {
                type: 'bar',
                data: {
                    labels: displayLabels,
                    datasets: [{
                        label: 'Investi',
                        data: displayData,
                        backgroundColor: '#3b82f6',
                        borderRadius: 4,
                        barPercentage: 0.7,
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (c) => ` ${c.parsed.y.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
                            }
                        }
                    },
                    scales: {
                        x: {
                            grid: { display: false, drawBorder: false },
                            ticks: {
                                color: '#94a3b8',
                                font: { size: 10 },
                                maxRotation: 45,
                                minRotation: 45
                            }
                        },
                        y: {
                            grid: { color: 'rgba(255, 255, 255, 0.05)', drawBorder: false },
                            ticks: {
                                color: '#94a3b8',
                                font: { size: 10 },
                                callback: val => val >= 1000 ? (val / 1000) + 'k' : val
                            }
                        }
                    }
                }
            });
        }

        // --- Wire Bar Chart Toggle Buttons ---
        const btnMonthly = document.getElementById('modal-timeline-btn-monthly');
        const btnYearly = document.getElementById('modal-timeline-btn-yearly');

        if (btnMonthly && btnYearly) {
            const newBtnMonthly = btnMonthly.cloneNode(true);
            const newBtnYearly = btnYearly.cloneNode(true);
            btnMonthly.replaceWith(newBtnMonthly);
            btnYearly.replaceWith(newBtnYearly);

            const setActiveStyle = (mode) => {
                const isMonthly = mode === 'monthly';
                newBtnMonthly.style.background = isMonthly ? 'var(--accent-blue)' : 'var(--bg-secondary)';
                newBtnMonthly.style.color = isMonthly ? 'white' : 'var(--text-secondary)';
                newBtnMonthly.style.borderColor = isMonthly ? 'var(--accent-blue)' : 'var(--border-color)';
                newBtnYearly.style.background = !isMonthly ? 'var(--accent-blue)' : 'var(--bg-secondary)';
                newBtnYearly.style.color = !isMonthly ? 'white' : 'var(--text-secondary)';
                newBtnYearly.style.borderColor = !isMonthly ? 'var(--accent-blue)' : 'var(--border-color)';
            };

            newBtnMonthly.addEventListener('click', () => {
                this.openInvestmentTimelineModal('monthly');
            });
            newBtnYearly.addEventListener('click', () => {
                this.openInvestmentTimelineModal('yearly');
            });

            setActiveStyle(viewMode);
        }

        // Show Modal
        modal.style.display = 'flex';
        modal.style.visibility = 'visible';
        modal.style.opacity = '1';
        modal.style.zIndex = '10000000';
    }
}

(async () => {
    const app = new AnalyticsApp();
    window.analyticsApp = app;

    try {
        await app.init();
    } catch (error) {
        console.error('❌ Erreur fatale:', error);
        alert('Erreur lors du chargement des analytics');
    }
})();