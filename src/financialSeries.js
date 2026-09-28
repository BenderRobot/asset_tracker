// Period return is distinct from the unrealised gain on remaining positions.
// Cash belongs to valuation; trades/deposits are not investment income.
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function performanceSeries(graph, includeDividends = false) {
    const ratios = includeDividends ? graph.twrWithDividends : graph.twr;
    if (!Array.isArray(ratios)) return null;
    return ratios.map(value => graph.dataQuality?.valid !== false && finite(value) ? (value - 1) * 100 : null);
}

export function periodPerformance(graph, { includeDividends = false, firstIndex = 0,
    lastIndex = (graph.labels?.length ?? graph.values?.length ?? 0) - 1, mode = 'portfolio' } = {}) {
    if (graph.dataQuality?.valid === false || firstIndex < 0 || lastIndex < firstIndex) return { amount: null, percent: null };
    if (mode === 'unit' || mode === 'index') {
        const values = mode === 'unit' ? graph.unitPrices : graph.values;
        const start = values?.[firstIndex], end = values?.[lastIndex];
        const amount = finite(start) && finite(end) ? end - start : null;
        return { amount, percent: amount !== null && start > 0 ? amount / start * 100 : null };
    }
    const pnl = includeDividends ? graph.periodPnlWithDividends : graph.periodPnl;
    const ratios = includeDividends ? graph.twrWithDividends : graph.twr;
    const startAmount = pnl?.[firstIndex], endAmount = pnl?.[lastIndex];
    const startRatio = ratios?.[firstIndex], endRatio = ratios?.[lastIndex];
    return {
        amount: finite(startAmount) && finite(endAmount) ? endAmount - startAmount : null,
        percent: finite(startRatio) && startRatio > 0 && finite(endRatio) ? (endRatio / startRatio - 1) * 100 : null
    };
}
