const percentFormatter = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

const dayPercent = asset => asset.displayDayPct ?? asset.displayDayPnlPct ?? asset.dayPct;
const dayAmount = asset => asset.displayDayChange ?? asset.displayDayPnl ?? asset.dayChange;

const cardDefinitions = [
    { id: 'best-day-asset', labelId: 'best-day-label', title: 'Meilleures variations du jour', icon: 'ph-trend-up' },
    { id: 'worst-day-asset', labelId: 'worst-day-label', title: 'Moins bonnes variations du jour', icon: 'ph-trend-down' },
    { id: 'best-asset', labelId: 'best-total-label', title: 'Meilleures performances', icon: 'ph-trend-up' },
    { id: 'worst-asset', labelId: 'worst-total-label', title: 'Moins bonnes performances', icon: 'ph-trend-down' },
    { id: 'cash-reserve', labelId: 'cash-reserve-label', title: 'Cash par wallet', icon: 'ph-wallet' }
];

function makeText(tag, className, value) {
    const element = document.createElement(tag);
    element.className = className;
    element.textContent = value;
    return element;
}

// Une page laissée ouverte peut encore contenir l'ancien HTML des cinq cartes,
// tandis que les modules JS ont été rechargés. Compléter ce DOM rend notamment
// le détail des wallets visible sans dépendre d'un rechargement manuel.
function ensureInsightMarkup() {
    cardDefinitions.forEach(({ id, labelId, title, icon }) => {
        const host = document.getElementById(id);
        const card = host?.closest('.investment-insight, .stat-item');
        if (!card) return;
        card.classList.add('investment-insight', 'kpi-card');
        if (id === 'cash-reserve') card.classList.add('investment-cash-insight');
        if (card.parentElement?.classList.contains('summary-stats')) {
            card.parentElement.classList.add('investment-insights');
        }
        card.setAttribute('aria-labelledby', labelId);
        let label = document.getElementById(labelId) || card.querySelector('.stat-label');
        if (!label) label = makeText('span', 'stat-label', title);
        label.id = labelId;
        label.classList.add('stat-label', 'kpi-label');
        label.textContent = title;
        let header = card.querySelector('.kpi-header');
        if (!header) {
            header = makeText('div', 'kpi-header', '');
            card.prepend(header);
        }
        if (label.parentElement !== header) header.prepend(label);
        if (!header.querySelector('.kpi-icon')) {
            const iconElement = makeText('i', `ph ${icon} kpi-icon`, '');
            iconElement.setAttribute('aria-hidden', 'true');
            header.append(iconElement);
        }
        if (id !== 'cash-reserve') {
            const contextId = id.includes('-day-')
                ? (id === 'best-day-asset' ? 'best-day-context' : 'worst-day-context')
                : `${id}-context`;
            let context = document.getElementById(contextId) || card.querySelector('.insight-context');
            if (!context) {
                context = makeText('div', 'insight-context', id.includes('-day-')
                    ? 'Variation du jour' : 'Depuis achat · gain latent');
                header.after(context);
            }
            context.id = contextId;
            context.classList.add('insight-context');
            card.setAttribute('aria-describedby', contextId);
        }
        if (id === 'cash-reserve') {
            const insightsGrid = document.querySelector('.portfolio-summary-enhanced .summary-stats') ||
                document.querySelector('.summary-stats');
            if (insightsGrid) {
                card.classList.remove('summary-card');
                card.classList.add('stat-item');
                if (card.parentElement !== insightsGrid) insightsGrid.append(card);
            }
            host.classList.remove('stat-value', 'stat-positive', 'stat-negative');
            host.classList.add('cash-insight-total');
            if (!document.getElementById('cash-wallets')) {
                const wallets = makeText('div', 'insight-list', '');
                wallets.id = 'cash-wallets';
                wallets.setAttribute('aria-live', 'polite');
                host.after(wallets);
            }
        } else {
            host.classList.remove('stat-value', 'stat-positive', 'stat-negative');
            host.classList.add('insight-list');
        }
    });
}

function signedMoney(value) {
    return Number.isFinite(value) ? `${value > 0 ? '+' : ''}${moneyFormatter.format(value)}` : null;
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
        const identity = makeText('span', 'insight-identity', asset.name || asset.ticker || 'Actif');
        identity.title = label.title;
        label.append(identity);
        const metric = valueOf(asset);
        const value = document.createElement('td');
        value.append(makeText('span', metric >= 0 ? 'insight-positive' : 'insight-negative',
            `${metric >= 0 ? '+' : ''}${percentFormatter.format(metric)} %`));
        const amount = signedMoney(id.includes('-day-') ? dayAmount(asset) : asset.gainEUR);
        if (amount) value.append(makeText('small', 'insight-sub-value', amount));
        row.append(label, value);
        body.append(row);
    });
    table.append(body);
    container.append(table);
}

export function renderInvestmentInsights(holdings, cashReserve, brokersList = [], { dividendsOnly = false } = {}) {
    ensureInsightMarkup();
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
    const bestDayLabel = document.getElementById('best-day-label');
    const worstDayLabel = document.getElementById('worst-day-label');
    if (displayedDay) {
        if (bestDayLabel) bestDayLabel.textContent = 'Meilleures variations affichées';
        if (worstDayLabel) worstDayLabel.textContent = 'Moins bonnes variations affichées';
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
