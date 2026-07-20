// ========================================
// expenseCategorizer.js - Catégorisation heuristique des transactions bancaires
// ========================================
// Basé sur des mots-clés recherchés dans la description / le nom du contrepartie.
// Approche best-effort : les banques françaises ne fournissent pas toujours un
// merchant_category_code fiable via Open Banking, on catégorise donc par texte.

const DEBIT_CATEGORIES = [
  { key: 'alimentation', label: 'Alimentation', icon: '🛒', color: '#10b981', keywords: ['carrefour', 'leclerc', 'auchan', 'monoprix', 'lidl', 'aldi', 'franprix', 'casino', 'intermarche', 'super u', 'biocoop', 'naturalia', 'picard', 'grand frais', 'cora', 'match'] },
  { key: 'restauration', label: 'Restauration', icon: '🍽️', color: '#f59e0b', keywords: ['restaurant', 'mcdonald', 'burger king', 'kfc', 'uber eats', 'deliveroo', 'just eat', 'brasserie', 'boulangerie', 'starbucks', 'pizza', 'sushi'] },
  { key: 'transport', label: 'Transport', icon: '🚗', color: '#3b82f6', keywords: ['sncf', 'ratp', 'uber', 'taxi', 'essence', 'station', 'autoroute', 'vinci', 'blablacar', 'navigo', 'velib', 'total energies', 'esso', 'shell', 'parking'] },
  { key: 'logement', label: 'Logement & Énergie', icon: '🏠', color: '#8b5cf6', keywords: ['edf', 'engie', 'veolia', 'loyer', 'syndic', 'eau de paris', 'direct energie', 'total direct'] },
  { key: 'abonnements', label: 'Abonnements', icon: '🔁', color: '#ec4899', keywords: ['netflix', 'spotify', 'disney', 'amazon prime', 'orange', 'sfr', 'free mobile', 'bouygues', 'canal+', 'deezer', 'apple.com', 'icloud', 'youtube premium'] },
  { key: 'shopping', label: 'Shopping', icon: '🛍️', color: '#06b6d4', keywords: ['amazon', 'fnac', 'zalando', 'cdiscount', 'decathlon', 'ikea', 'shein', 'vinted'] },
  { key: 'sante', label: 'Santé', icon: '💊', color: '#ef4444', keywords: ['pharmacie', 'medecin', 'docteur', 'dentiste', 'mutuelle', 'ameli', 'cpam', 'hopital', 'laboratoire'] },
  { key: 'loisirs', label: 'Loisirs', icon: '🎬', color: '#f97316', keywords: ['cinema', 'theatre', 'concert', 'spectacles', 'musee', 'parc asterix', 'disneyland'] },
  { key: 'assurance', label: 'Assurance', icon: '🛡️', color: '#14b8a6', keywords: ['assurance', 'maaf', 'maif', 'axa', 'allianz', 'matmut', 'macif'] },
  { key: 'retrait', label: 'Retraits espèces', icon: '💵', color: '#6b7280', keywords: ['retrait', 'distributeur', 'dab '] },
  { key: 'frais', label: 'Frais bancaires', icon: '🏦', color: '#94a3b8', keywords: ['cotisation', 'frais', 'agios', 'commission'] },
  { key: 'virement_envoye', label: 'Virements envoyés', icon: '↗️', color: '#a855f7', keywords: ['vir sepa', 'virement', 'prlv', 'prelevement'] },
];

const CREDIT_CATEGORIES = [
  { key: 'salaire', label: 'Salaire', icon: '💰', color: '#10b981', keywords: ['salaire', 'paie', 'payroll'] },
  { key: 'remboursement', label: 'Remboursements', icon: '↩️', color: '#22c55e', keywords: ['remboursement', 'ameli', 'secu', 'cpam', 'mutuelle'] },
  { key: 'virement_recu', label: 'Virements reçus', icon: '↘️', color: '#38bdf8', keywords: ['vir sepa', 'virement'] },
];

const DEFAULT_DEBIT = { key: 'autre_depense', label: 'Autres dépenses', icon: '❓', color: '#9fa6bc' };
const DEFAULT_CREDIT = { key: 'autre_revenu', label: 'Autres revenus', icon: '➕', color: '#9fa6bc' };

export function isCredit(tx) {
  return tx.direction === 'CRDT';
}

export function categorizeTransaction(tx) {
  const haystack = `${tx.description || ''} ${tx.counterparty || ''}`.toLowerCase();
  const pool = isCredit(tx) ? CREDIT_CATEGORIES : DEBIT_CATEGORIES;
  const match = pool.find((c) => c.keywords.some((k) => haystack.includes(k)));
  return match || (isCredit(tx) ? DEFAULT_CREDIT : DEFAULT_DEBIT);
}
