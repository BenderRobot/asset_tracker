import { MortgageCalculator } from './mortgageCalculator.js';

function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function roundMoney(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function isoDay(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString().split('T')[0] : null;
}

/**
 * Construit le contexte immobilier transmis à Gemini à partir du même moteur
 * d'amortissement que la page Immobilier. Les agrégats financiers échouent
 * explicitement si un crédit est invalide : un sous-total ne doit jamais être
 * présenté comme la dette complète.
 */
export function buildPrimaryResidenceContext(residence, referenceDate = new Date()) {
    if (!residence || typeof residence !== 'object') return null;

    const asOf = new Date(referenceDate);
    const validReferenceDate = Number.isFinite(asOf.getTime()) ? asOf : new Date();
    const credits = Array.isArray(residence.credits) ? residence.credits : [];
    const creditDetails = credits.map(credit => {
        const initialAmount = finiteNumber(credit?.initialAmount);
        const rate = finiteNumber(credit?.rate);
        const durationMonths = finiteNumber(credit?.duration ?? credit?.durationMonths);
        const startDate = isoDay(credit?.startDate);
        const structurallyValid = initialAmount !== null && initialAmount >= 0
            && rate !== null && rate >= 0
            && durationMonths !== null && durationMonths > 0
            && startDate !== null;

        if (!structurallyValid) {
            return {
                name: credit?.name || 'Crédit',
                initialAmount,
                remainingCapital: null,
                rate,
                durationMonths,
                monthlyPayment: null,
                currentMonthlyPayment: null,
                startDate,
                endDate: null,
                status: 'invalid'
            };
        }

        // Normalise les champs numériques avant d'appeler le calculateur : les
        // anciennes sauvegardes peuvent contenir "0" sous forme de chaîne, ce
        // que la branche PTZ stricte (`rate === 0`) ne reconnaîtrait pas.
        const normalizedCredit = {
            ...credit,
            initialAmount,
            rate,
            duration: durationMonths,
            startDate
        };
        const remainingCapital = finiteNumber(
            MortgageCalculator.calculateRemainingCapital(normalizedCredit, validReferenceDate)
        );
        const monthlyPayment = finiteNumber(MortgageCalculator.calculateMonthlyPayment(normalizedCredit));
        const endDateValue = MortgageCalculator.getEndDate(normalizedCredit);
        const endDate = isoDay(endDateValue);
        const startMs = new Date(startDate).getTime();
        const endMs = endDateValue.getTime();
        const referenceMs = validReferenceDate.getTime();
        const status = referenceMs < startMs ? 'upcoming' : (referenceMs >= endMs ? 'repaid' : 'active');

        return {
            name: credit?.name || 'Crédit',
            initialAmount: roundMoney(initialAmount),
            remainingCapital: roundMoney(remainingCapital),
            rate,
            durationMonths,
            monthlyPayment: roundMoney(monthlyPayment),
            currentMonthlyPayment: status === 'active' ? roundMoney(monthlyPayment) : 0,
            startDate,
            endDate,
            status
        };
    });

    const debtComplete = creditDetails.every(credit => credit.remainingCapital !== null);
    const paymentsComplete = creditDetails.every(credit => credit.currentMonthlyPayment !== null);
    const totalDebt = debtComplete
        ? roundMoney(creditDetails.reduce((sum, credit) => sum + credit.remainingCapital, 0))
        : null;
    const totalMonthlyPayment = paymentsComplete
        ? roundMoney(creditDetails.reduce((sum, credit) => sum + credit.currentMonthlyPayment, 0))
        : null;
    const currentValue = finiteNumber(residence.currentValue);
    const purchasePrice = finiteNumber(residence.purchasePrice);
    const weightedRate = debtComplete && totalDebt > 0
        ? creditDetails.reduce((sum, credit) => sum + credit.remainingCapital * credit.rate, 0) / totalDebt
        : (debtComplete && totalDebt === 0 ? 0 : null);

    return {
        name: residence.name || 'Résidence principale',
        purchasePrice: roundMoney(purchasePrice),
        currentValue: roundMoney(currentValue),
        purchaseDate: isoDay(residence.purchaseDate),
        debtAsOf: isoDay(validReferenceDate),
        creditsCount: creditDetails.length,
        totalDebt,
        totalMonthlyPayment,
        weightedRate: weightedRate === null ? null : Math.round(weightedRate * 10000) / 10000,
        equity: currentValue !== null && totalDebt !== null
            ? roundMoney(currentValue - totalDebt)
            : null,
        debtStatus: debtComplete && paymentsComplete ? 'complete' : 'unavailable',
        credits: creditDetails
    };
}
