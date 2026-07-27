// ========================================
// recurringDetector.js - Détection heuristique des dépenses/revenus fixes (récurrents)
// ========================================
// Approche : regrouper les transactions par libellé normalisé (commerçant/motif, sans les
// chiffres qui varient d'une occurrence à l'autre), puis ne garder que les groupes qui
// apparaissent sur plusieurs mois distincts avec un montant à peu près stable.

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

export function detectRecurring(transactions, { minMonths = 2, lookbackMonths = 6 } = {}) {
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - lookbackMonths + 1, 1);

  const recent = transactions.filter((tx) => tx.bookingDate && new Date(tx.bookingDate) >= cutoff);

  const groups = {};
  recent.forEach((tx) => {
    const label = normalizeLabel(tx);
    if (!label) return;
    const direction = tx.direction === 'CRDT' ? 'CRDT' : 'DBIT';
    const key = `${direction}_${label}`;
    (groups[key] = groups[key] || []).push(tx);
  });

  const results = [];
  Object.values(groups).forEach((txs) => {
    const months = new Set(txs.map((tx) => monthKey(tx.bookingDate)));
    if (months.size < minMonths) return;

    const amounts = txs.map((tx) => Math.abs(tx.amount || 0)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    if (!median) return;

    const tolerance = Math.max(median * AMOUNT_TOLERANCE_RATIO, AMOUNT_TOLERANCE_FLOOR);
    const consistent = txs.every((tx) => Math.abs(Math.abs(tx.amount || 0) - median) <= tolerance);
    if (!consistent) return;

    const days = txs.map((tx) => new Date(tx.bookingDate).getDate());
    const typicalDay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);

    const sample = txs.slice().sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''))[0];

    results.push({
      label: sample.counterparty || sample.description || 'Transaction',
      direction: sample.direction === 'CRDT' ? 'CRDT' : 'DBIT',
      category: sample.category,
      amount: median,
      typicalDay,
      monthsSeen: months.size,
      monthsSet: months,
    });
  });

  return results.sort((a, b) => b.amount - a.amount);
}
