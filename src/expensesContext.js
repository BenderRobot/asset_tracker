// ========================================
// expensesContext.js - Contexte budget/cashflow partagé (rapport IA dédié + assistant chat)
// ========================================
// Rassemble et résume l'historique bancaire (transactions, charges/revenus fixes) en un texte
// compact, pour l'envoyer à un LLM sans reformater les milliers de transactions brutes.

import { db } from './firebaseConfig.js';
import { categorizeTransaction, isCredit } from './expenseCategorizer.js';
import { detectRecurring, FREQUENCY_LABELS } from './recurringDetector.js';

const AVERAGE_MONTHS = 3; // mois complets (hors mois courant, souvent partiel) utilisés pour les moyennes

function monthlyEquivalent(item) {
  return item.amount / (item.frequencyMonths || 1);
}

export async function buildExpensesContext(uid) {
  const [txSnap, accSnap, prefsSnap] = await Promise.all([
    db.collection(`users/${uid}/transactions`).get(),
    db.collection(`users/${uid}/bankAccounts`).get(),
    db.doc(`users/${uid}/settings/recurringPrefs`).get(),
  ]);

  if (txSnap.empty) return null;

  const accountsById = {};
  accSnap.docs.forEach((d) => { accountsById[d.id] = d.data(); });

  const transactions = txSnap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((tx) => accountsById[tx.accountId]?.cashAccountType !== 'CARD')
    .map((tx) => ({ ...tx, category: categorizeTransaction(tx) }));

  if (!transactions.length) return null;

  const prefs = prefsSnap.data() || {};
  const dismissedKeys = new Set(prefs.dismissedKeys || []);
  const manualKeys = new Set(prefs.manualKeys || []);

  const recurring = detectRecurring(transactions, {
    forcedKeys: manualKeys,
    customLabels: prefs.customLabels || {},
    customFrequencies: prefs.customFrequencies || {},
  }).filter((item) => !dismissedKeys.has(item.key));

  const fixedCharges = recurring.filter((item) => item.direction === 'DBIT');
  const fixedIncome = recurring.filter((item) => item.direction === 'CRDT');

  const monthlyFixedCharges = fixedCharges.reduce((s, i) => s + monthlyEquivalent(i), 0);
  const monthlyFixedIncome = fixedIncome.reduce((s, i) => s + monthlyEquivalent(i), 0);

  // Moyennes réelles sur les derniers mois complets (le mois en cours est souvent partiel).
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const monthBuckets = {};
  transactions.forEach((tx) => {
    if (!tx.bookingDate) return;
    const key = tx.bookingDate.slice(0, 7);
    if (!monthBuckets[key]) monthBuckets[key] = { income: 0, expenses: 0, byCategory: {} };
    const amount = Math.abs(tx.amount || 0);
    if (isCredit(tx)) {
      monthBuckets[key].income += amount;
    } else {
      monthBuckets[key].expenses += amount;
      const label = tx.category.label;
      monthBuckets[key].byCategory[label] = (monthBuckets[key].byCategory[label] || 0) + amount;
    }
  });

  const pastMonthKeys = Object.keys(monthBuckets).filter((k) => k !== currentMonthKey).sort().slice(-AVERAGE_MONTHS);
  const nMonths = pastMonthKeys.length || 1;

  const avgMonthlyIncome = pastMonthKeys.reduce((s, k) => s + monthBuckets[k].income, 0) / nMonths;
  const avgMonthlyExpenses = pastMonthKeys.reduce((s, k) => s + monthBuckets[k].expenses, 0) / nMonths;

  const categoryTotals = {};
  pastMonthKeys.forEach((k) => {
    Object.entries(monthBuckets[k].byCategory).forEach(([label, amount]) => {
      categoryTotals[label] = (categoryTotals[label] || 0) + amount;
    });
  });
  const categoryAverages = Object.entries(categoryTotals)
    .map(([label, total]) => ({ label, avgMonthly: total / nMonths }))
    .sort((a, b) => b.avgMonthly - a.avgMonthly);

  return {
    monthsAnalyzed: pastMonthKeys.length,
    avgMonthlyIncome,
    avgMonthlyExpenses,
    avgMonthlyCashflow: avgMonthlyIncome - avgMonthlyExpenses,
    fixedCharges,
    fixedIncome,
    monthlyFixedCharges,
    monthlyFixedIncome,
    categoryAverages,
  };
}

export function formatExpensesContextAsText(ctx) {
  if (!ctx) return 'Aucune donnée bancaire disponible (aucune banque connectée ou historique insuffisant).';

  const freqLabel = (f) => FREQUENCY_LABELS[f] || FREQUENCY_LABELS[1];

  const chargesText = ctx.fixedCharges.length
    ? ctx.fixedCharges
      .map((c) => `- ${c.label}: ${c.amount.toFixed(2)}€ (${freqLabel(c.frequencyMonths)}, ~${monthlyEquivalent(c).toFixed(2)}€/mois)`)
      .join('\n')
    : 'Aucune charge fixe détectée.';

  const incomeText = ctx.fixedIncome.length
    ? ctx.fixedIncome
      .map((i) => `- ${i.label}: ${i.amount.toFixed(2)}€ (${freqLabel(i.frequencyMonths)}, ~${monthlyEquivalent(i).toFixed(2)}€/mois)`)
      .join('\n')
    : 'Aucun revenu fixe détecté.';

  const categoriesText = ctx.categoryAverages.length
    ? ctx.categoryAverages.slice(0, 10).map((c) => `- ${c.label}: ~${c.avgMonthly.toFixed(2)}€/mois en moyenne`).join('\n')
    : 'Pas assez d\'historique pour une moyenne par catégorie.';

  return `Analyse basée sur ${ctx.monthsAnalyzed || 'moins d\'un'} mois complet(s) d'historique bancaire réel.
Revenus moyens réels: ${ctx.avgMonthlyIncome.toFixed(2)}€/mois
Dépenses moyennes réelles: ${ctx.avgMonthlyExpenses.toFixed(2)}€/mois
Cashflow moyen actuel: ${ctx.avgMonthlyCashflow.toFixed(2)}€/mois

=== CHARGES FIXES (détectées automatiquement ou ajoutées manuellement par l'utilisateur) ===
${chargesText}
Total charges fixes: ~${ctx.monthlyFixedCharges.toFixed(2)}€/mois (équivalent mensuel, toutes fréquences confondues)

=== REVENUS FIXES ===
${incomeText}
Total revenus fixes: ~${ctx.monthlyFixedIncome.toFixed(2)}€/mois (équivalent mensuel)

=== DÉPENSES PAR CATÉGORIE (moyenne mensuelle réelle) ===
${categoriesText}`;
}
