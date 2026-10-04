function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function defaultCurrency(value) {
    return Number(value).toLocaleString('fr-FR', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }) + ' €';
}

function assetLabel(asset) {
    return `${asset?.name || ''} ${asset?.ticker || ''}`.trim();
}

export function getPerformerRows(assets, type, sortKey = 'gainEUR', sortDirection = type === 'loser' ? 'asc' : 'desc') {
    const isLoser = type === 'loser';
    const rows = (assets || []).filter(asset => {
        if (!Number.isFinite(asset?.gainEUR) || !Number.isFinite(asset?.gainPct)) return false;
        return isLoser ? asset.gainEUR < 0 : asset.gainEUR > 0;
    });

    const valueFor = (asset) => {
        if (sortKey === 'asset') return assetLabel(asset);
        return Number(asset?.[sortKey]);
    };
    const direction = sortDirection === 'asc' ? 1 : -1;

    return rows.sort((a, b) => {
        const left = valueFor(a);
        const right = valueFor(b);
        let comparison;
        if (typeof left === 'string' || typeof right === 'string') {
            comparison = String(left).localeCompare(String(right), 'fr', { sensitivity: 'base' });
        } else {
            comparison = left - right;
        }
        if (comparison === 0) comparison = String(a.ticker || '').localeCompare(String(b.ticker || ''));
        return comparison * direction;
    });
}

/**
 * Monte le tableau commun aux modals Top/Worst Performers d'Analytics et du
 * Dashboard. Le composant possède le tri et les totaux afin que les deux pages
 * ne puissent plus diverger dans leurs filtres ou leurs calculs.
 */
export function mountPerformerTable(container, assets, type, options = {}) {
    if (!container) return null;
    const isLoser = type === 'loser';
    const formatCurrency = options.formatCurrency || defaultCurrency;
    let sortKey = options.sortKey || 'gainEUR';
    let sortDirection = options.sortDirection || (isLoser ? 'asc' : 'desc');

    const render = () => {
        const rows = getPerformerRows(assets, type, sortKey, sortDirection);
        const totalGain = rows.reduce((sum, asset) => sum + asset.gainEUR, 0);
        const totalInvested = rows.reduce((sum, asset) => sum + (asset.invested || 0), 0);
        const weightedPct = totalInvested > 0 ? (totalGain / totalInvested) * 100 : 0;
        const valueLabel = isLoser ? 'Perte (€)' : 'Gain (€)';
        const pctLabel = isLoser ? 'Perte (%)' : 'Gain (%)';
        const totalLabel = isLoser ? 'TOTAL PERTES' : 'TOTAL GAINS';
        const color = isLoser ? '#ef4444' : '#10b981';

        const sortClass = key => key === sortKey ? `sort-${sortDirection}` : '';
        const ariaSort = key => key === sortKey ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none';
        const signedCurrency = value => value > 0 ? `+${formatCurrency(value)}` : formatCurrency(value);
        const signedPct = value => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;

        const bodyRows = rows.length > 0
            ? rows.map(asset => `
                <tr>
                    <td>
                        <div class="performer-asset-name">${escHtml(asset.name || asset.ticker)}</div>
                        <div class="performer-asset-ticker">${escHtml(asset.ticker)}</div>
                    </td>
                    <td class="performer-number" style="color:${color};font-weight:600;">${signedCurrency(asset.gainEUR)}</td>
                    <td class="performer-number" style="color:${color};font-weight:600;">${signedPct(asset.gainPct)}</td>
                </tr>`).join('')
            : `<tr><td colspan="3" class="performer-empty">Aucun actif ${isLoser ? 'en perte' : 'en gain'}</td></tr>`;

        container.innerHTML = `
            <div class="performer-table-scroll">
                <table class="performer-detail-table performer-detail-table--${type}">
                    <thead>
                        <tr>
                            <th data-sort="asset" class="${sortClass('asset')}" aria-sort="${ariaSort('asset')}">Actif</th>
                            <th data-sort="gainEUR" class="${sortClass('gainEUR')}" aria-sort="${ariaSort('gainEUR')}">${valueLabel}</th>
                            <th data-sort="gainPct" class="${sortClass('gainPct')}" aria-sort="${ariaSort('gainPct')}">${pctLabel}</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bodyRows}
                        <tr class="performer-total-row">
                            <td>${totalLabel}</td>
                            <td class="performer-number" style="color:${color};">${signedCurrency(totalGain)}</td>
                            <td class="performer-number" style="color:${color};">${signedPct(weightedPct)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>`;

        container.querySelectorAll('th[data-sort]').forEach(header => {
            header.addEventListener('click', () => {
                const nextKey = header.dataset.sort;
                if (sortKey === nextKey) {
                    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                } else {
                    sortKey = nextKey;
                    sortDirection = nextKey === 'asset' ? 'asc' : 'desc';
                }
                render();
            });
        });
    };

    render();
    return {
        getSort: () => ({ key: sortKey, direction: sortDirection })
    };
}
