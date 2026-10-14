// Primary-source releases already checked against the issuer's publication.
// A calendar date alone must never create a "Nouveau" badge or financial figures.
const RELEASES = [{
    ticker: 'ASML', providerSymbols: ['ASML.AS', 'ASML'],
    id: 'asml-q3-2026', publishedAt: Date.parse('2026-10-14T05:00:00Z'),
    period: 'T3 2026', source: 'Communiqué ASML via GlobeNewswire',
    sourceUrl: 'https://www.globenewswire.com/news-release/2026/10/14/3380319/0/en/asml-reports-11-7-billion-total-net-sales-and-5-0-billion-net-income-in-q3-2026.html',
    highlights: [
        'Chiffre d’affaires : 11,7 Md€ ; marge brute : 57,5 % ; résultat net : 5,0 Md€.',
        'Prévision T4 2026 : chiffre d’affaires de 14,2 à 15,2 Md€ et marge brute d’environ 57 %.',
        'Prévision 2026 : chiffre d’affaires de 44 à 45 Md€ et marge brute d’environ 56 %.'
    ]
}];

const HOUR_MS = 60 * 60 * 1000;

export function verifiedPortfolioReleases(holdings = [], now = Date.now()) {
    return RELEASES.filter(release => release.publishedAt <= now && now - release.publishedAt < 7 * 24 * HOUR_MS
        && holdings.some(holding => Number(holding?.quantity) > 0
            && (String(holding.ticker || '').toUpperCase() === release.ticker
                || release.providerSymbols.includes(String(holding.ticker || '').toUpperCase())
                || release.providerSymbols.includes(String(holding.providerSymbol || '').toUpperCase()))))
        .map(release => ({ ...release, isNew: now - release.publishedAt < 48 * HOUR_MS }));
}
