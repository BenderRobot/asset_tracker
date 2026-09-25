// Shared raw provider cache. No currency conversion or financial formula here.
import { marketDataMetrics } from './marketDataMetrics.js';
const memory = new Map();
const pending = new Map();
const failures = new Map();
const MAX_ENTRIES = 200;
let active = 0;
const waiting = [];
let database;
function db() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return database ||= new Promise(resolve => {
    let request;
    try { request = indexedDB.open('asset-tracker-market-v2', 1); } catch { resolve(null); return; }
    request.onupgradeneeded = () => request.result.createObjectStore('responses');
    request.onsuccess = () => resolve(request.result);
    request.onerror = request.onblocked = () => resolve(null);
  });
}
async function disk(key, value) {
  let timer;
  const connection = await Promise.race([db(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
  clearTimeout(timer);
  if (!connection) return null;
  return new Promise(resolve => {
    try {
      const transaction = connection.transaction('responses', value ? 'readwrite' : 'readonly');
      transaction.onabort = transaction.onerror = () => resolve(null);
      const store = transaction.objectStore('responses');
      const request = value ? store.put(value, key) : store.get(key);
      request.onsuccess = () => resolve(value || request.result);
      request.onerror = () => resolve(null);
      if (value) {
        // Bound persistent storage, even when windows/tickers change every day.
        const count = store.count();
        count.onsuccess = () => {
          let excess = count.result - MAX_ENTRIES;
          if (excess <= 0) return;
          const cursor = store.openCursor();
          cursor.onsuccess = () => {
            if (cursor.result && excess-- > 0) { cursor.result.delete(); cursor.result.continue(); }
          };
        };
      }
    } catch { resolve(null); }
  });
}
function response(entry, stale = false) {
  return { ok: true, status: 200, fetchedAt: entry.fetchedAt, stale, headers: new Headers(), json: async () => structuredClone(entry.data) };
}
function cacheable(data) {
  if (Number.isFinite(data?.rates?.EUR) && data.rates.EUR > 0) return true;
  return !data?.chart?.error && data?.chart?.result?.some(result =>
    Number.isFinite(result.meta?.regularMarketPrice) && result.meta.regularMarketPrice > 0 ||
    result.indicators?.quote?.[0]?.close?.some(price => Number.isFinite(price) && price > 0));
}
export function clearMarketTransportCache() { memory.clear(); failures.clear(); }
export async function fetchMarketResponse(url, timeoutMs = 10000, requestType = 'historical', ttl = 60000) {
  const key = String(url);
  const now = Date.now();
  const cached = memory.get(key);
  if (cached && now - cached.fetchedAt < ttl) { marketDataMetrics.recordCacheHit(); return response(cached); }
  if (pending.has(key)) { marketDataMetrics.recordDedup(); return pending.get(key); }
  const promise = (async () => {
    const stored = await disk(key);
    if (stored?.data && Date.now() - stored.fetchedAt < ttl) {
      memory.set(key, stored); marketDataMetrics.recordCacheHit(); return response(stored);
    }
    const failure = failures.get(key);
    if (failure && Date.now() < failure.until) {
      const staleEntry = stored?.data ? stored : cached;
      if (staleEntry?.data && cacheable(staleEntry.data)) {
        marketDataMetrics.recordCacheHit();
        return response(staleEntry, true);
      }
      throw failure.error;
    }
    if (active >= 6) await new Promise(resolve => waiting.push(resolve));
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const handle = marketDataMetrics.recordRequestStart(requestType);
    let res;
    let failedStatus;
    try {
      res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const error = Object.assign(new Error(`Market HTTP ${res.status}`), { status: res.status });
        const retry = Number(res.headers?.get?.('Retry-After'));
        if (res.status === 429) {
          const delay = Math.max(30000, Number.isFinite(retry) ? retry * 1000 : 0);
          failures.set(key, { error, until: Date.now() + delay });
        }
        throw error;
      }
      const data = await res.json();
      const entry = { data, fetchedAt: Date.now(), source: 'provider', requestType };
      if (cacheable(data)) {
        memory.set(key, entry);
        if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
        void disk(key, entry);
      }
      return { ok: true, status: res.status || 200, fetchedAt: entry.fetchedAt, headers: res.headers, json: async () => structuredClone(data) };
    } catch (error) {
      failedStatus = error.name === 'AbortError' ? 'timeout' : 0;
      // Stale-if-error for REAL provider payloads only. This is the persistent
      // cache-first path for immutable past candles: a temporary Worker/Yahoo
      // failure must not erase an already validated history. No live quote,
      // purchase price or synthetic point is introduced.
      const staleEntry = stored?.data ? stored : cached;
      if (staleEntry?.data && cacheable(staleEntry.data)) {
        memory.set(key, staleEntry);
        marketDataMetrics.recordCacheHit();
        return response(staleEntry, true);
      }
      throw error;
    } finally {
      marketDataMetrics.recordRequestEnd(handle, res?.status || failedStatus || (controller.signal.aborted ? 'timeout' : 0), res);
      clearTimeout(timer);
      active--;
      waiting.shift()?.();
    }
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
