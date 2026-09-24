// Conservative daily coverage cache. Weekly/monthly open bars are not immutable.
const STORAGE_KEY = 'historicalPointStore_v2';
const DAY = 86400000;
const MAX_BUCKETS = 80;
export const isDeltaFetchEligible = interval => interval === '1d';
const keyFor = (ticker, interval) => `${ticker.toUpperCase()}|${interval}`;
export class HistoricalPointStore {
  constructor() {
    try { this._buckets = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; }
    catch { this._buckets = {}; }
  }
  _persist() {
    const keys = Object.keys(this._buckets).sort((a,b) => this._buckets[b].fetchedAt - this._buckets[a].fetchedAt);
    keys.slice(MAX_BUCKETS).forEach(key => delete this._buckets[key]);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._buckets)); } catch { /* memory only */ }
  }
  planFetch(ticker, interval, startTs, endTs, now = Date.now()) {
    const full = { plan: 'full', fetchStartTs: startTs, fetchEndTs: endTs };
    if (!isDeltaFetchEligible(interval)) return full;
    const bucket = this._buckets[keyFor(ticker, interval)];
    // Only a successfully validated network range can establish coverage.
    if (!bucket?.coverage || now - (bucket.validatedAt || bucket.fetchedAt) > 7 * DAY) return full;
    const { startTs: knownStart, endTs: knownEnd } = bucket.coverage;
    if (knownStart > startTs) return full;
    const points = Object.keys(bucket.points).map(Number).sort((a,b)=>a-b);
    if (!points.length) return full;
    // Do not infer completeness from first/last points. Missing weekdays force
    // a full revalidation; this is conservative for exchange holidays.
    const crypto = /-(EUR|USD)|BTC|ETH/.test(ticker);
    for (let i = 1; i < points.length; i++) {
      for (let ts = points[i-1] + DAY; ts < points[i] - 3600000; ts += DAY) {
        const day = new Date(ts).getUTCDay();
        if (crypto || (day !== 0 && day !== 6)) return full;
      }
    }
    const mutable = endTs * 1000 > now - DAY;
    const ttl = mutable ? 15 * 60000 : 7 * DAY;
    if (knownEnd >= endTs && now - bucket.fetchedAt < ttl) return { plan: 'none' };
    // Re-fetch the last three days as well: late bars/corrections must replace
    // previous points, never append a single provisional daily candle forever.
    const from = Math.max(startTs, Math.min(knownEnd, points.at(-1) / 1000) - 3 * DAY / 1000);
    return { plan: from > startTs ? 'delta' : 'full', fetchStartTs: from, fetchEndTs: endTs };
  }
  getKnownPoints(ticker, interval, startTs, endTs) {
    const points = this._buckets[keyFor(ticker,interval)]?.points || {};
    return Object.fromEntries(Object.entries(points).filter(([ts]) => Number(ts) >= startTs*1000 && Number(ts) <= endTs*1000));
  }
  merge(ticker, interval, points, coverage = null) {
    if (!isDeltaFetchEligible(interval) || !points || !Object.keys(points).length) return;
    if (Object.values(points).some(price => !Number.isFinite(price) || price <= 0)) return;
    const key = keyFor(ticker,interval);
    const old = this._buckets[key];
    const combined = { ...(old?.points || {}) };
    // Replace the fetched range, including removed/corrected points.
    if (coverage) for (const ts of Object.keys(combined)) {
      if (Number(ts) >= coverage.startTs*1000 && Number(ts) <= coverage.endTs*1000) delete combined[ts];
    }
    Object.assign(combined, points);
    const contiguous = old?.coverage && coverage && coverage.startTs <= old.coverage.endTs && coverage.endTs >= old.coverage.startTs;
    const coversOld = !old?.coverage || (coverage && coverage.startTs <= old.coverage.startTs && coverage.endTs >= old.coverage.endTs);
    this._buckets[key] = { points: combined, fetchedAt: Date.now(),
      validatedAt: coversOld ? Date.now() : (old.validatedAt || old.fetchedAt), source: 'Yahoo',
      coverage: contiguous ? { startTs: Math.min(old.coverage.startTs,coverage.startTs), endTs: Math.max(old.coverage.endTs,coverage.endTs) } : coverage };
    this._persist();
  }
}
export const historicalPointStore = new HistoricalPointStore();
