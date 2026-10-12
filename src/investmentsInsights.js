const percentFormatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

const dayPercent = asset => asset.displayDayPct ?? asset.displayDayPnlPct ?? asset.dayPct;

function makeText(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
}

function renderRankedAssets(id, holdings, valueOf, descending) {
    const sorted = holdings.filter(asset => Number.isFinite(valueOf(asset)))
        .sort((a, b) => (descending ? valueOf(b) - valueOf(a) : valueOf(a) - valueOf(b)) ||
            String(a.ticker || '').localeCompare(String(b.ticker || '')))
        .slice(0, 3);
    const container = document.getElementById(id);
    if (!container) return;
    container.replaceChildren();
    if (!sorted.length) {
        container.append(makeText('p', 'insight-empty', 'Aucune donnée disponible'));
        return;
    }
    const table = document.createElement('table');
    table.className = 'insight-table';
    table.setAttribute('aria-label', container.closest('.investment-insight')?.querySelector('.stat-label')?.textContent || 'Classement');
    const body = document.createElement('tbody');
    sorted.forEach((asset, index) => {
        const row = document.createElement('tr');
        const label = document.createElement('th');
        label.scope = 'row';
        label.title = `${asset.name || asset.ticker} · ${asset.ticker}`;
        label.append(makeText('span', 'insight-rank', String(index + 1).padStart(2, '0')));
        const identity = makeText('span', 'insight-identity', asset.ticker || asset.name || 'Actif');
        identity.title = asset.name || asset.ticker || '';
        label.append(identity);
        const metric = valueOf(asset);
        const value = makeText('td', metric >= 0 ? 'insight-positive' : 'insight-negative',
            `${metric >= 0 ? '+' : ''}${percentFormatter.format(metric)} %`);
        row.append(label, value);
        body.append(row);
    });
    table.append(body);
    container.append(table);
}

export function renderInvestmentInsights(holdings, cashReserve, brokersList = [], { dividendsOnly = false } = {}) {
    const displayedDay = holdings.some(asset => {
        const displayed = asset.displayDayPct ?? asset.displayDayPnlPct;
        return Number.isFinite(displayed) &&
            (!Number.isFinite(asset.dayPct) || Math.abs(displayed - asset.dayPct) > 0.000001);
    });
    const dayContext = displayedDay ? 'Variation affichée · dernière séance incluse' : 'Variation du jour';
    for (const id of ['best-day-context', 'worst-day-context']) {
        const element = document.getElementById(id);
        if (element) element.textContent = dayContext;
    }
    renderRankedAssets('best-day-asset', holdings, dayPercent, true);
    renderRankedAssets('worst-day-asset', holdings, dayPercent, false);
    renderRankedAssets('best-asset', holdings, asset => asset.gainPct, true);
    renderRankedAssets('worst-asset', holdings, asset => asset.gainPct, false);

    const cash = typeof cashReserve === 'number' ? { total: cashReserve } : cashReserve || {};
    const totalElement = document.getElementById('cash-reserve');
    const walletElement = document.getElementById('cash-wallets');
    const label = document.getElementById('cash-reserve-label');
    if (label) label.textContent = dividendsOnly ? 'Dividendes par wallet' : 'Cash par wallet';
    if (totalElement) totalElement.textContent = Number.isFinite(cash.total) ? moneyFormatter.format(cash.total) : '—';
    if (!walletElement) return;
    walletElement.replaceChildren();

    const wallets = Object.entries(cash.byBroker || {}).map(([broker, amount]) => ({ broker, amount }))
        .sort((a, b) => (Number.isFinite(b.amount) ? b.amount : -Infinity) -
            (Number.isFinite(a.amount) ? a.amount : -Infinity));
    if (!wallets.length) {
        walletElement.append(makeText('p', 'insight-empty', cash.total === 0 ? 'Aucun solde' : 'Détail indisponible'));
        return;
    }
    const canShowShare = Number.isFinite(cash.total) && cash.total > 0 &&
        wallets.every(wallet => Number.isFinite(wallet.amount) && wallet.amount >= 0);
    if (canShowShare) {
        const track = makeText('div', 'wallet-track', '');
        track.setAttribute('aria-hidden', 'true');
        wallets.forEach((wallet, index) => {
            const segment = makeText('span', `wallet-segment wallet-color-${index % 5}`, '');
            segment.style.width = `${Math.max(0, Math.min(100, wallet.amount / cash.total * 100))}%`;
            track.append(segment);
        });
        walletElement.append(track);
    }
    const table = document.createElement('table');
    table.className = 'insight-table wallet-table';
    table.setAttribute('aria-label', 'Cash par wallet en euros');
    const body = document.createElement('tbody');
    wallets.forEach((wallet, index) => {
        const row = document.createElement('tr');
        const name = brokersList.find(broker => broker.value === wallet.broker)?.label || wallet.broker;
        const labelCell = document.createElement('th');
        labelCell.scope = 'row';
        labelCell.title = name;
        labelCell.append(makeText('span', `wallet-dot wallet-color-${index % 5}`, ''));
        labelCell.append(makeText('span', 'insight-identity', name));
        const amount = Number.isFinite(wallet.amount) ? moneyFormatter.format(wallet.amount) : '—';
        const valueCell = makeText('td', wallet.amount < 0 ? 'insight-negative' : '', amount);
        if (canShowShare) {
            valueCell.append(makeText('small', 'wallet-share', `${percentFormatter.format(wallet.amount / cash.total * 100)} %`));
        }
        row.append(labelCell, valueCell);
        body.append(row);
    });
    table.append(body);
    walletElement.append(table);
}
