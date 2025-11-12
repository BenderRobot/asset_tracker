// ========================================
// ui.js - Composants UI avec GESTION DEVISES AMÉLIORÉE
// ========================================

import { USD_TO_EUR_RATE } from './config.js';

export class UIComponents {
    constructor(storage) {
        this.storage = storage;
    }

    // RÉSUMÉ DU PORTEFEUILLE - Ne fait plus que de l'affichage !
    updatePortfolioSummary(summary, movementsCount) {
        
        // summary contient déjà :
        // { totalInvestedEUR, totalCurrentEUR, totalDayChangeEUR,
        //   gainTotal, gainPct, dayChangePct,
        //   bestAsset, worstAsset, assetsCount }

        console.log('📊 Résumé Portfolio (Reçu):', summary);

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
        updateHTML('total-current', `
            ${formatSimple(summary.totalCurrentEUR)}
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

        // 4. BEST PERFORMER
        if (summary.bestAsset) {
            const bestColor = summary.bestAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
            updateHTML('best-asset', `
                <div style="font-size: 14px; font-weight: 600;">${summary.bestAsset.ticker}</div>
                <div style="font-size: 12px; color: ${bestColor}; margin-top: 2px;">${formatPctSimple(summary.bestAsset.gainPct)}</div>
            `);
        } else {
            updateHTML('best-asset', '-');
        }

        // 5. WORST PERFORMER
        if (summary.worstAsset) {
            const worstColor = summary.worstAsset.gainPct >= 0 ? '#10b981' : '#ef4444';
            updateHTML('worst-asset', `
                <div style="font-size: 14px; font-weight: 600;">${summary.worstAsset.ticker}</div>
                <div style="font-size: 12px; color: ${worstColor}; margin-top: 2px;">${formatPctSimple(summary.worstAsset.gainPct)}</div>
            `);
        } else {
            updateHTML('worst-asset', '-');
        }

        // Stats simples
        const updateEl = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        };

        updateEl('unique-assets', summary.assetsCount);
        updateEl('total-movements', movementsCount); // Utilise le compte de 'investmentsPage'
        updateEl('cash-reserve', formatSimple(0));
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