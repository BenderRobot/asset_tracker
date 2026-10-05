function normalize(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, ' ')
        .trim()
        .toLowerCase();
}

function containsTicker(title, ticker) {
    const normalizedTicker = String(ticker || '').trim().toUpperCase();
    if (!normalizedTicker) return false;
    const escaped = normalizedTicker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Z0-9])${escaped}($|[^A-Z0-9])`).test(String(title || '').toUpperCase());
}

/** Trouve uniquement une position encore détenue et réellement liée au titre. */
export function findHoldingForNews(newsItem, holdings = []) {
    const title = newsItem?.title || newsItem?.name || '';
    const normalizedTitle = normalize(title);
    const explicitAsset = normalize(newsItem?.assetName);

    return holdings.find(holding => {
        if (!(Number(holding?.quantity) > 0.0001)) return false;
        const normalizedName = normalize(holding.name);
        const normalizedTicker = normalize(holding.ticker);
        if (explicitAsset && (explicitAsset === normalizedName || explicitAsset === normalizedTicker)) return true;
        if (normalizedName.length > 1 && normalizedTitle.includes(normalizedName)) return true;
        return containsTicker(title, holding.ticker);
    }) || null;
}

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Construit l'exposition portefeuille utilisée par Gemini depuis un snapshot
 * canonique déjà résolu. Une valeur absente reste `null` : aucun cours ou cash
 * manquant ne doit être assimilé à zéro dans une analyse d'actualité.
 */
export function buildNewsHoldingDetails(newsItem, holdings = [], portfolioSnapshot = null) {
    const foundHolding = findHoldingForNews(newsItem, holdings);
    if (!foundHolding) return null;

    const currentValue = finiteNumber(foundHolding.currentValue);
    const totalValue = finiteNumber(portfolioSnapshot?.totalValue);
    const cashReserve = finiteNumber(portfolioSnapshot?.cash);

    return {
        ...foundHolding,
        currentValue,
        weight: currentValue !== null && totalValue !== null && totalValue > 0
            ? (currentValue / totalValue) * 100
            : null,
        portfolioTotalValue: totalValue,
        cashReserve,
        portfolioStatus: portfolioSnapshot?.status || 'unavailable',
        portfolioInvalidReason: portfolioSnapshot?.invalidReason || null,
        snapshotId: portfolioSnapshot?.snapshotId || null,
        snapshotGeneratedAt: portfolioSnapshot?.generatedAt || null,
        pricesTimestamp: portfolioSnapshot?.pricesTimestamp || null,
        sourceStale: !!portfolioSnapshot?.sourceStale,
        staleInstruments: [...(portfolioSnapshot?.staleInstruments || [])],
        refreshError: portfolioSnapshot?.refreshError || null
    };
}
