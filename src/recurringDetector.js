// ========================================
// recurringDetector.js - Détection des dépenses/revenus fixes (récurrents)
// ========================================
// Approche : regrouper les transactions par libellé normalisé (commerçant/motif, sans les
// chiffres qui varient d'une occurrence à l'autre), puis ne garder que les groupes qui
// apparaissent sur plusieurs mois distincts avec un montant à peu près stable.
// `forcedKeys` permet de contourner ces critères pour les entrées ajoutées manuellement
// par l'utilisateur (une seule occurrence suffit alors).

const AMOUNT_TOLERANCE_RATIO = 0.15; // tolérance sur le montant (ex: factures d'énergie qui varient un peu)
const AMOUNT_TOLERANCE_FLOOR = 1; // tolérance plancher en euros, pour les petits montants

function normalizeLabel(tx) {
  const raw = (tx.counterparty || tx.description || '').toLowerCase();
  return raw
    .replace(/[0-9]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function monthKey(dateStr) {
  return (dateStr || '').slice(0, 7);
}

// Calcule le même identifiant de groupe que detectRecurring, pour permettre à l'UI de
// rattacher manuellement une transaction précise à une entrée "fixe".
export function computeRecurringKey(tx) {
  const label = normalizeLabel(tx);
  if (!label) return null;
  const direction = tx.direction === 'CRDT' ? 'CRDT' : 'DBIT';
  return `${direction}_${label}`;
}

export function detectRecurring(transactions, opts = {}) {
  const { minMonths = 2, lookbackMonths = 6, forcedKeys = new Set(), customLabels = {} } = opts;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - lookbackMonths + 1, 1);

  const recent = transactions.filter((tx) => tx.bookingDate && new Date(tx.bookingDate) >= cutoff);

  const groups = {};
  recent.forEach((tx) => {
    const key = computeRecurringKey(tx);
    if (!key) return;
    (groups[key] = groups[key] || []).push(tx);
  });

  const results = [];
  Object.entries(groups).forEach(([key, txs]) => {
    const forced = forcedKeys.has(key);
    const months = new Set(txs.map((tx) => monthKey(tx.bookingDate)));
    if (!forced && months.size < minMonths) return;

    const amounts = txs.map((tx) => Math.abs(tx.amount || 0)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    if (!median) return;

    if (!forced) {
      const tolerance = Math.max(median * AMOUNT_TOLERANCE_RATIO, AMOUNT_TOLERANCE_FLOOR);
      const consistent = txs.every((tx) => Math.abs(Math.abs(tx.amount || 0) - median) <= tolerance);
      if (!consistent) return;
    }

    const days = txs.map((tx) => new Date(tx.bookingDate).getDate());
    const typicalDay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);

    const sample = txs.slice().sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''))[0];

    results.push({
      key,
      label: customLabels[key] || sample.counterparty || sample.description || 'Transaction',
      direction: sample.direction === 'CRDT' ? 'CRDT' : 'DBIT',
      category: sample.category,
      amount: median,
      typicalDay,
      monthsSeen: months.size,
      monthsSet: months,
      manual: forced,
    });
  });

  return results.sort((a, b) => b.amount - a.amount);
}
