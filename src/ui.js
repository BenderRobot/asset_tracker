// ========================================
// ui.js - (v4 - Market Status dans Var Today)
// ========================================

function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export class UIComponents {
    constructor(storage, dataManager = null) {
        this.storage = storage;
        this.dataManager = dataManager;
    }

    // SINGLE SOURCE OF TRUTH : les 5 ids du haut (Total Value/Return/Var Today) ne
    // sont écrits QUE par le listener portfolioKPIs sur les pages qui ont un
    // graphique (Dashboard, Investments) — voir dashboardApp.js/investmentsPage.js
    // subscribeToKPIs(). Cette méthode reste utilisée directement par les pages
    // SANS graphique (Achats), via le wrapper updatePortfolioSummary ci-dessous.
    updateTopKPIs(summary, cashReserveTotal = 0, marketStatusObj = null) {
        const formatSimple = (value) => {
            if (value === null || value === undefined || isNaN(value)) return '-';
            return value.toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' €';
        };
        const formatPctSimple = (value) => {
            if (value === null || isNaN(value)) return '-';
            const sign = value >= 0 ? '+' : '';
            return sign + value.toFixed(2) + ' %';
        };
        const updateHTML = (id, html) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = html;
        };

        // 1. TOTAL VALUE
        const totalValueWithCash = (summary.totalCurrentEUR || 0) + cashReserveTotal;
        updateHTML('total-current', `${formatSimple(totalValueWithCash)}`);

        // Click breakdown: Total Value = Invested + Total Return + Cash. Cash
        // isn't available here as its own number (cashReserveTotal is always 0
        // from both callers — totalCurrentEUR already includes it, see their
        // own comments) — derive it instead of plumbing a new parameter, so the
        // modal can never disagree with the number it explains: this equation
        // is exact by construction (historicalChart.js _computeAggregateKPIs
        // defines totalReturn = totalValue - cash - investedAssetOnly).
        this._updateTotalValueModal(summary, totalValueWithCash, formatSimple, formatPctSimple);

        // FIX UNIFIÉ: Met à jour la valeur "Invested" sur les deux pages
        const investedSubtitleEl = document.getElementById('invested');
        if (investedSubtitleEl) {
            investedSubtitleEl.textContent = `Invested: ${formatSimple(summary.totalInvestedEUR)}`;
            // Style inline pour correspondre au design du dashboard (optionnel, mais assure la cohérence)
            investedSubtitleEl.style.fontSize = '14px';
            investedSubtitleEl.style.opacity = '0.9';
            investedSubtitleEl.style.color = 'var(--text-secondary)';
        }

        // 2. TOTAL RETURN
        const gainColor = summary.gainTotal >= 0 ? '#10b981' : '#ef4444';
        updateHTML('total-gain-loss', `<span style="color: ${gainColor}">${formatSimple(summary.gainTotal)}</span>`);
        updateHTML('total-gain-pct', `<span style="color: ${gainColor}">${formatPctSimple(summary.gainPct)}</span>`);

        // 3. VAR TODAY + MARKET STATUS
        const dayChangeColor = summary.totalDayChangeEUR >= 0 ? '#10b981' : '#ef4444';
        updateHTML('total-invested', `<span style="color: ${dayChangeColor}">${formatSimple(summary.totalDayChangeEUR)}</span>`);

        const avgCostEl = document.getElementById('avg-cost-per-share');
        if (avgCostEl) {
            avgCostEl.innerHTML = `<span style="color: ${dayChangeColor}">${formatPctSimple(summary.dayChangePct)}</span>`;
        }

		// === INJECTION DU BADGE STATUS ===
		if (marketStatusObj) {
			// On cible le header de la carte "Var Today" (qui contient l'ID 'total-invested' dans son body)
			const varTodayValueEl = document.getElementById('total-invested');
			if (varTodayValueEl) {
				const card = varTodayValueEl.closest('.summary-card');
				if (card) {
					const header = card.querySelector('.summary-card-label');
					if (header) {
						// On vérifie si le badge existe déjà pour ne pas le dupliquer
						let badge = header.querySelector('.market-status-badge-mini');
						if (!badge) {
							badge = document.createElement('span');
							badge.className = 'market-status-badge-mini';
							// Style inline pour l'intégration immédiate
							badge.style.cssText = "float: right; font-size: 9px; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;";
							header.appendChild(badge);
						}

						// Mise à jour du contenu
						const status = marketStatusObj.getGlobalStatus();
						badge.textContent = status.shortLabel;
						badge.style.color = status.color;
						badge.style.border = `1px solid ${status.color}`;
						badge.style.background = `rgba(${status.color === '#10b981' ? '16, 185, 129' : '251, 191, 36'}, 0.1)`;
					}
				}
			}
		}
    }

    // Total Value's breakdown modal — same visual language as the Dashboard's
    // other KPI modals (gainer/loser/allocation, see dashboardApp.js
    // openKPIModal/.kpi-modal-* classes), but owned here in the shared UI
    // layer instead of duplicated per page, since Total Value's own card
    // exists identically on both Dashboard and Investments (see updateTopKPIs
    // above). Built once, refreshed with fresh numbers on every KPI update.
    _ensureTotalValueModal() {
        let modal = document.getElementById('total-value-modal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'total-value-modal';
        modal.className = 'kpi-modal-overlay';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="kpi-modal-box" style="max-width:460px;">
                <div class="kpi-modal-header">
                    <div style="display:flex;align-items:center;gap:10px;">
                        <i class="fas fa-wallet" style="font-size:15px;color:#3b82f6;"></i>
                        <h3>Détail — Total Value</h3>
                    </div>
                    <button class="kpi-modal-close" id="close-total-value-modal">&times;</button>
                </div>
                <div class="kpi-modal-body" id="total-value-modal-body" style="padding:20px 24px;"></div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => { modal.style.display = 'none'; };
        modal.querySelector('#close-total-value-modal').addEventListener('click', close);
        modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

        return modal;
    }

    // Three sections: the Total Value breakdown itself (Investi + Rendement +
    // Cash), then Rendement total and Var Today — each with their own
    // per-broker detail, via dataManager.calculateByBroker() (SSOT: reuses
    // calculateHoldings/calculateSummary/calculateCashReserve, just scoped per
    // broker, instead of a parallel calculation living in this modal).
    _updateTotalValueModal(summary, totalValueWithCash, formatSimple, formatPctSimple) {
        const invested = summary.totalInvestedEUR || 0;
        const totalReturn = summary.gainTotal || 0;
        const cash = totalValueWithCash - invested - totalReturn;
        const dayChange = summary.totalDayChangeEUR ?? null;
        const dayChangePct = summary.dayChangePct ?? null;
        const color = (v) => (v >= 0 ? '#10b981' : '#ef4444');

        const allBrokers = this.dataManager ? this.dataManager.calculateByBroker(this.storage.getPurchases()) : [];
        // The card this modal explains can itself be showing a FILTERED figure
        // (broker/ticker/type filter active on the Investments page) — but
        // calculateByBroker() above always covers every broker in storage.
        // Only show that breakdown when the caller confirms nothing is
        // filtered (see investmentsPage.js's hasActiveFilter) — showing an
        // unfiltered per-broker split under a filtered total would silently
        // not add up. NOT decided by comparing sums: kpis.totalValue comes
        // from the graph's TWR engine while this per-broker split is a plain
        // calculateHoldings sum — two different, both-correct methodologies
        // that don't reconcile to the cent even with no filter active.
        const byBroker = (allBrokers.length > 1 && !summary.hasActiveFilter) ? allBrokers : [];

        const modal = this._ensureTotalValueModal();
        const body = document.getElementById('total-value-modal-body');
        if (body) {
            const row = (label, value, rowColor, opts = {}) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:${opts.compact ? '5px 0' : '10px 0'};${opts.noBorder ? '' : 'border-bottom:1px solid var(--border-color);'}">
                    <span style="color:var(--text-muted);font-size:${opts.compact ? '12px' : '13px'};${opts.indent ? 'padding-left:12px;' : ''}">${escHtml(label)}</span>
                    <span style="font-weight:${opts.compact ? '500' : '600'};${rowColor ? `color:${rowColor};` : ''}font-size:${opts.compact ? '12px' : '14px'};">${formatSimple(value)}${opts.pct != null ? ` <span style="opacity:0.85;">(${formatPctSimple(opts.pct)})</span>` : ''}</span>
                </div>`;

            const sectionTitle = (label) => `<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin:18px 0 4px;">${label}</div>`;

            const brokerRows = (valueKey, pctKey) => byBroker.length === 0 ? '' : byBroker.map(b =>
                row(b.broker, b[valueKey], color(b[valueKey]), { compact: true, indent: true, noBorder: true, pct: b[pctKey] })
            ).join('');

            body.innerHTML =
                `<div id="tv-section-total">` +
                    sectionTitle('Vue d\'ensemble') +
                    row('Investi', invested) +
                    row('Rendement total', totalReturn, color(totalReturn)) +
                    row('Cash', cash) +
                    `<div style="display:flex;justify-content:space-between;align-items:center;padding-top:14px;margin-top:4px;">
                        <span style="font-weight:700;">Total Value</span>
                        <span style="font-weight:700;font-size:16px;">${formatSimple(totalValueWithCash)}</span>
                    </div>` +
                `</div>` +
                `<div id="tv-section-return">` +
                    sectionTitle('Rendement total') +
                    row(byBroker.length ? 'Ensemble du portefeuille' : 'Total', totalReturn, color(totalReturn), { pct: summary.gainPct, noBorder: byBroker.length === 0 }) +
                    brokerRows('totalReturn', 'totalReturnPct') +
                `</div>` +
                `<div id="tv-section-day">` +
                    sectionTitle('Var Today') +
                    (dayChange != null
                        ? row(byBroker.length ? 'Ensemble du portefeuille' : 'Total', dayChange, color(dayChange), { pct: dayChangePct, noBorder: byBroker.length === 0 }) +
                          brokerRows('dayChange', 'dayChangePct')
                        : `<div style="color:var(--text-muted);font-size:12px;">Non disponible</div>`) +
                `</div>`;
        }

        // All three top KPI cards (Total Value / Total Return / Var Today) open
        // this SAME modal now that it covers all three — each jumps straight
        // to its own section instead of dumping the visitor at the top and
        // making them scroll to find what they clicked on.
        const bindTrigger = (cardValueId, sectionId) => {
            const card = document.getElementById(cardValueId)?.closest('.summary-card');
            if (!card) return;
            card.style.cursor = 'pointer';
            // updateTopKPIs runs on every render — guard so the listener is
            // bound exactly once instead of piling up a new one each time.
            if (card.dataset.totalValueClickBound) return;
            card.dataset.totalValueClickBound = '1';
            card.addEventListener('click', () => {
                modal.style.display = 'flex';
                requestAnimationFrame(() => {
                    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            });
        };
        bindTrigger('total-current', 'tv-section-total');
        bindTrigger('total-gain-loss', 'tv-section-return');
        bindTrigger('total-invested', 'tv-section-day');
    }

    // Tout ce qui n'est PAS les 5 KPI du haut : best/worst asset (total + jour),
    // cash reserve, compteurs. Appelé sur Dashboard/Investments (à la place de
    // updatePortfolioSummary) ET sur Achats (via le wrapper).
    updateSecondaryKPIs(summary, movementsCount, cashReserveTotal = 0) {
        const formatSimple = (value) => {
            if (value === null || value === undefined || isNaN(value)) return '-';
            return value.toLocaleString('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' €';
        };
        const formatPctSimple = (value) => {
            if (value === null || isNaN(value)) return '-';
            const sign = value >= 0 ? '+' : '';
            return sign + value.toFixed(2) + ' %';
        };
        const updateHTML = (id, html) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = html;
        };
        const updateEl = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

		if (summary.bestAsset) {
			const bestColor = summary.bestAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('best-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(summary.bestAsset.name)}">
					${escHtml(summary.bestAsset.name)}
				</div>
				<div style="font-size: 12px; color: ${bestColor}; margin-top: 2px;">
					${formatPctSimple(summary.bestAsset.gainPct)}
				</div>
			`);
		} else { updateHTML('best-asset', '-'); }

		if (summary.worstAsset) {
			const worstColor = summary.worstAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('worst-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(summary.worstAsset.name)}">
					${escHtml(summary.worstAsset.name)}
				</div>
				<div style="font-size: 12px; color: ${worstColor}; margin-top: 2px;">
					${formatPctSimple(summary.worstAsset.gainPct)}
				</div>
			`);
		} else { updateHTML('worst-asset', '-'); }
		
		if (summary.bestDayAsset) {
			const bestDayColor = summary.bestDayAsset.dayPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('best-day-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.bestDayAsset.name}">
					${summary.bestDayAsset.name}
				</div>
				<div style="font-size: 12px; color: ${bestDayColor}; margin-top: 2px;">
					${formatPctSimple(summary.bestDayAsset.dayPct)}
				</div>
			`);
		} else { updateHTML('best-day-asset', '-'); }

		if (summary.worstDayAsset) {
			const worstDayColor = summary.worstDayAsset.dayPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('worst-day-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.worstDayAsset.name}">
					${summary.worstDayAsset.name}
				</div>
				<div style="font-size: 12px; color: ${worstDayColor}; margin-top: 2px;">
					${formatPctSimple(summary.worstDayAsset.dayPct)}
				</div>
			`);
		} else { updateHTML('worst-day-asset', '-'); }

		updateEl('unique-assets', summary.assetsCount);
		updateEl('total-movements', movementsCount);
		updateEl('cash-reserve', formatSimple(cashReserveTotal));
	}

    // Wrapper conservé pour les pages SANS graphique (Achats) : seule écriture des
    // 5 KPI du haut là où aucun listener portfolioKPIs n'existe. Dashboard/Investments
    // n'appellent plus cette méthode directement (voir updateSecondaryKPIs ci-dessus).
    updatePortfolioSummary(summary, movementsCount, cashReserveTotal = 0, marketStatusObj = null) {
        this.updateTopKPIs(summary, cashReserveTotal, marketStatusObj);
        this.updateSecondaryKPIs(summary, movementsCount, cashReserveTotal);
    }

	// PAGINATION
    renderPagination(currentPage, totalPages, callback) {
        const paginationEl = document.getElementById('pagination');
        if (!paginationEl) return;
        
        paginationEl.innerHTML = '';

        if (totalPages <= 1) {
            paginationEl.style.display = 'none';
            return;
        }
        
        paginationEl.style.display = 'flex';

        const prevBtn = document.createElement('button');
        prevBtn.textContent = '←';
        prevBtn.disabled = currentPage === 1;
        prevBtn.onclick = () => callback(currentPage - 1);
        paginationEl.appendChild(prevBtn);

        const maxVisible = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        
        if (endPage - startPage + 1 < maxVisible) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        if (startPage > 1) {
            const firstBtn = document.createElement('button');
            firstBtn.textContent = '1';
            firstBtn.onclick = () => callback(1);
            paginationEl.appendChild(firstBtn);
            
            if (startPage > 2) {
                const dots = document.createElement('span');
                dots.textContent = '...';
                paginationEl.appendChild(dots);
            }
        }

        for (let i = startPage; i <= endPage; i++) {
            const btn = document.createElement('button');
            btn.textContent = i;
            btn.classList.toggle('active', i === currentPage);
            btn.onclick = () => callback(i);
            paginationEl.appendChild(btn);
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) {
                const dots = document.createElement('span');
                dots.textContent = '...';
                paginationEl.appendChild(dots);
            }
            
            const lastBtn = document.createElement('button');
            lastBtn.textContent = totalPages;
            lastBtn.onclick = () => callback(totalPages);
            paginationEl.appendChild(lastBtn);
        }

        const nextBtn = document.createElement('button');
        nextBtn.textContent = '→';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.onclick = () => callback(currentPage + 1);
        paginationEl.appendChild(nextBtn);
    }

    // ACTIONS GROUPÉES
    updateBulkActions(selectedCount) {
        const bulkEl = document.getElementById('bulk-actions');
        if (bulkEl) {
            bulkEl.style.display = selectedCount > 0 ? 'flex' : 'none';
        }
        
        const countEl = document.getElementById('selected-count');
        if (countEl) {
            countEl.textContent = `${selectedCount} selected`;
        }
    }

    // SÉLECTEUR DE TICKER
    populateTickerSelect(purchases) {
        const select = document.getElementById('ticker-select');
        if (!select) return;
        
        const tickers = [...new Set(purchases.map(p => p.ticker.toUpperCase()))].sort();
        select.innerHTML = '<option value="">Choose ticker</option>' +
            tickers.map(t => `<option value="${t}">${t}</option>`).join('');
    }

    destroy() {
        // Nettoyage si besoin
    }
}