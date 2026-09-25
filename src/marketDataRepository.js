// Cache orchestration only. DataManager remains the financial engine.
import { marketDataMetrics } from './marketDataMetrics.js';

const VERSION = 2;
const FRESH_TTL_MS = 30_000;
const RETRY_MS = 30_000;
const encode = (_, value) => value instanceof Map ? { $marketMap: [...value] } : value;
const decode = (_, value) => value?.$marketMap ? new Map(value.$marketMap) : value;
const copy = value => JSON.parse(JSON.stringify(value, encode), decode);
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
function signature(assets, cash) {
  const rows = values => values.map(p => JSON.stringify(canonical(p))).sort();
  return JSON.stringify([rows(assets), rows(cash)]);
}
function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }
function superseded() { return Object.assign(new Error('Snapshot superseded'), { name: 'AbortError' }); }

export class MarketDataRepository {
  constructor(dataManager) {
    this.dataManager = dataManager;
    this._memory = null;
    this._inFlight = null;
    this._generation = 0;
    this._listeners = new Set();
    this._scope = undefined;
    this._remoteLoad = null;
  }

  _ensureScope() {
    const sync = this.dataManager.storage.marketDataSync;
    const uid = sync ? (sync.auth ? sync.auth.currentUser?.uid : sync.userId) || 'anonymous' : 'local';
    if (uid === this._scope) return;
    this._scope = uid;
    this._remoteLoad = null;
    this._generation++;
    this._inFlight = null;
    this._memory = null;
    this._key = `marketDataRepository_snapshot_v${VERSION}:${uid}`;
    try {
      const value = JSON.parse(localStorage.getItem(this._key), decode);
      if (value?.schemaVersion === VERSION && value.userId === uid &&
          value.snapshot?.portfolioSnapshot?.status === 'valid' &&
          value.snapshot?._engine?.historicalFxMap instanceof Map &&
          value.snapshot?._engine?.todayGraphData?.resolvedPrices instanceof Map &&
          Number.isFinite(value.computedAt) && value.computedAt <= Date.now()) this._memory = value;
    } catch { /* Corrupt or incompatible cache is a miss. */ }
  }

  _persist() {
    try {
      if (this._scope !== 'anonymous' && this._memory?.snapshot.portfolioSnapshot.status === 'valid')
        localStorage.setItem(this._key, JSON.stringify(this._memory, encode));
    } catch { /* Memory cache remains available on quota/storage failure. */ }
  }

  subscribe(listener) { this._listeners.add(listener); return () => this._listeners.delete(listener); }
  _result(fromCache = true) {
    const entry = this._memory;
    return { snapshot: entry.snapshot, fromCache,
      previousSession: !sameDay(entry.computedAt, Date.now()),
      stale: !sameDay(entry.computedAt, Date.now()) || Date.now() - entry.computedAt >= FRESH_TTL_MS || !!entry.degraded,
      degraded: !!entry.degraded, lastRefreshFailure: entry.lastRefreshFailure };
  }
  _publish(background) {
    const result = { ...this._result(false), background };
    for (const listener of this._listeners) {
      try { listener(result); } catch (error) { console.warn('[Snapshot subscriber]', error); }
    }
  }

  invalidate(reason = 'manual') {
    this._ensureScope();
    this._generation++;
    this._inFlight = null;
    this._memory = null;
    try { localStorage.removeItem(this._key); } catch { /* best effort */ }
  }

  async getPrice(ticker, options = {}) {
    await this.dataManager.api.fetchBatchPrices([ticker], !!options.forceRefresh);
    const price = this.dataManager.storage.getCurrentPrice(ticker);
    if (!price) return null;
    return { ...price, degraded: !!this.dataManager.api.liveFailures?.has(ticker.toUpperCase()) };
  }
  getHistorical(ticker, start, end, interval) {
    return this.dataManager.api.getHistoricalPricesWithRetry(ticker, start, end, interval);
  }
  refresh(assets, cash = []) { return this.getSnapshot(assets, cash, { forceRefresh: true }); }

  async getSnapshot(assets, cash = [], { forceRefresh = false, revalidate = true } = {}) {
    this._ensureScope();
    const key = signature(assets, cash);
    const scope = this._scope;
    if (!this._memory && this.dataManager.storage.marketDataSync?.loadCanonicalSnapshot) {
      if (!this._remoteLoad) {
        let timer;
        const read = this.dataManager.storage.marketDataSync.loadCanonicalSnapshot();
        this._remoteLoad = Promise.race([read, new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })])
          .then(raw => {
            this._ensureScope();
            if (scope !== this._scope || this._memory || !raw) return;
            const parsed = JSON.parse(raw, decode);
            if (parsed.schemaVersion === VERSION && parsed.userId === scope && parsed.snapshot?.portfolioSnapshot.status === 'valid' &&
                parsed.snapshot?._engine?.historicalFxMap instanceof Map && parsed.snapshot?._engine?.todayGraphData?.resolvedPrices instanceof Map &&
                Number.isFinite(parsed.computedAt) && parsed.computedAt <= Date.now()) this._memory = parsed;
          }).catch(() => {}).finally(() => clearTimeout(timer));
      }
      await this._remoteLoad;
      this._ensureScope();
      if (scope !== this._scope) throw superseded();
    }
    const now = Date.now();
    // A previous day's day-P&L must never be labelled as today's result.
    // A previous session remains visible as a dated snapshot; consumers hide today's P&L.
    const usable = this._memory?.purchasesSignature === key &&
      this._memory.fxRate === (this.dataManager.storage.getConversionRate?.('USD_TO_EUR') ?? null);
    if (!forceRefresh && usable) {
      marketDataMetrics.recordSnapshotCacheHit();
      const result = this._result();
      if (revalidate && result.stale && now >= (this._memory.retryAt || 0))
        this._refresh(assets, cash, key, true, false).catch(() => {});
      return result;
    }
    marketDataMetrics.recordSnapshotCacheMiss();
    const snapshot = await this._refresh(assets, cash, key, false, forceRefresh);
    if (this._memory?.snapshot !== snapshot || this._memory.purchasesSignature !== key) throw superseded();
    return this._result(false);
  }

  _refresh(assets, cash, key, background, forceLive = false) {
    if (this._inFlight?.signature === key) {
      marketDataMetrics.recordDedup();
      return this._inFlight.promise;
    }
    const generation = ++this._generation;
    const scope = this._scope;
    const current = () => {
      this._ensureScope();
      return generation === this._generation && scope === this._scope;
    };
    if (background) marketDataMetrics.recordBackgroundRefresh();
    // Freeze ledger inputs before any await; edits during refresh cannot mix revisions.
    const assetInput = copy(assets);
    const cashInput = copy(cash);
    const compute = async () => {
      if (!current()) throw superseded();
      if (!globalThis.navigator?.locks) return this._computeSnapshot(assetInput, cashInput, forceLive);
      try {
        const shared = JSON.parse(localStorage.getItem(this._key), decode);
        if (shared?.schemaVersion === VERSION && shared.userId === scope && shared.purchasesSignature === key &&
            shared.snapshot?.portfolioSnapshot?.status === 'valid' &&
            shared.snapshot?._engine?.historicalFxMap instanceof Map &&
            shared.snapshot?._engine?.todayGraphData?.resolvedPrices instanceof Map &&
            shared.fxRate === (this.dataManager.storage.getConversionRate?.('USD_TO_EUR') ?? null) &&
            shared.computedAt > (this._memory?.computedAt || 0) && Date.now() - shared.computedAt < FRESH_TTL_MS &&
            sameDay(shared.computedAt,Date.now())) return shared.snapshot;
      } catch { /* Other tabs may not support persistent storage. */ }
      return this._computeSnapshot(assetInput, cashInput, forceLive);
    };
    const run = () => compute()
      .then(snapshot => {
        if (!current()) throw superseded();
        const valid = snapshot.portfolioSnapshot.status === 'valid';
        const previous = this._memory;
        if (!valid && previous?.purchasesSignature === key && previous.snapshot.portfolioSnapshot.status === 'valid') {
          this._memory = { ...previous, degraded: true, retryAt: Date.now() + RETRY_MS,
            lastRefreshFailure: snapshot.portfolioSnapshot.invalidReason || 'PRICE_DATA_UNAVAILABLE' };
        } else {
          this._memory = { schemaVersion: VERSION, engineVersion: 1, userId: scope,
            snapshot, computedAt: snapshot.generatedAt, purchasesSignature: key, degraded: !valid,
            fxRate: snapshot._engine?.dynamicRate ?? this.dataManager.storage.getConversionRate?.('USD_TO_EUR') ?? null,
            retryAt: valid ? 0 : Date.now() + RETRY_MS,
            lastRefreshFailure: valid ? null : snapshot.portfolioSnapshot.invalidReason };
        }
        this._persist();
        if (valid) {
          const sync = this.dataManager.storage.marketDataSync;
          void sync?.saveCanonicalSnapshot?.(JSON.parse(JSON.stringify(this._memory, encode)))?.catch(error => console.warn('[Snapshot replication]', error));
        }
        this._publish(background);
        return this._memory.snapshot;
      }).catch(error => {
        if (!current()) throw superseded();
        if (this._memory?.purchasesSignature === key && this._memory.snapshot.portfolioSnapshot.status === 'valid') {
          this._memory = { ...this._memory, degraded: true, retryAt: Date.now() + RETRY_MS, lastRefreshFailure: error.message };
          this._persist();
          this._publish(background);
          return this._memory.snapshot;
        }
        throw error;
      });
    const operation = globalThis.navigator?.locks
      ? navigator.locks.request(`asset-tracker:snapshot:${scope}`, run)
      : run();
    const promise = operation.finally(() => {
        if (this._inFlight?.promise === promise) this._inFlight = null;
      });
    this._inFlight = { signature: key, promise };
    return promise;
  }

  async _computeSnapshot(assetPurchases, cashPurchases, forceLive = false) {
    const tickers = [...new Set((assetPurchases || []).map(p => p.ticker.toUpperCase()))];
    if (assetPurchases.some(p => p.currency === 'USD')) await this.dataManager.api.ensureConversionRate?.();
    if (tickers.length > 0) {
      await this.dataManager.api.fetchBatchPrices(tickers, forceLive);
    }
    const failures = tickers.filter(t => this.dataManager.api.liveFailures?.has(t));
    if (failures.length) throw new Error(`PRICE_DATA_UNAVAILABLE: ${failures.join(', ')}`);
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
