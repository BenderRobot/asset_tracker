// ========================================
// historicalPointStore.js — cache historique PAR POINT (validation
// architecture 2026-09-24), clé = ticker + intervalle. Contrairement à
// api.js::historicalPriceCache (clé = ticker+start+end+interval+swap,
// EXACTE — une fenêtre glissante comme "5 ans depuis aujourd'hui" change de
// clé à CHAQUE jour qui passe, donc retélécharge tout à chaque fois), ce
// store retient les POINTS individuels déjà connus et ne fait redemander au
// réseau que le DELTA manquant.
//
// Portée volontairement limitée aux intervalles "daily et plus longs" (1d,
// 1wk, 1mo, 3mo, 6mo, 1y) : une fois un jour de bourse CLÔTURÉ, sa bougie ne
// change plus jamais — c'est le seul cas où "déjà connu" veut dire
// "vraiment immuable" sans ambiguïté. L'intraday (5m/15m/90m, jour en cours
// toujours en mouvement) garde son comportement existant dans api.js (fetch
// complet + cache TTL court, voir cleanIntradayCache) — un delta-fetch y
// serait plus risqué pour un gain marginal.
//
// N'implémente PAS de détection de "trou au milieu" d'une plage déjà
// connue : les requêtes réelles de cette app s'étendent toujours vers
// "maintenant" depuis une date de départ fixe (jamais un intervalle
// disjoint) — un trou éventuel fait simplement retomber sur un fetch
// complet (jamais une réponse partielle silencieuse).
// ========================================

const DAILY_OR_LONGER = new Set(['1d', '1wk', '1mo', '3mo', '6mo', '1y']);
const STORAGE_KEY = 'historicalPointStore_v1';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function isDeltaFetchEligible(interval) {
  return DAILY_OR_LONGER.has(interval);
}

function storeKey(ticker, interval) {
  return `${ticker.toUpperCase()}|${interval}`;
}

export class HistoricalPointStore {
  constructor() {
    this._buckets = this._load(); // { [ticker|interval]: { points: {tsMs: price}, fetchedAt } }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  _persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._buckets));
    } catch (e) {
      // Quota dépassé / mode privé : le store reste valide en mémoire pour
      // cette session, seule la persistance inter-sessions est perdue —
      // jamais une raison de bloquer ou de fausser un calcul financier.
    }
  }

  // Un jour est "clôturé" (donc immuable) s'il se situe un jour calendaire
  // AVANT aujourd'hui (heure/fuseau du navigateur). Volontairement
  // conservateur : le point du jour même n'est JAMAIS considéré clôturé,
  // même après l'heure réelle de clôture du marché — au pire on refait un
  // fetch complet un peu plus souvent que strictement nécessaire (perte
  // d'optimisation), jamais on ne fige une bougie pas encore définitive
  // (ce qui serait un bug de correction, pas seulement de performance).
  _isClosedDay(tsMs, now = Date.now()) {
    return tsMs < now && new Date(tsMs).toDateString() !== new Date(now).toDateString();
  }

  // Détermine ce qui peut être servi depuis le store et ce qui doit encore
  // être demandé au réseau pour [startTs,endTs] (secondes, comme le reste de
  // l'API historique) à un intervalle donné.
  planFetch(ticker, interval, startTs, endTs, now = Date.now()) {
    if (!isDeltaFetchEligible(interval)) {
      return { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };
    }

    const bucket = this._buckets[storeKey(ticker, interval)];
    const knownTsMs = bucket ? Object.keys(bucket.points).map(Number).sort((a, b) => a - b) : [];
    if (knownTsMs.length === 0) {
      return { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };
    }

    const startMs = startTs * 1000;
    const endMs = endTs * 1000;

    // La couverture connue doit commencer AU NIVEAU (ou avant) le début de
    // la plage demandée pour qu'un delta soit sûr — sinon on ne sait pas ce
    // qui manque avant ce premier point connu.
    if (knownTsMs[0] > startMs + ONE_DAY_MS) {
      return { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };
    }

    // Dernier point CLÔTURÉ connu dans la plage demandée.
    let lastClosedKnown = null;
    for (const ts of knownTsMs) {
      if (ts > endMs) break;
      if (this._isClosedDay(ts, now)) lastClosedKnown = ts;
    }

    if (lastClosedKnown === null) {
      return { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };
    }

    // Le jour EN COURS (aujourd'hui) n'est jamais "clôturé" (voir
    // _isClosedDay) — inutile de le redemander à cet endpoint daily : sa
    // valeur "maintenant" vient déjà du prix LIVE ailleurs dans l'app (voir
    // dataManager.buildTodaySnapshot/alignLastPointToLiveSnapshot). Le
    // dernier jour CLÔTURÉ qu'il vaille la peine de vérifier s'arrête donc
    // au plus tard à hier, jamais à aujourd'hui — qu'il y ait ou non déjà un
    // point (potentiellement périmé) pour aujourd'hui dans le store.
    const todayStartMs = new Date(now).setHours(0, 0, 0, 0);
    const latestPossibleClosedMs = Math.min(endMs, todayStartMs - 1);

    const deltaStartMs = lastClosedKnown + ONE_DAY_MS;
    if (deltaStartMs > latestPossibleClosedMs) {
      return { plan: 'none' }; // tout ce qui est demandé ET clôturé est déjà connu
    }

    return { plan: 'delta', fetchStartTs: Math.floor(deltaStartMs / 1000), fetchEndTs: endTs };
  }

  // Points déjà connus dans [startTs,endTs] (secondes) pour ce ticker+intervalle.
  getKnownPoints(ticker, interval, startTs, endTs) {
    const bucket = this._buckets[storeKey(ticker, interval)];
    if (!bucket) return {};
    const startMs = startTs * 1000, endMs = endTs * 1000;
    const result = {};
    for (const [tsStr, price] of Object.entries(bucket.points)) {
      const ts = Number(tsStr);
      if (ts >= startMs && ts <= endMs) result[ts] = price;
    }
    return result;
  }

  // Fusionne un résultat fraîchement téléchargé (map tsMs -> prix, même
  // format que celui produit par api.js::_doFetchHistoricalPrices) dans le
  // store persistant. No-op pour les intervalles hors périmètre.
  merge(ticker, interval, freshPoints) {
    if (!isDeltaFetchEligible(interval) || !freshPoints) return;
    const key = storeKey(ticker, interval);
    if (!this._buckets[key]) this._buckets[key] = { points: {}, fetchedAt: Date.now() };
    Object.assign(this._buckets[key].points, freshPoints);
    this._buckets[key].fetchedAt = Date.now();
    this._persist();
  }
}

export const historicalPointStore = new HistoricalPointStore();
