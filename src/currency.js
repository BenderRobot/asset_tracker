// Provider prices retain their currency. Only financial consumers convert them.
export function withHistoryCurrency(points, currency) {
    if (currency) Object.defineProperty(points, 'currency', { value: currency, configurable: true });
    return points;
}

export function quoteInEur(quote, usdToEur) {
    if (!quote) return quote;
    const source = quote.nativeQuote || quote;
    const currency = source.currency || 'EUR';
    if (currency === 'EUR') return { ...quote };
    const rate = currency === 'USD' && Number.isFinite(usdToEur) && usdToEur > 0 ? usdToEur : null;
    const convert = value => rate !== null && Number.isFinite(value) ? value * rate : null;
    return {
        ...quote, nativeQuote: { price: source.price, previousClose: source.previousClose,
            lastTradingDayClose: source.lastTradingDayClose, currency },
        originalCurrency: currency, currency: 'EUR', conversionRate: rate,
        price: convert(source.price), previousClose: convert(source.previousClose),
        lastTradingDayClose: convert(source.lastTradingDayClose), fxUnavailable: rate === null
    };
}
