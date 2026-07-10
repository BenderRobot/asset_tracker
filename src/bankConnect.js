// ========================================
// bankConnect.js - Connexion bancaire (Enable Banking / Open Banking)
// ========================================

import { ENABLE_BANKING_PROXY_URL } from './config.js';

// Valeurs confirmées via GET {ENABLE_BANKING_PROXY_URL}/aspsps?country=XX :
// - Revolut est enregistré sous l'entité lituanienne (LT), pas GB (post-Brexit, Revolut Bank UAB).
// - Boursorama Banque confirmé sous FR.
// - Trade Republic (DE) n'apparaît PAS dans la liste des ASPSP disponibles pour cette application
//   Enable Banking à ce jour — à clarifier avec leur support avant d'activer ce mapping.
const BANK_ASPSP_MAP = {
  'RV-CT': { name: 'Revolut', country: 'LT' },
  'BB-PEA': { name: 'Boursorama Banque', country: 'FR' },
  // 'TR-CT': { name: 'Trade Republic', country: 'DE' }, // indisponible pour l'instant, voir commentaire ci-dessus
};

// Brokers pour lesquels la connexion bancaire Enable Banking est effectivement disponible
// (à utiliser pour peupler un sélecteur côté UI, plutôt que la liste complète BROKERS de config.js).
export function getConnectableBrokerValues() {
  return Object.keys(BANK_ASPSP_MAP);
}

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
