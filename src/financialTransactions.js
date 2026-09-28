// Transaction nature is independent of the underlying instrument's type.
export function transactionKind(row) {
    const type = String(row.assetType || '').trim().toLowerCase();
    if (type === 'dividend' || String(row.type || '').trim().toLowerCase() === 'dividend') return 'dividend';
    const ticker = String(row.ticker || '').toUpperCase();
    if (type === 'cash' || ['CASH', 'EUR', 'USD'].includes(ticker) || ticker.startsWith('CASH-')) return 'cash';
    if (type === 'real estate') return 'realEstate';
    return 'asset';
}

export function splitTransactions(rows = []) {
    const result = { assets: [], cash: [], dividends: [], realEstate: [] };
    for (const row of rows || []) {
        const kind = transactionKind(row);
        if (kind === 'dividend') { result.dividends.push(row); result.cash.push(row); }
        else result[kind === 'asset' ? 'assets' : kind].push(row);
    }
    return result;
}

export function assetHistoryTransactions(rows, ticker) {
    const upper = ticker.toUpperCase();
    return (rows || []).filter(row => String(row.ticker).toUpperCase() === upper
        && ['asset', 'dividend'].includes(transactionKind(row)));
}
