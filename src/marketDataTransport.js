// Shared raw provider cache. No currency conversion or financial formula here.
import { marketDataMetrics } from './marketDataMetrics.js';
const memory = new Map();
const pending = new Map();
const failures = new Map();
const MAX_ENTRIES = 200;
const MAX_RATE_LIMIT_RETRIES = 2;
let active = 0;
const waiting = [];
let rateLimitUntil = 0;
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
// A stale response is the last validated payload, served because the refresh
// failed. It keeps its real `fetchedAt` and carries that failure (`error`) so
// callers can report the degraded state instead of a fresh success.
function response(entry, stale = false, error = null) {
  return { ok: true, status: 200, fetchedAt: entry.fetchedAt, stale,
    error: stale && error ? { status: Number.isFinite(error.status) ? error.status : null, message: error.message || 'Market refresh failed' } : null,
    headers: new Headers(), json: async () => structuredClone(entry.data) };
}
function cacheable(data) {
  if (Number.isFinite(data?.rates?.EUR) && data.rates.EUR > 0) return true;
  return !data?.chart?.error && data?.chart?.result?.some(result =>
    Number.isFinite(result.meta?.regularMarketPrice) && result.meta.regularMarketPrice > 0 ||
    result.indicators?.quote?.[0]?.close?.some(price => Number.isFinite(price) && price > 0));
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForRateLimitWindow() {
  const remaining = rateLimitUntil - Date.now();
  if (remaining > 0) await wait(remaining);
}
function rateLimitDelay(response) {
  const retryAfter = Number(response?.headers?.get?.('Retry-After'));
  // Automatic waiting is an explicit Worker/client contract. Older Workers
  // without Retry-After keep the former immediate-failure behaviour instead
  // of making the browser guess an arbitrary minute-long delay.
  return retryAfter > 0 ? (retryAfter * 1000) + 1000 : null;
}
export function clearMarketTransportCache() {
  memory.clear(); failures.clear(); rateLimitUntil = 0;
}
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
        return response(staleEntry, true, failure.error);
      }
      throw failure.error;
    }
    if (active >= 6) await new Promise(resolve => waiting.push(resolve));
    active++;
    let res;
    try {
      let rateLimitRetries = 0;
      while (true) {
        // Every request shares one cooldown. Once any URL receives 429, other
        // queued chart requests wait as well instead of immediately consuming
        // their own rejection and multiplying fallback traffic.
        await waitForRateLimitWindow();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const handle = marketDataMetrics.recordRequestStart(requestType);
        let attemptError = null;
        res = null;
        try {
          res = await fetch(url, { signal: controller.signal });
          if (!res.ok) {
            attemptError = Object.assign(new Error(`Market HTTP ${res.status}`), { status: res.status });
          }
        } catch (error) {
          attemptError = error;
        } finally {
          marketDataMetrics.recordRequestEnd(handle,
            res?.status || (attemptError?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 0), res);
          clearTimeout(timer);
        }

        if (attemptError?.status === 429) {
          const delay = rateLimitDelay(res);
          attemptError.retryAfterMs = delay || null;
          if (delay) rateLimitUntil = Math.max(rateLimitUntil, Date.now() + delay);
          if (delay && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
            rateLimitRetries++;
            console.warn(`[MarketData] Rate limit reached; retry ${rateLimitRetries}/${MAX_RATE_LIMIT_RETRIES} in ${Math.ceil(delay / 1000)}s.`);
            continue;
          }
          const failureUntil = delay ? rateLimitUntil : Date.now() + 30_000;
          failures.set(key, { error: attemptError, until: failureUntil });
        }
        if (attemptError) throw attemptError;
        break;
      }

      const data = await res.json();
      const entry = { data, fetchedAt: Date.now(), source: 'provider', requestType };
      if (cacheable(data)) {
        memory.set(key, entry);
        if (memory.size > MAX_ENTRIES) memory.delete(memory.keys().next().value);
        void disk(key, entry);
      }
      return { ok: true, status: res.status || 200, fetchedAt: entry.fetchedAt, stale: false, error: null, headers: res.headers, json: async () => structuredClone(data) };
    } catch (error) {
      // Stale-if-error for REAL provider payloads only. This is the persistent
      // cache-first path for immutable past candles: a temporary Worker/Yahoo
      // failure must not erase an already validated history. No live quote,
      // purchase price or synthetic point is introduced.
      const staleEntry = stored?.data ? stored : cached;
      if (staleEntry?.data && cacheable(staleEntry.data)) {
        memory.set(key, staleEntry);
        marketDataMetrics.recordCacheHit();
        return response(staleEntry, true, error);
      }
      throw error;
    } finally {
      active--;
      waiting.shift()?.();
    }
  })().finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
