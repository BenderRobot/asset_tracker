// The daily attribution reads the same canonical position P&L as "Var Today".
// Display-only last-session figures must never enter this reconciliation.
export function selectDailyContributions(snapshot, { previousSession = false } = {}) {
    if (previousSession) return { status: 'previous-session', rows: [], total: null, explained: null, residual: null, missing: 0 };
    if (snapshot?.status !== 'valid' || !Number.isFinite(snapshot.dayPnl)) {
        return { status: 'unavailable', rows: [], total: null, explained: null, residual: null, missing: 0 };
    }
    const positions = (snapshot.positions || []).filter(p => p?.quantity > 0 && !p.ticker?.startsWith('CASH-'));
    const missing = positions.filter(p => !Number.isFinite(p.dayPnl)).length;
    const explained = positions.reduce((sum, p) => sum + (Number.isFinite(p.dayPnl) ? p.dayPnl : 0), 0);
    const residual = snapshot.dayPnl - explained;
    const rows = positions.map(p => ({
        ticker: p.ticker, name: p.name || p.ticker, assetType: p.assetType,
        weight: Number.isFinite(p.currentValue) && snapshot.totalValue > 0
            ? p.currentValue / snapshot.totalValue * 100 : null,
        pct: Number.isFinite(p.dayPnlPct) ? p.dayPnlPct : null,
        impact: Number.isFinite(p.dayPnl) ? p.dayPnl : null
    })).filter(row => row.impact === null || row.impact !== 0)
        .sort((a, b) => (b.impact === null ? -1 : Math.abs(b.impact)) - (a.impact === null ? -1 : Math.abs(a.impact)));
    const status = missing ? 'partial' : Math.abs(residual) > 0.01 ? 'mismatch' : 'complete';
    return { status, rows, total: snapshot.dayPnl, explained, residual, missing };
}

export function selectContributionHighlights(data) {
    const rows = data?.rows || [];
    return {
        best: rows.filter(row => row.impact > 0).sort((a, b) => b.impact - a.impact).slice(0, 2),
        worst: rows.filter(row => row.impact < 0).sort((a, b) => a.impact - b.impact).slice(0, 2)
    };
}

// Read-only checks run on the same authenticated snapshot as the dashboard.
// They expose inconsistencies; they never modify financial values.
export function auditDashboardSnapshot(snapshot) {
    const portfolio = snapshot?.portfolioSnapshot;
    if (portfolio?.status !== 'valid' || !Array.isArray(portfolio.positions)) {
        return { status: 'unavailable', issues: [], missingDayPnl: 0 };
    }
    const positions = portfolio.positions.filter(p => p?.quantity > 0 && !p.ticker?.startsWith('CASH-'));
    const missingDayPnl = positions.filter(p => !Number.isFinite(p.dayPnl)).length;
    const issues = [];
    const incomplete = [];
    const check = (label, actual, parts) => {
        if (!Number.isFinite(actual) || parts.some(value => !Number.isFinite(value))) {
            incomplete.push(label);
            return;
        }
        const residual = actual - parts.reduce((sum, value) => sum + value, 0);
        if (Math.abs(residual) > 0.01) issues.push({ label, residual });
    };
    if (!missingDayPnl) check('Variation du jour', portfolio.dayPnl, positions.map(p => p.dayPnl));
    else incomplete.push('Variation du jour');
    check('Valeur totale', portfolio.totalValue, [...positions.map(p => p.currentValue), portfolio.cash]);
    check('Gain total', portfolio.totalReturn, positions.map(p => p.totalReturn));
    check('Variation du jour / moteur', portfolio.dayPnl, [snapshot._engine?.summary?.totalDayChangeEUR]);
    return { status: issues.length ? 'mismatch' : incomplete.length ? 'partial' : 'complete', issues, incomplete, missingDayPnl };
}
