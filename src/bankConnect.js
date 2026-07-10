// ========================================
// bankConnect.js - Connexion bancaire (Enable Banking / Open Banking)
// ========================================

import { ENABLE_BANKING_PROXY_URL } from './config.js';

// À VÉRIFIER avant mise en prod : le champ "name" doit correspondre EXACTEMENT à la valeur
// renvoyée par Enable Banking pour cet ASPSP. Interrogez le worker pour le confirmer :
//   GET {ENABLE_BANKING_PROXY_URL}/aspsps?country=GB   (Revolut)
//   GET {ENABLE_BANKING_PROXY_URL}/aspsps?country=FR   (Boursorama)
//   GET {ENABLE_BANKING_PROXY_URL}/aspsps?country=DE   (Trade Republic)
// et repérez l'entrée dont le "name" correspond à la banque visée.
const BANK_ASPSP_MAP = {
  'RV-CT': { name: 'Revolut', country: 'GB' },
  'TR-CT': { name: 'Trade Republic', country: 'DE' },
  'BB-PEA': { name: 'Boursorama Banque', country: 'FR' },
};

// Déclenche le flux de connexion bancaire : récupère l'URL d'autorisation Enable Banking
// auprès du Worker puis redirige le navigateur (l'utilisateur revient ensuite sur le
// dashboard via le Worker, après consentement + synchronisation des données).
export async function connectBank(brokerValue) {
  const bank = BANK_ASPSP_MAP[brokerValue];
  if (!bank) throw new Error(`Aucune banque Enable Banking mappée pour "${brokerValue}"`);

  const user = firebase.auth().currentUser;
  if (!user) throw new Error('Utilisateur non connecté');
  const idToken = await user.getIdToken();

  const res = await fetch(`${ENABLE_BANKING_PROXY_URL}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ aspspName: bank.name, aspspCountry: bank.country }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erreur ${res.status} lors de la connexion bancaire`);
  }

  const { url } = await res.json();
  window.location.href = url;
}

// À appeler au chargement du dashboard pour afficher le résultat du callback
// (?bank_connected=1&accounts=N ou ?bank_error=...) puis nettoyer l'URL.
export function handleBankConnectionRedirect(onSuccess, onError) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('bank_connected') && !params.has('bank_error')) return;

  if (params.has('bank_connected')) {
    onSuccess?.(Number(params.get('accounts') || 0));
  } else if (params.has('bank_error')) {
    onError?.(params.get('bank_error'));
  }

  params.delete('bank_connected');
  params.delete('bank_error');
  params.delete('accounts');
  const newQuery = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (newQuery ? `?${newQuery}` : ''));
}
