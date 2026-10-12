// ========================================
// mortgageCalculator.js - Calculateur de Crédit Immobilier
// ========================================

/**
 * Classe utilitaire pour tous les calculs de crédit immobilier
 * Supporte les PTZ (0%) et crédits classiques
 */
export class MortgageCalculator {
    /**
     * Calcule le capital restant dû pour un crédit à une date donnée
     * @param {Object} credit - { initialAmount, rate, duration (mois), startDate }
     * @param {Date} referenceDate - Date de référence (défaut: aujourd'hui)
     * @returns {number} Capital restant dû en euros
     */
    static calculateRemainingCapital(credit, referenceDate = new Date()) {
        const monthsElapsed = this.getMonthsDiff(credit.startDate, referenceDate);

        // Crédit déjà remboursé
        if (monthsElapsed >= credit.duration) return 0;
        if (monthsElapsed < 0) return credit.initialAmount; // Pas encore commencé

        // PTZ ou crédit à 0% : amortissement linéaire (constant)
        if (credit.rate === 0) {
            const monthlyCapital = credit.initialAmount / credit.duration;
            return Math.max(0, credit.initialAmount - (monthlyCapital * monthsElapsed));
        }

        // Crédit classique : formule d'amortissement dégressif
        const monthlyRate = credit.rate / 100 / 12;
        const monthlyPayment = this.calculateMonthlyPayment(credit);

        // Formule du capital restant dû (amortissement dégressif)
        // CRD = K * (1+i)^n - M * [((1+i)^n - 1) / i]
        const remaining = credit.initialAmount * Math.pow(1 + monthlyRate, monthsElapsed) -
            monthlyPayment * ((Math.pow(1 + monthlyRate, monthsElapsed) - 1) / monthlyRate);

        return Math.max(0, remaining);
    }

    /**
     * Calcule la mensualité d'un crédit
     * @param {Object} credit
     * @returns {number} Mensualité en euros
     */
    static calculateMonthlyPayment(credit) {
        // Support manual override
        if (credit.monthlyPayment) {
            return parseFloat(credit.monthlyPayment);
        }

        // PTZ à 0% : mensualité constante = capital / durée
        if (credit.rate === 0) {
            return credit.initialAmount / credit.duration;
        }

        // Crédit classique : formule de mensualité
        // M = K * [i * (1+i)^n] / [(1+i)^n - 1]
        const monthlyRate = credit.rate / 100 / 12;
        return credit.initialAmount *
            (monthlyRate * Math.pow(1 + monthlyRate, credit.duration)) /
            (Math.pow(1 + monthlyRate, credit.duration) - 1);
    }

    /**
     * Calcule le capital total remboursé jusqu'à maintenant
     * @param {Object} credit
     * @param {Date} referenceDate
     * @returns {number} Capital remboursé en euros
     */
    static calculateCapitalPaid(credit, referenceDate = new Date()) {
        const initial = credit.initialAmount;
        const remaining = this.calculateRemainingCapital(credit, referenceDate);
        return initial - remaining;
    }

    /**
     * Calcule les intérêts payés jusqu'à maintenant
     * @param {Object} credit
     * @param {Date} referenceDate
     * @returns {number} Intérêts payés en euros
     */
    static calculateInterestPaid(credit, referenceDate = new Date()) {
        if (credit.rate === 0) return 0; // Pas d'intérêts pour PTZ

        const monthsElapsed = Math.min(
            this.getMonthsDiff(credit.startDate, referenceDate),
            credit.duration
        );

        if (monthsElapsed <= 0) return 0;

        const monthlyPayment = this.calculateMonthlyPayment(credit);
        const totalPaid = monthlyPayment * monthsElapsed;
        const capitalPaid = this.calculateCapitalPaid(credit, referenceDate);

        return totalPaid - capitalPaid;
    }

    /**
     * Calcule le coût total du crédit (intérêts sur toute la durée)
     * @param {Object} credit
     * @returns {number} Coût total en euros
     */
    static calculateTotalCost(credit) {
        if (credit.rate === 0) return 0;

        const monthlyPayment = this.calculateMonthlyPayment(credit);
        const totalPaid = monthlyPayment * credit.duration;
        return totalPaid - credit.initialAmount;
    }

    /**
     * Calcule le taux moyen pondéré de plusieurs crédits
     * @param {Array} credits - Tableau de crédits
     * @returns {number} Taux moyen pondéré en %
     */
    static calculateWeightedAverageRate(credits) {
        const totalAmount = credits.reduce((sum, c) => sum + c.initialAmount, 0);
        if (totalAmount === 0) return 0;

        const weightedSum = credits.reduce((sum, c) => sum + (c.initialAmount * c.rate), 0);
        return weightedSum / totalAmount;
    }

    /**
     * Calcule la mensualité totale de plusieurs crédits
     * @param {Array} credits
     * @returns {number} Mensualité totale en euros
     */
    static calculateTotalMonthlyPayment(credits) {
        return credits.reduce((sum, credit) => sum + this.calculateMonthlyPayment(credit), 0);
    }

    /**
     * Calcule le capital total restant dû pour plusieurs crédits
     * @param {Array} credits
     * @param {Date} referenceDate
     * @returns {number} Capital total restant en euros
     */
    static calculateTotalRemainingCapital(credits, referenceDate = new Date()) {
        return credits.reduce((sum, credit) =>
            sum + this.calculateRemainingCapital(credit, referenceDate), 0);
    }

    /**
     * Calcule la différence en mois entre deux dates
     * @param {string|Date} startDate
     * @param {string|Date} endDate
     * @returns {number} Nombre de mois
     */
    static getMonthsDiff(startDate, endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);

        return (end.getFullYear() - start.getFullYear()) * 12 +
            (end.getMonth() - start.getMonth());
    }

    /**
     * Calcule la date de fin d'un crédit
     * @param {Object} credit
     * @returns {Date} Date de fin du crédit
     */
    static getEndDate(credit) {
        const start = new Date(credit.startDate);
        start.setMonth(start.getMonth() + credit.duration);
        return start;
    }

    /**
     * Calcule le pourcentage de remboursement
     * @param {Object} credit
     * @param {Date} referenceDate
     * @returns {number} Pourcentage remboursé (0-100)
     */
    static getRepaymentProgress(credit, referenceDate = new Date()) {
        const capitalPaid = this.calculateCapitalPaid(credit, referenceDate);
        return (capitalPaid / credit.initialAmount) * 100;
    }

    /**
     * Simule un crédit mois par mois avec un scénario de renégociation / remboursement anticipé.
     * Les mois sont repérés par une clé `année * 12 + mois` (cf. monthKey).
     * @param {Object} credit
     * @param {Object} scenario
     * @param {number} [scenario.fromKey] - Première échéance concernée par le scénario
     * @param {number|null} [scenario.rate] - Nouveau taux annuel (%) à partir de fromKey, mensualité recalculée sur la durée restante
     * @param {number} [scenario.extraMonthly] - Capital supplémentaire versé chaque mois à partir de fromKey
     * @param {number} [scenario.lumpSum] - Remboursement anticipé ponctuel
     * @param {number} [scenario.lumpKey] - Mois du remboursement anticipé (appliqué après l'échéance du mois)
     * @param {'duration'|'payment'} [scenario.mode] - Après le remboursement anticipé : réduire la durée ou la mensualité
     * @returns {{ balances: Map<number, number>, totalInterest: number, endKey: number, payment: number, lumpApplied: number }}
     *          balances = capital restant dû après l'échéance de chaque mois ; payment = mensualité finale du scénario
     */
    static simulateScenario(credit, scenario = {}) {
        const { fromKey = Infinity, rate = null, extraMonthly = 0, lumpSum = 0, lumpKey = Infinity, mode = 'duration' } = scenario;
        const annuity = (capital, annualRate, months) => {
            if (months <= 0) return capital;
            if (annualRate === 0) return capital / months;
            const i = annualRate / 100 / 12;
            return capital * i / (1 - Math.pow(1 + i, -months));
        };

        const start = new Date(credit.startDate);
        const startKey = this.monthKey(start);
        const balances = new Map();
        let balance = credit.initialAmount;
        let payment = this.calculateMonthlyPayment(credit);
        let annualRate = credit.rate;
        let totalInterest = 0;
        let rateApplied = false;
        let lumpApplied = 0;
        let k = 0;

        while (balance > 0.005 && k < credit.duration + 600) {
            k++;
            const key = startKey + k;
            const remainingMonths = credit.duration - (k - 1);

            if (!rateApplied && rate !== null && key >= fromKey) {
                rateApplied = true;
                annualRate = rate;
                payment = annuity(balance, annualRate, remainingMonths);
            }

            const interest = balance * annualRate / 100 / 12;
            const extra = key >= fromKey ? extraMonthly : 0;
            const capital = Math.min(balance, Math.max(0, payment - interest) + extra);
            totalInterest += interest;
            balance -= capital;

            if (!lumpApplied && lumpSum > 0 && key >= lumpKey && balance > 0) {
                lumpApplied = Math.min(lumpSum, balance);
                balance -= lumpApplied;
                if (mode === 'payment') payment = annuity(balance, annualRate, remainingMonths - 1);
            }

            balances.set(key, Math.max(0, balance));
        }

        return { balances, totalInterest, endKey: startKey + k, payment, lumpApplied };
    }

    /** Clé de mois (année * 12 + mois) utilisée par simulateScenario */
    static monthKey(date) {
        const d = new Date(date);
        return d.getFullYear() * 12 + d.getMonth();
    }

    /** Capital restant dû d'une simulation à un mois donné */
    static balanceAt(simulation, credit, key) {
        const startKey = this.monthKey(credit.startDate);
        if (key <= startKey) return credit.initialAmount;
        if (key >= simulation.endKey) return 0;
        return simulation.balances.get(key) ?? credit.initialAmount;
    }

    /**
     * Génère un tableau d'amortissement pour un crédit
     * @param {Object} credit
     * @param {number} maxMonths - Nombre de mois à générer (défaut: toute la durée)
     * @returns {Array} Tableau d'amortissement
     */
    static generateAmortizationSchedule(credit, maxMonths = null) {
        const months = maxMonths || credit.duration;
        const schedule = [];
        const monthlyPayment = this.calculateMonthlyPayment(credit);
        const monthlyRate = credit.rate / 100 / 12;

        let remainingCapital = credit.initialAmount;

        for (let month = 1; month <= months; month++) {
            const interest = credit.rate === 0 ? 0 : remainingCapital * monthlyRate;
            const capitalPayment = monthlyPayment - interest;
            remainingCapital = Math.max(0, remainingCapital - capitalPayment);

            const date = new Date(credit.startDate);
            date.setMonth(date.getMonth() + month);

            schedule.push({
                month,
                date,
                monthlyPayment: Math.round(monthlyPayment * 100) / 100,
                capitalPayment: Math.round(capitalPayment * 100) / 100,
                interestPayment: Math.round(interest * 100) / 100,
                remainingCapital: Math.round(remainingCapital * 100) / 100
            });
        }

        return schedule;
    }
}
