import { calculateCurrentAllocation, normalizeAllocationType } from './allocation.js';

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Aligne le contexte Gemini du risque sur le périmètre du moteur historique :
 * actifs de marché + cash, immobilier exclu. Tous les poids utilisent ce même
 * dénominateur et deviennent indisponibles si le snapshot est incomplet.
 */
export function buildRiskContext(report) {
    const activeAssets = (Array.isArray(report?.assets) ? report.assets : [])
        .filter(asset => Number(asset?.quantity) > 0.0001);
    const realEstate = activeAssets.filter(asset => normalizeAllocationType(asset.assetType) === 'Real Estate');
    const marketAssets = activeAssets.filter(asset => normalizeAllocationType(asset.assetType) !== 'Real Estate');
    const cashReserve = finiteNumber(
        report?.portfolioSnapshot?.cash ?? report?.summary?.cashReserve
    );
    const allocation = calculateCurrentAllocation(marketAssets, 'market', cashReserve);
    const totalValue = allocation.valid ? allocation.total : null;
    const cashRow = allocation.rows.find(row => row.type === 'Cash');
    const positions = marketAssets.map(asset => {
        const currentValue = finiteNumber(asset.currentValue);
        return {
            ticker: asset.ticker,
            name: asset.name,
            assetType: normalizeAllocationType(asset.assetType),
            currentValue,
            gainPct: finiteNumber(asset.gainPct),
            weight: allocation.valid && totalValue > 0 && currentValue !== null
                ? (currentValue / totalValue) * 100
                : null
        };
    }).sort((a, b) => (b.currentValue ?? -Infinity) - (a.currentValue ?? -Infinity));
    const snapshot = report?.portfolioSnapshot || {};

    return {
        risk: report?.risk || {},
        positions,
        totalValue,
        cashReserve,
        cashWeight: allocation.valid && totalValue > 0 ? (cashRow?.pct || 0) : null,
        allocationValid: allocation.valid,
        allocationUnavailable: [...allocation.unavailable],
        excludedRealEstate: realEstate.map(asset => ({
            ticker: asset.ticker,
            name: asset.name,
            currentValue: finiteNumber(asset.currentValue)
        })),
        excludedRealEstateValue: realEstate.every(asset => finiteNumber(asset.currentValue) !== null)
            ? realEstate.reduce((sum, asset) => sum + finiteNumber(asset.currentValue), 0)
            : null,
        snapshotStatus: snapshot.status || 'indisponible',
        sourceStale: !!snapshot.sourceStale,
        pricesTimestamp: snapshot.pricesTimestamp || null
    };
}
