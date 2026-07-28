// ========================================
// recurringDetector.js - Détection des dépenses/revenus fixes (récurrents)
// ========================================
// Approche : regrouper les transactions par libellé normalisé (commerçant/motif, sans les
// chiffres qui varient d'une occurrence à l'autre), puis ne garder que les groupes qui
// apparaissent sur plusieurs mois distincts. La fréquence (mensuel/trimestriel/semestriel/
// annuel) est déduite de l'écart entre occurrences, ou fournie par `customFrequencies` (ex:
// une charge trimestrielle vue seulement 2 fois sur 6 mois ne peut pas être déduite avec
// certitude, l'utilisateur peut la préciser manuellement).
// `forcedKeys` permet de contourner les critères de détection pour les entrées ajoutées
// manuellement par l'utilisateur (une seule occurrence suffit alors).

const AMOUNT_TOLERANCE_RATIO = 0.15; // tolérance sur le montant (ex: factures d'énergie qui varient un peu)
const AMOUNT_TOLERANCE_FLOOR = 1; // tolérance plancher en euros, pour les petits montants
const STANDARD_FREQUENCIES = [1, 2, 3, 6, 12]; // mensuel, bimestriel, trimestriel, semestriel, annuel

export const FREQUENCY_LABELS = {
  1: 'Mensuel',
  2: 'Bimestriel',
  3: 'Trimestriel',
  6: 'Semestriel',
  12: 'Annuel',
};

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

function monthIndex(dateStr) {
  const d = new Date(dateStr);
  return d.getFullYear() * 12 + d.getMonth();
}

// Déduit la fréquence (en mois) à partir de l'écart entre occurrences successives.
// Avec moins de 2 occurrences, impossible à déduire : on suppose mensuel par défaut
// (l'utilisateur peut corriger via customFrequencies).
function inferFrequencyMonths(txs) {
  const sorted = txs.slice().sort((a, b) => (a.bookingDate || '').localeCompare(b.bookingDate || ''));
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = monthIndex(sorted[i].bookingDate) - monthIndex(sorted[i - 1].bookingDate);
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 1;
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)];
  return STANDARD_FREQUENCIES.reduce(
    (best, f) => (Math.abs(f - medianGap) < Math.abs(best - medianGap) ? f : best),
    STANDARD_FREQUENCIES[0]
  );
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
  const { minMonths = 2, lookbackMonths = 6, forcedKeys = new Set(), customLabels = {}, customFrequencies = {} } = opts;
  const now = new Date();
  const cutoff = new Date(now.getFullYear(), now.getMonth() - lookbackMonths + 1, 1);
  const nowMonthIdx = now.getFullYear() * 12 + now.getMonth();

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

    const inferredFrequency = inferFrequencyMonths(txs);
    const frequencyMonths = customFrequencies[key] || inferredFrequency;

    const amounts = txs.map((tx) => Math.abs(tx.amount || 0)).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    if (!median) return;

    // La cohérence de montant n'a de sens que pour du mensuel : une charge trimestrielle avec
    // régularisation peut légitimement varier fortement d'une échéance à l'autre.
    if (!forced && frequencyMonths === 1) {
      const tolerance = Math.max(median * AMOUNT_TOLERANCE_RATIO, AMOUNT_TOLERANCE_FLOOR);
      const consistent = txs.every((tx) => Math.abs(Math.abs(tx.amount || 0) - median) <= tolerance);
      if (!consistent) return;
    }

    const days = txs.map((tx) => new Date(tx.bookingDate).getDate());
    const typicalDay = Math.round(days.reduce((s, d) => s + d, 0) / days.length);

    const sample = txs.slice().sort((a, b) => (b.bookingDate || '').localeCompare(a.bookingDate || ''))[0];
    const monthsSinceLast = nowMonthIdx - monthIndex(sample.bookingDate);

    results.push({
      key,
      label: customLabels[key] || sample.counterparty || sample.description || 'Transaction',
      direction: sample.direction === 'CRDT' ? 'CRDT' : 'DBIT',
      category: sample.category,
      // Le montant le plus récent plutôt que la médiane historique : pour une facture qui varie
      // (énergie, régularisation de charges...), c'est le dernier prélèvement réel qui doit
      // s'afficher, pas une moyenne datée.
      amount: Math.abs(sample.amount || median),
      typicalDay,
      monthsSeen: months.size,
      monthsSet: months,
      manual: forced,
      frequencyMonths,
      monthsSinceLast,
      // "Dû ce mois-ci" : soit déjà réglé ce mois, soit l'échéance est atteinte/dépassée depuis
      // la dernière occurrence. Entre deux échéances (ex: mois 2 sur 3 d'un trimestre), la charge
      // ne doit pas être comptée dans les totaux du mois.
      dueThisCycle: monthsSinceLast <= 0 || monthsSinceLast >= frequencyMonths,
    });
  });

  return results.sort((a, b) => b.amount - a.amount);
}
