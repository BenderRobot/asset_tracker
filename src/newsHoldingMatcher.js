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
