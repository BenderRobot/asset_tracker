// ========================================
// marketDataMetrics.js — instrumentation réseau/cache (lecture seule, aucun
// impact sur les données financières). Sert à mesurer l'effet des changements
// de src/api.js / src/dataManager.js / src/dashboardApp.js sur le volume de
// requêtes et à comparer un "avant" et un "après" architecture sur les mêmes
// scénarios (chargement à froid, chargement à chaud, session de 30 min).
//
// browserRequests / worker429 / worker5xx / timeouts / averageLatencyMs sont
// mesurés directement ici (le navigateur voit ces codes HTTP en clair, ce
// sont ceux renvoyés par le Worker Cloudflare lui-même).
//
// workerUpstreamRequests / yahoo5xx dépendent d'un en-tête diagnostique
// (X-Yahoo-Attempts / X-Yahoo-Final-Status) que le Worker n'envoie pas
// encore en production — voir cloudflare-workers/prices-worker/worker.js.
// Tant que le Worker déployé ne les renvoie pas, ces deux compteurs restent
// à `null` (distinct de 0, qui voudrait dire "mesuré, zéro requête amont").
// ========================================

const counters = {
  browserRequests: 0,
  workerUpstreamRequests: null,
  cacheHits: 0,
  cacheMisses: 0,
  deduplicatedRequests: 0,
  backgroundRefreshes: 0,
  worker429: 0,
  worker5xx: 0,
  workerOtherError: 0,
  timeouts: 0,
  yahoo5xx: null,
  latencies: [],
  initialRenderMs: null,
  // MarketDataRepository (2026-09-24) — compteurs par couche de cache, plus
  // fins que cacheHits/cacheMisses/deduplicatedRequests ci-dessus (conservés
  // tels quels pour ne pas changer le sens des compteurs déjà mesurés dans le
  // commit de référence 3efb680). snapshotCache* couvre le snapshot canonique
  // du Repository ; historicalCache* est un alias dédié de cacheHits/
  // cacheMisses côté historique seulement (le générique continue d'inclure
  // aussi les prix live) ; inFlightCoalesced couvre TOUTE coalescence, tous
  // niveaux confondus (historique + prix live + snapshot).
  snapshotCacheHits: 0,
  snapshotCacheMisses: 0,
  historicalCacheHits: 0,
  historicalCacheMisses: 0,
  inFlightCoalesced: 0,
  initialNetworkRequests: 0,
  backgroundNetworkRequests: 0,
};

function reset() {
  counters.browserRequests = 0;
  counters.workerUpstreamRequests = null;
  counters.cacheHits = 0;
  counters.cacheMisses = 0;
  counters.deduplicatedRequests = 0;
  counters.backgroundRefreshes = 0;
  counters.worker429 = 0;
  counters.worker5xx = 0;
  counters.workerOtherError = 0;
  counters.timeouts = 0;
  counters.yahoo5xx = null;
  counters.latencies = [];
  counters.initialRenderMs = null;
  counters.snapshotCacheHits = 0;
  counters.snapshotCacheMisses = 0;
  counters.historicalCacheHits = 0;
  counters.historicalCacheMisses = 0;
  counters.inFlightCoalesced = 0;
  counters.initialNetworkRequests = 0;
  counters.backgroundNetworkRequests = 0;
}

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// À appeler juste avant un fetch réseau vers le Worker/Binance. Le handle
// retourné doit être passé à recordRequestEnd une fois la réponse (ou
// l'erreur) connue.
function recordRequestStart(requestType) {
  return { start: now(), requestType };
}

// status : code HTTP numérique sur réponse reçue, ou 'timeout' sur AbortError.
// response : objet Response (optionnel) — utilisé pour lire les en-têtes
// diagnostiques du Worker quand présents (voir commentaire d'en-tête).
function recordRequestEnd(handle, status, response = null) {
  counters.browserRequests++;
  counters.latencies.push(now() - handle.start);

  if (status === 'timeout') {
    counters.timeouts++;
  } else if (status === 429) {
    counters.worker429++;
  } else if (typeof status === 'number' && status >= 500) {
    counters.worker5xx++;
  } else if (typeof status === 'number' && status >= 400) {
    counters.workerOtherError++;
  }

  if (response && typeof response.headers?.get === 'function') {
    const attempts = response.headers.get('X-Yahoo-Attempts');
    if (attempts !== null) {
      const n = parseInt(attempts, 10);
      if (!isNaN(n)) counters.workerUpstreamRequests = (counters.workerUpstreamRequests || 0) + n;
    }
    const yahooStatus = response.headers.get('X-Yahoo-Final-Status');
    if (yahooStatus !== null) {
      const n = parseInt(yahooStatus, 10);
      if (!isNaN(n) && n >= 500) counters.yahoo5xx = (counters.yahoo5xx || 0) + 1;
    }
  }
}

// historical=true : incrémente aussi historicalCacheHits/Misses (alias plus
// spécifique — voir commentaire des compteurs). Laissé à false pour les
// autres couches (prix live) qui ne comptent que dans le générique.
function recordCacheHit(historical = false) {
  counters.cacheHits++;
  if (historical) counters.historicalCacheHits++;
}
function recordCacheMiss(historical = false) {
  counters.cacheMisses++;
  if (historical) counters.historicalCacheMisses++;
}
function recordDedup() {
  counters.deduplicatedRequests++;
  counters.inFlightCoalesced++;
}
function recordSnapshotCacheHit() { counters.snapshotCacheHits++; }
function recordSnapshotCacheMiss() { counters.snapshotCacheMisses++; }
function recordInitialNetworkRequest() { counters.initialNetworkRequests++; }
function recordBackgroundNetworkRequest() { counters.backgroundNetworkRequests++; }
function recordBackgroundRefresh() { counters.backgroundRefreshes++; }
function recordInitialRender() {
  if (counters.initialRenderMs === null) counters.initialRenderMs = Math.round(now() - sessionStart);
}

const sessionStart = now();

function snapshot() {
  const lat = counters.latencies;
  const averageLatencyMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  return {
    browserRequests: counters.browserRequests,
    workerUpstreamRequests: counters.workerUpstreamRequests,
    cacheHits: counters.cacheHits,
    cacheMisses: counters.cacheMisses,
    deduplicatedRequests: counters.deduplicatedRequests,
    backgroundRefreshes: counters.backgroundRefreshes,
    worker429: counters.worker429,
    worker5xx: counters.worker5xx,
    workerOtherError: counters.workerOtherError,
    timeouts: counters.timeouts,
    yahoo5xx: counters.yahoo5xx,
    averageLatencyMs,
    initialRenderMs: counters.initialRenderMs,
    sessionAgeSec: Math.round((now() - sessionStart) / 1000),
    snapshotCacheHits: counters.snapshotCacheHits,
    snapshotCacheMisses: counters.snapshotCacheMisses,
    historicalCacheHits: counters.historicalCacheHits,
    historicalCacheMisses: counters.historicalCacheMisses,
    inFlightCoalesced: counters.inFlightCoalesced,
    initialNetworkRequests: counters.initialNetworkRequests,
    backgroundNetworkRequests: counters.backgroundNetworkRequests,
  };
}

export const marketDataMetrics = {
  reset,
  recordRequestStart,
  recordRequestEnd,
  recordCacheHit,
  recordCacheMiss,
  recordDedup,
  recordSnapshotCacheHit,
  recordSnapshotCacheMiss,
  recordInitialNetworkRequest,
  recordBackgroundNetworkRequest,
  recordBackgroundRefresh,
  recordInitialRender,
  snapshot,
};

if (typeof window !== 'undefined') {
  // Capture manuelle depuis la console devtools : window.__marketDataMetrics.snapshot()
  window.__marketDataMetrics = marketDataMetrics;
}
