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

function explicitNewsTickers(newsItem) {
    const values = [
        ...(Array.isArray(newsItem?.tickers) ? newsItem.tickers : []),
        ...(Array.isArray(newsItem?.relatedTickers) ? newsItem.relatedTickers : []),
        newsItem?.ticker
    ];
    return new Set(values.filter(Boolean).map(value => String(value).trim().toUpperCase()));
}

function matchesNewsSubject(newsItem, subject) {
    const title = newsItem?.title || newsItem?.name || '';
    const normalizedTitle = normalize(title);
    const explicitAsset = normalize(newsItem?.assetName);
    const ticker = String(subject?.ticker || '').trim().toUpperCase();
    const name = normalize(subject?.name);
    if (explicitNewsTickers(newsItem).has(ticker)) return true;
    if (explicitAsset && (explicitAsset === name || explicitAsset === normalize(ticker))) return true;
    if (name.length > 1 && normalizedTitle.includes(name)) return true;
    return containsTicker(title, ticker);
}

/** Retourne toutes les positions directes explicitement reliees a l'article. */
export function findHoldingsForNews(newsItem, holdings = []) {
    return (holdings || []).filter(holding =>
        Number(holding?.quantity) > 0.0001 && matchesNewsSubject(newsItem, holding)
    );
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
export function buildNewsHoldingDetails(newsItem, holdings = [], portfolioSnapshot = null, exposureCatalog = []) {
    const foundHoldings = findHoldingsForNews(newsItem, holdings);

    const totalValue = finiteNumber(portfolioSnapshot?.totalValue);
    const cashReserve = finiteNumber(portfolioSnapshot?.cash);
    const catalogByTicker = new Map((exposureCatalog || []).map(item => [
        String(item?.ticker || '').toUpperCase(), item
    ]));
    const common = {
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
    const matches = foundHoldings.map(foundHolding => {
        const currentValue = finiteNumber(foundHolding.currentValue);
        const metadata = catalogByTicker.get(String(foundHolding.ticker || '').toUpperCase());
        return {
            ...foundHolding,
            currentValue,
            weight: currentValue !== null && totalValue !== null && totalValue > 0
                ? (currentValue / totalValue) * 100
                : null,
            sector: metadata?.sector || null,
            industry: metadata?.industry || null
        };
    });

    // Une exposition indirecte n'est acceptee que si la composition de l'ETF
    // est explicitement datee et sourcee par le contexte watchlist.
    const indirectMatches = [];
    for (const holding of holdings || []) {
        if (!(Number(holding?.quantity) > 0.0001)) continue;
        const catalog = catalogByTicker.get(String(holding.ticker || '').toUpperCase());
        const composition = catalog?.verifiedComposition;
        if (!composition?.source || !composition?.asOf || !Array.isArray(composition.holdings)) continue;
        for (const constituent of composition.holdings) {
            if (!matchesNewsSubject(newsItem, constituent)) continue;
            const etfValue = finiteNumber(holding.currentValue);
            const etfWeight = etfValue !== null && totalValue !== null && totalValue > 0
                ? (etfValue / totalValue) * 100
                : null;
            const constituentWeight = finiteNumber(constituent.weightPct);
            indirectMatches.push({
                throughTicker: holding.ticker,
                throughName: holding.name,
                constituentTicker: constituent.ticker || null,
                constituentName: constituent.name || null,
                constituentWeightPct: constituentWeight,
                estimatedValue: etfValue !== null && constituentWeight !== null
                    ? etfValue * constituentWeight / 100
                    : null,
                portfolioWeight: etfWeight !== null && constituentWeight !== null
                    ? etfWeight * constituentWeight / 100
                    : null,
                compositionSource: composition.source,
                compositionAsOf: composition.asOf
            });
        }
    }

    if (!matches.length && !indirectMatches.length) return null;
    const knownWeights = [
        ...matches.map(match => match.weight),
        ...indirectMatches.map(match => match.portfolioWeight)
    ].filter(value => value !== null);
    const sectors = [...new Set(matches.map(match => match.sector).filter(Boolean))];
    const primary = matches[0] || {};

    return {
        // Champs historiques conserves pour les consommateurs existants quand
        // l'article correspond a une position directe.
        ...primary,
        ...common,
        matches,
        indirectMatches,
        cumulativeWeight: knownWeights.length === matches.length + indirectMatches.length
            ? knownWeights.reduce((sum, value) => sum + value, 0)
            : null,
        sectors,
        exposureStatus: indirectMatches.length ? 'direct_and_verified_indirect'
            : matches.length ? 'direct_only'
                : 'verified_indirect_only'
    };
}

/**
 * Noms des actifs encore détenus (quantité nette > 0), pour les fils d'actus.
 * Les ventes étant stockées en quantité négative, un actif vendu en totalité
 * disparaît au lieu de continuer à remonter dans « Mes Actifs ».
 */
export function getHeldAssetNames(purchases = []) {
    const positions = new Map();
    for (const p of purchases) {
        if (p?.assetType === 'Cash') continue;
        const key = String(p?.ticker || p?.name || '').trim().toUpperCase();
        if (!key) continue;
        const position = positions.get(key) || { name: '', quantity: 0 };
        if (!position.name && String(p.name || '').trim()) position.name = p.name.trim();
        position.quantity += Number(p.quantity) || 0;
        positions.set(key, position);
    }
    return [...new Set([...positions.values()]
        .filter(position => position.quantity > 0.0001 && position.name)
        .map(position => position.name))];
}
