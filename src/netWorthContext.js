function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeName(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, ' ')
        .trim()
        .toLowerCase();
}

/**
 * Construit le patrimoine net enregistré dans l'application sans masquer les
 * limites de périmètre. Le portefeuille canonique contient déjà les actifs de
 * marché, les projets immobiliers et le cash courtier : aucun de ces éléments
 * n'est resommé depuis les transactions.
 */
export function buildNetWorthContext(portfolioContext, expensesContext) {
    const summary = portfolioContext?.summary || {};
    const portfolioTotal = finiteNumber(summary.totalValue);
    const brokerCash = finiteNumber(summary.cash);
    const investedAssetsAndProjects = portfolioTotal !== null && brokerCash !== null
        ? portfolioTotal - brokerCash
        : null;

    const residence = portfolioContext?.primaryResidence || null;
    const residenceEquity = residence ? finiteNumber(residence.equity) : 0;
    const residenceDebt = residence ? finiteNumber(residence.totalDebt) : 0;
    const residenceName = normalizeName(residence?.name);
    const duplicateResidenceAssets = residenceName
        ? (portfolioContext?.holdings || [])
            .filter(holding => String(holding?.type || '').toLowerCase() === 'real estate')
            .filter(holding => normalizeName(holding.name || holding.ticker) === residenceName)
            .map(holding => holding.ticker || holding.name)
        : [];

    const bankAccounts = expensesContext?.bankAccounts || [];
    const unavailableBankAccounts = bankAccounts
        .filter(account => !Number.isFinite(Number(account.balance)))
        .map(account => account.name || 'Compte bancaire');
    const unsupportedBankCurrencies = [...new Set(bankAccounts
        .filter(account => Number.isFinite(Number(account.balance)) && String(account.currency || 'EUR').toUpperCase() !== 'EUR')
        .map(account => String(account.currency || 'inconnue').toUpperCase()))];
    const bankBalanceEUR = expensesContext && bankAccounts.length
        && unavailableBankAccounts.length === 0 && unsupportedBankCurrencies.length === 0
        ? finiteNumber(expensesContext.totalBankBalanceEUR)
        : null;

    const unavailable = [];
    if (portfolioTotal === null || brokerCash === null || summary.status !== 'valid') unavailable.push('Portefeuille financier');
    if (!expensesContext || !bankAccounts.length) unavailable.push('Soldes bancaires non enregistrés');
    unavailableBankAccounts.forEach(name => unavailable.push(`Solde bancaire: ${name}`));
    unsupportedBankCurrencies.forEach(currency => unavailable.push(`Solde bancaire ${currency} non converti`));
    if (residence && residenceEquity === null) unavailable.push('Équité de la résidence principale');
    duplicateResidenceAssets.forEach(asset => unavailable.push(`Doublon immobilier potentiel: ${asset}`));

    const knownComponents = [investedAssetsAndProjects, brokerCash, bankBalanceEUR, residenceEquity]
        .filter(value => value !== null);
    const knownSubtotalEUR = knownComponents.reduce((sum, value) => sum + value, 0);
    const complete = unavailable.length === 0;

    return {
        status: complete ? 'complete' : (knownComponents.length ? 'partial' : 'unavailable'),
        scope: 'recorded_app_data',
        totalNetWorthEUR: complete ? knownSubtotalEUR : null,
        knownSubtotalEUR,
        components: {
            investedAssetsAndProjects,
            brokerCash,
            bankBalanceEUR,
            primaryResidenceEquity: residenceEquity,
            primaryResidenceDebt: residenceDebt
        },
        unavailable,
        duplicateResidenceAssets,
        unsupportedBankCurrencies,
        assumptions: [
            'Le cash courtier est déjà inclus dans le portefeuille canonique et n’est ajouté qu’une fois.',
            'Les soldes bancaires Enable Banking sont considérés distincts du registre de cash courtier.',
            'La résidence principale contribue par son équité nette ; sa dette n’est pas soustraite une seconde fois.',
            'Les autres dettes ou comptes non enregistrés dans l’application sont hors périmètre.'
        ]
    };
}
