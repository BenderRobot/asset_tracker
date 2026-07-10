// ========================================
// bankConnect.js - Connexion bancaire (Enable Banking / Open Banking)
// ========================================

import { ENABLE_BANKING_PROXY_URL } from './config.js';

// Liste complète des ASPSP (banques) disponibles pour cette application Enable Banking,
// récupérée une seule fois puis mise en cache en mémoire pour peupler les sélecteurs Pays / Banque.
let cachedAspsps = null;

async function fetchAllAspsps() {
  if (cachedAspsps) return cachedAspsps;
  const res = await fetch(`${ENABLE_BANKING_PROXY_URL}/aspsps`);
  if (!res.ok) throw new Error(`Impossible de récupérer la liste des banques (HTTP ${res.status})`);
  const data = await res.json();
  cachedAspsps = data.aspsps || [];
  return cachedAspsps;
}

// Retourne la liste des pays disponibles, triés par nom affiché (ex: "France").
export async function getAvailableCountries() {
  const aspsps = await fetchAllAspsps();
  const codes = [...new Set(aspsps.map((a) => a.country))];
  const displayNames = new Intl.DisplayNames(['fr'], { type: 'region' });
  return codes
    .map((code) => ({ code, label: displayNames.of(code) || code }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// Retourne les noms de banques disponibles pour un pays donné, triés alphabétiquement.
export async function getBanksForCountry(country) {
  const aspsps = await fetchAllAspsps();
  return aspsps
    .filter((a) => a.country === country)
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));
}

// Déclenche le flux de connexion bancaire : récupère l'URL d'autorisation Enable Banking
// auprès du Worker puis redirige le navigateur (l'utilisateur revient ensuite sur le
// dashboard via le Worker, après consentement + synchronisation des données).
export async function connectBank(aspspName, aspspCountry) {
  if (!aspspName || !aspspCountry) throw new Error('Banque et pays requis');

  const user = firebase.auth().currentUser;
  if (!user) throw new Error('Utilisateur non connecté');
  const idToken = await user.getIdToken();

  const res = await fetch(`${ENABLE_BANKING_PROXY_URL}/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ aspspName, aspspCountry }),
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
