// ========================================
// ui.js - (v4 - Market Status dans Var Today)
// ========================================

function escHtml(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

export class UIComponents {
    constructor(storage) {
        this.storage = storage;
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
        this._updateTotalValueModal(summary, totalValueWithCash, formatSimple);

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
            <div class="kpi-modal-box" style="max-width:400px;">
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

    _updateTotalValueModal(summary, totalValueWithCash, formatSimple) {
        const totalCard = document.getElementById('total-current')?.closest('.summary-card');
        if (!totalCard) return;

        const invested = summary.totalInvestedEUR || 0;
        const totalReturn = summary.gainTotal || 0;
        const cash = totalValueWithCash - invested - totalReturn;
        const returnColor = totalReturn >= 0 ? '#10b981' : '#ef4444';

        const modal = this._ensureTotalValueModal();
        const body = document.getElementById('total-value-modal-body');
        if (body) {
            const row = (label, value, color) => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-color);">
                    <span style="color:var(--text-muted);font-size:13px;">${label}</span>
                    <span style="font-weight:600;${color ? `color:${color};` : ''}">${formatSimple(value)}</span>
                </div>`;
            body.innerHTML =
                row('Investi', invested) +
                row('Rendement total', totalReturn, returnColor) +
                row('Cash', cash) +
                `<div style="display:flex;justify-content:space-between;align-items:center;padding-top:14px;margin-top:4px;">
                    <span style="font-weight:700;">Total Value</span>
                    <span style="font-weight:700;font-size:16px;">${formatSimple(totalValueWithCash)}</span>
                </div>`;
        }

        totalCard.style.cursor = 'pointer';
        // updateTopKPIs runs on every render — guard so the listener is bound
        // exactly once instead of piling up a new one each time.
        if (!totalCard.dataset.totalValueClickBound) {
            totalCard.dataset.totalValueClickBound = '1';
            totalCard.addEventListener('click', () => { modal.style.display = 'flex'; });
        }
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