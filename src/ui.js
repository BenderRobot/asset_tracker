// ========================================
// ui.js - (v4 - Market Status dans Var Today)
// ========================================

export class UIComponents {
    constructor(storage) {
        this.storage = storage;
    }

    // MODIF : Ajout du paramètre 'marketStatusObj' à la fin
    updatePortfolioSummary(summary, movementsCount, cashReserveTotal = 0, marketStatusObj = null) {
        
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

		// 1. TOTAL VALUE
        const totalValueWithCash = (summary.totalCurrentEUR || 0) + cashReserveTotal;
        updateHTML('total-current', `${formatSimple(totalValueWithCash)}`);

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

		// ... (Reste de la fonction inchangé : Best/Worst Assets, etc.) ...
		if (summary.bestAsset) {
			const bestColor = summary.bestAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('best-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.bestAsset.name}">
					${summary.bestAsset.name}
				</div>
				<div style="font-size: 12px; color: ${bestColor}; margin-top: 2px;">
					${formatPctSimple(summary.bestAsset.gainPct)}
				</div>
			`);
		} else { updateHTML('best-asset', '-'); }

		if (summary.worstAsset) {
			const worstColor = summary.worstAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
			updateHTML('worst-asset', `
				<div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.worstAsset.name}">
					${summary.worstAsset.name}
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