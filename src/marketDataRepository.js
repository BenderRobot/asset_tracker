// ========================================
// marketDataRepository.js — MarketDataRepository (validation architecture
// 2026-09-24). Façade cache-first / stale-while-revalidate au-dessus du
// moteur financier existant :
//
//     UI → MarketDataRepository → memory cache → persistent cache → réseau (Worker)
//
// Ne recalcule AUCUNE formule financière — dataManager.buildTodaySnapshot()
// (qui délègue à HistoryCalculator) reste l'unique producteur du
// PortfolioSnapshot canonique. Ce module se contente de :
//   1. mémoïser ce résultat en mémoire + localStorage, par signature de
//      portefeuille, avec un TTL différencié (frais / stale-mais-affichable) ;
//   2. coalescer les appels concurrents (3 chemins d'init du dashboard) sur
//      UNE seule exécution de buildTodaySnapshot ;
//   3. appliquer la règle fail-closed de la validation d'architecture : un
//      refresh qui revient invalide (échec réseau confirmé) ne dégrade
//      JAMAIS un snapshot déjà valide pour le même portefeuille — l'ancien
//      reste servi tel quel, marqué "degraded".
//
// Objet canonique renvoyé : { snapshotId, generatedAt, prices, fx,
// portfolioSnapshot, dataQuality }, plus quelques champs internes (holdings/
// summary/todayGraphData) pour les consommateurs existants qui en ont besoin
// au-delà du PortfolioSnapshot (ex: le graphique lui-même).
// ========================================

import { marketDataMetrics } from './marketDataMetrics.js';

const FRESH_TTL_MS = 30 * 1000;        // cache valide -> rendu immédiat, AUCUN refresh déclenché
const STALE_MARK_MS = 5 * 60 * 1000;   // au-delà, le snapshot stale servi est en plus marqué "degraded"
const PERSIST_KEY = 'marketDataRepository_snapshot_v1';

function purchaseSignatureLine(p) {
  return `${p.ticker}|${p.quantity}|${p.price}|${p.date}|${p.broker || ''}|${p.assetType || ''}`;
}

// Signature bon marché et stable : change dès que le portefeuille change
// RÉELLEMENT (achat/vente/édition), indépendante de l'ordre de
// storage.getPurchases(). Ne dépend d'aucun prix de marché — une variation de
// prix ne doit jamais, à elle seule, invalider le cache par "changement de
// portefeuille" (c'est le rôle du TTL, pas de la signature).
function purchasesSignature(assetPurchases, cashPurchases) {
  const sig = (arr) => (arr || []).map(purchaseSignatureLine).sort().join(';');
  return `${sig(assetPurchases)}||${sig(cashPurchases)}`;
}

function sameCalendarDay(tsA, tsB) {
  if (!tsA || !tsB) return false;
  return new Date(tsA).toDateString() === new Date(tsB).toDateString();
}

export class MarketDataRepository {
  constructor(dataManager) {
    this.dataManager = dataManager;
    this._memory = null; // { snapshot, computedAt, purchasesSignature, degraded, lastRefreshFailure }
    this._inFlight = null; // { signature, promise }
    this._loadPersisted();
  }

  // ============================================================
  // PERSISTANCE (couche localStorage — voir en-tête). Best-effort : toute
  // erreur (quota, mode privé, JSON corrompu) dégrade silencieusement vers
  // "pas de cache persistant", jamais vers une exception qui bloquerait le
  // rendu.
  // ============================================================
  _loadPersisted() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.snapshot && parsed.computedAt && parsed.purchasesSignature) {
        this._memory = parsed;
      }
    } catch (e) {
      // Cache persistant illisible : on repart simplement sans lui.
    }
  }

  _persist() {
    try {
      if (this._memory) localStorage.setItem(PERSIST_KEY, JSON.stringify(this._memory));
    } catch (e) {
      // Quota dépassé / mode privé : le cache mémoire reste valide pour cette
      // session, seule la persistance inter-sessions est perdue.
    }
  }

  // ============================================================
  // INVALIDATION
  // ============================================================
  invalidate(reason = 'manual') {
    this._memory = null;
    try { localStorage.removeItem(PERSIST_KEY); } catch (e) { /* noop */ }
    console.log(`[MarketDataRepository] invalidate(${reason})`);
  }

  // ============================================================
  // CŒUR CACHE-FIRST / STALE-WHILE-REVALIDATE
  // ============================================================
  // Retourne toujours { snapshot, fromCache, stale, degraded }. Ne bloque
  // JAMAIS sur un refresh background : un appelant qui a déjà un snapshot
  // exploitable (même périmé) le reçoit immédiatement, le refresh se termine
  // en tâche de fond et met à jour le cache pour le PROCHAIN appel.
  async getSnapshot(assetPurchases, cashPurchases = [], { forceRefresh = false } = {}) {
    const signature = purchasesSignature(assetPurchases, cashPurchases);
    const now = Date.now();

    // Changement de jour de bourse depuis le dernier calcul : la clôture
    // veille qu'il porte a été résolue POUR HIER par rapport à ce moment-là —
    // la réafficher sans réévaluation serait franchement fausse pour
    // aujourd'hui (contrairement à un prix qui a juste vieilli de quelques
    // minutes). Traité comme une invalidation avant même de regarder le TTL.
    if (this._memory && !sameCalendarDay(this._memory.computedAt, now)) {
      this.invalidate('trading-day-changed');
    }

    const cached = this._memory;
    const cacheUsable = cached && cached.purchasesSignature === signature;

    if (!forceRefresh && cacheUsable) {
      const age = now - cached.computedAt;
      if (age < FRESH_TTL_MS) {
        marketDataMetrics.recordSnapshotCacheHit();
        return { snapshot: cached.snapshot, fromCache: true, stale: false, degraded: !!cached.degraded };
      }
      // Stale mais exploitable : on le sert IMMÉDIATEMENT (jamais de blocage
      // sur le réseau ici) et on déclenche un refresh en tâche de fond,
      // sans l'attendre.
      marketDataMetrics.recordSnapshotCacheHit();
      this._refresh(assetPurchases, cashPurchases, signature, { background: true }).catch(() => { /* voir _refresh : ne rejette jamais réellement */ });
      return {
        snapshot: cached.snapshot,
        fromCache: true,
        stale: true,
        degraded: !!cached.degraded || age > STALE_MARK_MS
      };
    }

    // Aucun cache exploitable pour CE portefeuille (absent, signature
    // différente, ou forceRefresh explicite) : on doit attendre un premier
    // calcul avant de pouvoir répondre.
    marketDataMetrics.recordSnapshotCacheMiss();
    const snapshot = await this._refresh(assetPurchases, cashPurchases, signature, { background: false });
    const stillCached = this._memory && this._memory.purchasesSignature === signature;
    return {
      snapshot,
      fromCache: false,
      stale: false,
      degraded: stillCached ? !!this._memory.degraded : false
    };
  }

  // Coalescing : un refresh déjà en vol pour la MÊME signature est partagé,
  // jamais relancé (même garantie qu'api.js::_inFlightHistoricalRequests /
  // _inFlightBatchPriceRequests).
  _refresh(assetPurchases, cashPurchases, signature, { background }) {
    if (this._inFlight && this._inFlight.signature === signature) {
      marketDataMetrics.recordDedup();
      return this._inFlight.promise;
    }

    if (background) marketDataMetrics.recordBackgroundNetworkRequest();
    else marketDataMetrics.recordInitialNetworkRequest();
    marketDataMetrics.recordBackgroundRefresh();

    const promise = this._computeSnapshot(assetPurchases, cashPurchases)
      .then(newSnapshot => this._applyRefreshResult(signature, newSnapshot))
      .catch(err => {
        this._inFlight = null;
        // Un bug interne (pas un échec réseau — voir _computeSnapshot, qui ne
        // rejette jamais pour une raison réseau/HTTP, voir HistoryCalculator/
        // api.js) : même règle fail-closed que pour un résultat "invalid" —
        // si un snapshot valide existe déjà pour ce portefeuille, on le
        // garde plutôt que de propager une exception jusqu'à l'appelant.
        if (this._memory && this._memory.purchasesSignature === signature && this._memory.snapshot.portfolioSnapshot.status === 'valid') {
          this._memory = { ...this._memory, degraded: true, lastRefreshFailure: err?.message || String(err) };
          this._persist();
          return this._memory.snapshot;
        }
        throw err;
      });

    this._inFlight = { signature, promise };
    return promise;
  }

  _applyRefreshResult(signature, newSnapshot) {
    this._inFlight = null;
    const isValid = newSnapshot.portfolioSnapshot.status === 'valid';
    const hadValidCacheForSameSignature =
      this._memory &&
      this._memory.purchasesSignature === signature &&
      this._memory.snapshot.portfolioSnapshot.status === 'valid';

    // RÈGLE FINANCIÈRE CRITIQUE (validation architecture 2026-09-24) : un
    // refresh qui revient invalide (échec réseau/HTTP confirmé pour au moins
    // un ticker — voir HistoryCalculator.dataQuality) ne doit JAMAIS
    // dégrader un snapshot déjà valide pour ce même portefeuille. On garde
    // l'ancien tel quel, marqué "degraded" pour que l'UI puisse le signaler,
    // et on ne touche PAS son `computedAt` (son âge réel reste visible).
    if (!isValid && hadValidCacheForSameSignature) {
      this._memory = { ...this._memory, degraded: true, lastRefreshFailure: newSnapshot.portfolioSnapshot.invalidReason || 'PRICE_DATA_UNAVAILABLE' };
      this._persist();
      return this._memory.snapshot;
    }

    this._memory = {
      snapshot: newSnapshot,
      computedAt: Date.now(),
      purchasesSignature: signature,
      degraded: !isValid, // pas de cache antérieur à protéger : on expose l'échec tel quel (priceDataUnavailable en aval)
      lastRefreshFailure: isValid ? null : (newSnapshot.portfolioSnapshot.invalidReason || 'PRICE_DATA_UNAVAILABLE')
    };
    this._persist();
    return newSnapshot;
  }

  // dataManager.buildTodaySnapshot() ne lève JAMAIS d'exception pour une
  // raison réseau/HTTP (voir HistoryCalculator/api.js — toute panne confirmée
  // se traduit par dataQuality.valid=false / portfolioSnapshot.status=
  // 'invalid', jamais un throw) : la formule/le calcul restent inchangés,
  // cette méthode ne fait qu'emballer le résultat dans l'objet canonique du
  // Repository.
  //
  // Récupère aussi les prix live elle-même (fetchBatchPrices, déjà coalescé
  // — voir api.js) et capture livePriceSnapshot IMMÉDIATEMENT après, SANS
  // AUCUN await entre les deux — même garantie anti-race que l'ancien
  // HistoricalChart.update() (voir dataManager.buildTodaySnapshot, doc
  // "Option C"), désormais partagée par TOUS les appelants coalescés sur ce
  // même refresh plutôt que capturée séparément par chacun.
  async _computeSnapshot(assetPurchases, cashPurchases) {
    const tickers = [...new Set((assetPurchases || []).map(p => p.ticker.toUpperCase()))];
    if (tickers.length > 0) {
      await this.dataManager.api.fetchBatchPrices(tickers);
    }
    const livePriceSnapshot = new Map(tickers.map(t => [t, this.dataManager.storage.getCurrentPrice(t)]));

    const result = await this.dataManager.buildTodaySnapshot(assetPurchases, cashPurchases, livePriceSnapshot);
    return {
      snapshotId: result.portfolioSnapshot.snapshotId,
      generatedAt: result.portfolioSnapshot.generatedAt,
      prices: result.todayGraphData?.resolvedPrices || null,
      fx: result.historicalFxMap || null,
      portfolioSnapshot: result.portfolioSnapshot,
      dataQuality: result.todayGraphData?.dataQuality || { valid: result.portfolioSnapshot.status === 'valid', reason: result.portfolioSnapshot.invalidReason, failedInstruments: result.portfolioSnapshot.invalidInstruments || [] },
      // Champs internes — nécessaires aux consommateurs existants (le
      // graphique) qui ont besoin de plus que le PortfolioSnapshot canonique
      // (ex: todayGraphData pour tracer la courbe elle-même).
      _engine: result
    };
  }
}
