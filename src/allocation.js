export const ALLOCATION_TYPES = Object.freeze({
    ETF: Object.freeze({ color: '#10b981', label: 'ETF' }),
    Stock: Object.freeze({ color: '#3b82f6', label: 'Actions' }),
    Crypto: Object.freeze({ color: '#f59e0b', label: 'Cryptos' }),
    'Real Estate': Object.freeze({ color: '#8b5cf6', label: 'Immobilier' }),
    Other: Object.freeze({ color: '#94a3b8', label: 'Autres' })
});

export function normalizeAllocationType(raw) {
    const type = String(raw || '').trim().toLowerCase();
    if (type === 'etf') return 'ETF';
    if (type === 'stock' || type === 'action' || type === 'actions') return 'Stock';
    if (type === 'crypto' || type === 'cryptocurrency') return 'Crypto';
    if (type === 'real estate' || type === 'realestate' || type === 'immobilier') return 'Real Estate';
    return 'Other';
}

const isCurrentPosition = holding => Number(holding?.quantity) > 0.0001;
const finiteAmount = value => value !== null && value !== undefined && Number.isFinite(Number(value));

export function calculateCurrentAllocation(holdings, basis = 'market') {
    const byType = Object.fromEntries(Object.keys(ALLOCATION_TYPES).map(type => [type, 0]));
    const unavailable = [];

    (holdings || []).filter(isCurrentPosition).forEach(holding => {
        const type = normalizeAllocationType(holding.assetType);
        const value = basis === 'invested' ? holding.invested : holding.currentValue;
        if (!finiteAmount(value)) {
            unavailable.push(holding.ticker || holding.name || type);
            return;
        }
        if (Number(value) > 0) byType[type] += Number(value);
    });

    const total = Object.values(byType).reduce((sum, value) => sum + value, 0);
    const rows = Object.entries(byType)
        .filter(([, value]) => value > 0.01)
        .map(([type, value]) => ({
            type,
            ...ALLOCATION_TYPES[type],
            value,
            pct: total > 0 ? (value / total) * 100 : 0
        }))
        .sort((a, b) => b.value - a.value);

    return { valid: unavailable.length === 0, basis, total, rows, byType, unavailable };
}

function transactionDate(transaction) {
    if (!transaction?.date) return null;
    const date = transaction.date instanceof Date ? transaction.date : new Date(transaction.date);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function replayHolding(holding, basis) {
    const transactions = (holding.purchases || [])
        .filter(transaction => Number(transaction.quantity) !== 0 && transactionDate(transaction))
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    if (!transactions.length) return [];

    const positions = new Map();
    const rawStates = [];
    const totalState = () => [...positions.values()].reduce((sum, position) =>
        sum + (basis === 'market' ? position.quantity : position.invested), 0);

    for (const transaction of transactions) {
        const broker = transaction.broker || 'RV-CT';
        const position = positions.get(broker) || { quantity: 0, invested: 0 };
        const quantity = Number(transaction.quantity) || 0;
        const price = Number(transaction.price) || 0;

        if (quantity > 0) {
            position.quantity += quantity;
            position.invested += price * quantity;
        } else if (position.quantity > 0) {
            const sold = Math.abs(quantity);
            const ratio = sold / position.quantity;
            position.invested -= position.invested * ratio;
            position.quantity -= sold;
            if (position.quantity <= 0.0001) {
                position.quantity = 0;
                position.invested = 0;
            }
        } else {
            position.quantity += quantity;
        }
        positions.set(broker, position);
        rawStates.push({ date: transactionDate(transaction), value: Math.max(0, totalState()) });
    }

    const canonicalFinal = basis === 'market' ? Number(holding.currentValue) : Number(holding.invested);
    const rawFinal = rawStates.at(-1)?.value || 0;
    if (!(canonicalFinal >= 0) || !(rawFinal > 0)) return [];
    const scale = canonicalFinal / rawFinal;
    let previous = 0;
    return rawStates.map(state => {
        const canonicalState = state.value * scale;
        const amount = canonicalState - previous;
        previous = canonicalState;
        return { date: state.date, type: normalizeAllocationType(holding.assetType), amount };
    });
}

export function buildAllocationTimeline(holdings, basis = 'market', today = new Date()) {
    const current = calculateCurrentAllocation(holdings, basis);
    if (!current.valid) return { ...current, points: [], activeTypes: [] };

    const events = (holdings || [])
        .filter(isCurrentPosition)
        .flatMap(holding => replayHolding(holding, basis))
        .sort((a, b) => a.date.localeCompare(b.date));

    const cumulative = Object.fromEntries(Object.keys(ALLOCATION_TYPES).map(type => [type, 0]));
    const timePoints = [];
    for (const event of events) {
        cumulative[event.type] = Math.max(0, (cumulative[event.type] || 0) + event.amount);
        const last = timePoints.at(-1);
        if (last?.date === event.date) last.values = { ...cumulative };
        else timePoints.push({ date: event.date, values: { ...cumulative } });
    }

    if (timePoints.length) {
        // The canonical snapshot is authoritative for the endpoint. This also
        // absorbs historical FX differences that raw transaction prices cannot
        // reproduce without the historical FX map used by DataManager.
        const todayString = today.toISOString().slice(0, 10);
        const endpoint = { ...current.byType };
        if (timePoints.at(-1).date === todayString) timePoints.at(-1).values = endpoint;
        else timePoints.push({ date: todayString, values: endpoint });
    }

    const points = timePoints.map(point => {
        const total = Object.values(point.values).reduce((sum, value) => sum + value, 0);
        return {
            date: point.date,
            values: point.values,
            pcts: Object.fromEntries(Object.keys(ALLOCATION_TYPES).map(type => [
                type, total > 0 ? ((point.values[type] || 0) / total) * 100 : 0
            ]))
        };
    });

    return { ...current, points, activeTypes: current.rows.map(row => row.type) };
}
