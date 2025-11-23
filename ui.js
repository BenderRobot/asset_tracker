// ========================================
// ui.js - (v3 - Best/Worst Day)
// ========================================

export class UIComponents {
    constructor(storage) {
        this.storage = storage;
    }

    // MODIFICATION : Gère bestDayAsset et worstDayAsset
    updatePortfolioSummary(summary, movementsCount, cashReserveTotal = 0) {
        
        // summary contient maintenant :
        // { ... bestAsset, worstAsset, bestDayAsset, worstDayAsset ... }

        console.log('📊 Résumé Portfolio (Reçu):', summary);
        console.log('💰 Réserve Cash (Reçu):', cashReserveTotal);

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

        // 1. TOTAL VALUE (Actifs + Cash)
        const totalValueWithCash = (summary.totalCurrentEUR || 0) + cashReserveTotal;
        updateHTML('total-current', `
            ${formatSimple(totalValueWithCash)}
            <div style="font-size: 14px; font-weight: 400; opacity: 0.7; margin-top: 4px;">
                Invested: ${formatSimple(summary.totalInvestedEUR)}
            </div>
        `);

        // 2. TOTAL RETURN
        const gainColor = summary.gainTotal >= 0 ? '#10b981' : '#ef4444';
        updateHTML('total-gain-loss', `<span style="color: ${gainColor}">${formatSimple(summary.gainTotal)}</span>`);
        updateHTML('total-gain-pct', `<span style="color: ${gainColor}">${formatPctSimple(summary.gainPct)}</span>`);

        // 3. VAR TODAY
        const dayChangeColor = summary.totalDayChangeEUR >= 0 ? '#10b981' : '#ef4444';
        updateHTML('total-invested', `<span style="color: ${dayChangeColor}">${formatSimple(summary.totalDayChangeEUR)}</span>`);
        
        const avgCostEl = document.getElementById('avg-cost-per-share');
        if (avgCostEl) {
            avgCostEl.innerHTML = `<span style="color: ${dayChangeColor}">${formatPctSimple(summary.dayChangePct)}</span>`;
        }

        // 4. BEST PERFORMER (TOTAL)
        if (summary.bestAsset) {
            const bestColor = summary.bestAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
            // MODIFICATION : .name au lieu de .ticker
            // AJOUT : Style pour couper le texte si trop long (...)
            updateHTML('best-asset', `
                <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.bestAsset.name}">
                    ${summary.bestAsset.name}
                </div>
                <div style="font-size: 12px; color: ${bestColor}; margin-top: 2px;">
                    ${formatPctSimple(summary.bestAsset.gainPct)}
                </div>
            `);
        } else {
            updateHTML('best-asset', '-');
        }

        // 5. WORST PERFORMER (TOTAL)
        if (summary.worstAsset) {
            const worstColor = summary.worstAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
            // MODIFICATION : .name au lieu de .ticker
            updateHTML('worst-asset', `
                <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.worstAsset.name}">
                    ${summary.worstAsset.name}
                </div>
                <div style="font-size: 12px; color: ${worstColor}; margin-top: 2px;">
                    ${formatPctSimple(summary.worstAsset.gainPct)}
                </div>
            `);
        } else {
            updateHTML('worst-asset', '-');
        }
        
        // 6. BEST PERFORMER (DAY)
        if (summary.bestDayAsset) {
            const bestDayColor = summary.bestDayAsset.dayPct >= 0 ? '#10b981' : '#ef4444';
            // MODIFICATION : .name au lieu de .ticker
            updateHTML('best-day-asset', `
                <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.bestDayAsset.name}">
                    ${summary.bestDayAsset.name}
                </div>
                <div style="font-size: 12px; color: ${bestDayColor}; margin-top: 2px;">
                    ${formatPctSimple(summary.bestDayAsset.dayPct)}
                </div>
            `);
        } else {
            updateHTML('best-day-asset', '-');
        }

        // 7. WORST PERFORMER (DAY)
        if (summary.worstDayAsset) {
            const worstDayColor = summary.worstDayAsset.dayPct >= 0 ? '#10b981' : '#ef4444';
            // MODIFICATION : .name au lieu de .ticker
            updateHTML('worst-day-asset', `
                <div style="font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${summary.worstDayAsset.name}">
                    ${summary.worstDayAsset.name}
                </div>
                <div style="font-size: 12px; color: ${worstDayColor}; margin-top: 2px;">
                    ${formatPctSimple(summary.worstDayAsset.dayPct)}
                </div>
            `);
        } else {
            updateHTML('worst-day-asset', '-');
        }

        // 7. AJOUT : WORST PERFORMER (DAY)
        if (summary.worstDayAsset) {
            const worstDayColor = summary.worstDayAsset.dayPct >= 0 ? '#10b981' : '#ef4444';
            updateHTML('worst-day-asset', `
                <div style="font-size: 14px; font-weight: 600;">${summary.worstDayAsset.ticker}</div>
                <div style="font-size: 12px; color: ${worstDayColor}; margin-top: 2px;">${formatPctSimple(summary.worstDayAsset.dayPct)}</div>
            `);
        } else {
            updateHTML('worst-day-asset', '-');
        }

        // Stats simples (pour index.html)
        updateEl('unique-assets', summary.assetsCount);
        updateEl('total-movements', movementsCount);
        
        // Cash Reserve (pour les deux pages)
        updateEl('cash-reserve', formatSimple(cashReserveTotal));
    }

    // ... (Reste de ui.js inchangé) ...
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