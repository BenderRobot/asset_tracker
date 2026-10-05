import { calculateCurrentAllocation, normalizeAllocationType } from './allocation.js';

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Produit le contrat de données de l'analyse Gemini de diversification.
 * Tous les poids courants utilisent le total canonique valeur de marché + cash.
 * Le score historique de DataManager reste exposé, mais son périmètre hors cash
 * est explicite afin de ne pas le faire passer pour une mesure cash incluse.
 */
export function buildDiversificationContext(report) {
    const assets = (Array.isArray(report?.assets) ? report.assets : [])
        .filter(asset => Number(asset?.quantity) > 0.0001);
    const cashReserve = finiteNumber(
        report?.portfolioSnapshot?.cash ?? report?.summary?.cashReserve
    );
    const allocation = calculateCurrentAllocation(assets, 'market', cashReserve);
    const total = allocation.valid ? allocation.total : null;

    const typeCounts = {};
    assets.forEach(asset => {
        const type = normalizeAllocationType(asset.assetType);
        typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    const positions = assets.map(asset => {
        const currentValue = finiteNumber(asset.currentValue);
        return {
            ticker: asset.ticker,
            name: asset.name,
            type: normalizeAllocationType(asset.assetType),
            currentValue,
            gainPct: finiteNumber(asset.gainPct),
            weight: allocation.valid && total > 0 && currentValue !== null
                ? (currentValue / total) * 100
                : null
        };
    }).sort((a, b) => (b.currentValue ?? -Infinity) - (a.currentValue ?? -Infinity));

    const top3Weight = allocation.valid && total > 0
        ? positions.slice(0, 3).reduce((sum, position) => sum + (position.weight || 0), 0)
        : null;
    const largestPosition = positions[0] || null;
    const heavyCount = allocation.valid
        ? positions.filter(position => position.weight > 10).length
        : null;
    const cashRow = allocation.rows.find(row => row.type === 'Cash');
    const diversification = report?.diversification || {};
    const snapshot = report?.portfolioSnapshot || {};

    return {
        allocationValid: allocation.valid,
        allocationBasis: 'current_market_value_including_cash',
        allocationTotal: total,
        allocationUnavailable: [...allocation.unavailable],
        allocationRows: allocation.rows.map(row => ({
            type: row.type,
            label: row.label,
            value: row.value,
            weight: allocation.valid ? row.pct : null,
            assetsCount: row.type === 'Cash' ? 0 : (typeCounts[row.type] || 0)
        })),
        cashReserve,
        cashWeight: allocation.valid && total > 0 ? (cashRow?.pct || 0) : null,
        score: finiteNumber(diversification.diversityScore),
        hhi: finiteNumber(diversification.herfindahl),
        effectiveAssets: finiteNumber(diversification.effectiveAssets),
        scoreScope: 'positions_excluding_cash',
        totalAssets: positions.length,
        top3Weight,
        heavyCount,
        largestPosition,
        positions,
        snapshotStatus: snapshot.status || 'indisponible',
        sourceStale: !!snapshot.sourceStale,
        pricesTimestamp: snapshot.pricesTimestamp || null
    };
}
