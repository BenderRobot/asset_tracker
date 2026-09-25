# Market data cache and refresh

The Dashboard and portfolio chart call the same MarketDataRepository. A compatible
snapshot is returned immediately, with `stale`, `degraded`, `previousSession` and its
original generatedAt. Background publication notifies subscribers. An old session
is displayed as a dated portfolio; today's P&L and chart are withheld until refreshed.
DataManager/HistoryCalculator remain the financial calculators.

## Persistence and identity

Snapshots use a versioned localStorage envelope keyed by authenticated UID. Full
transaction records (including currency/type/fees), FX rate and schema define
compatibility. Maps have an explicit codec. Invalid snapshots are not persisted.
Each refresh captures ledger inputs; generations reject superseded publications.
Web Locks coordinate same-user tabs when available. Without Web Locks, in-flight
coalescence still applies within the page. Refresh failures retain the previous
valid snapshot without renewing its generatedAt, with a 30-second retry cooldown.

Firestore replicates one complete serialized envelope under
users/{uid}/cache/canonicalSnapshotV2. Cold local loads attempt one remote read
with a 1.5-second UI budget. Local hits do not wait for Firestore. Payloads larger
than 700 KB stay local. Firestore failure never invalidates the local portfolio.
Legacy marketData snapshot reads now share a document/promise. This is not a
distributed leader lease across devices; Worker caching reduces their upstream load.

Raw provider responses are cached in memory and IndexedDB (200 response limit).
Daily transformed points retain the existing financial transformation, segregated
by FX rate and ticker/interval; their bounded localStorage cache is best effort.
A missing/quota-blocked cache falls back to the network, never synthetic prices.

## Freshness

- Snapshot orchestration: 30 seconds; original timestamps survive failed refreshes.
- Live stock/crypto prices and raw quote/intraday transport responses: 60 seconds.
- Closed-market prices: existing trading-day invalidation plus 7-day maximum.
- FX reference (Frankfurter, not a live quote): 24 hours.
- Historical FX: 1-hour memory memo, 24-hour raw persistence; failures are not memoized.
- Daily mutable tail: 15 minutes; archive validation: 7 days.
- Delta daily only: explicit successful range, weekday-gap rejection, 3-day overlap.
  Empty delta is an unavailable result, not a complete historical series.
- Weekly/monthly intervals: complete requests with TTL, no speculative delta merge.

Exchange holidays with insufficient provider information conservatively cause a
full fetch. Source corrections outside the overlapping tail are picked up at archive
revalidation. FX segregation can cause a full transformed-series cache miss; raw
responses can still be reused without mixing conversion rates.

## Transport and failure semantics

One in-flight promise per exact normalized URL, at most six active browser requests.
An end bound representing now is normalized to the minute. Other historical bounds
are kept unchanged. Provider errors are not cached as prices: 429 respects a cooldown
and Retry-After seconds; 5xx uses a short failure cooldown. Historical callers stop
immediate retries for 429/5xx and share the failure marker. Timeouts use bounded retry.
An explicit repository refresh bypasses both the live-price storage TTL and the raw
memory/IndexedDB TTL, while still joining an identical request already in flight.
Worker chart requests have a bounded isolate cache and coalescence (60 seconds).
This does not guarantee coalescence across separate Cloudflare isolates. Worker
changes require deployment before they affect production.

## Diagnostics

In browser devtools: `window.__marketDataMetrics.snapshot()`.
Use `reset()` immediately before the scenario being measured. Capture after first
financial render and again after background completion.

- networkRequests/browserRequests: actual requests through the market transport.
- requestsByType: live-price, historical, index-quote, fx-history, fx-reference, binance.
- cacheHits/cacheMisses: resource cache events; snapshotCacheHits/Misses separately.
- deduplicatedRequests: joined operations, including snapshot and batch levels;
  this is not a direct count of avoided HTTP requests.
- backgroundRefreshes: actual background snapshot cycles.
- worker429/worker5xx/timeouts and averageLatency: measured transport outcomes;
  latency includes body decoding. Yahoo attempts come from Worker response headers.
- initialLoadDuration/initialRenderMs: time to first valid financial render.
- historicalCalculations/historicalCalculationMs: calls through DataManager's engine wrapper.
- initialNetworkRequests/backgroundNetworkRequests: actual requests before/after
  first render, not numbers of snapshot calculations.

These counters exclude Firebase SDK HTTP traffic, news, static assets and other
applications. Measure those separately using a browser HAR / Firebase diagnostics.
No production network reduction is asserted from mocked tests.

## Verification

`npm test -- --maxWorkers=4` covers financial invariants, fail-closed behavior,
coalescence, persistence/reload, identity changes, invalidation races and the
Dashboard snapshot flow. The fixed two-instrument Dashboard fixture uses eight
cold requests (two live, two intraday, four daily references), one historical
calculation, then zero requests and zero calculations on a warm snapshot reload.
Compare production cold/warm/stale, session change, 429/5xx and multi-tab scenarios
with the same portfolio and market time before claiming a percentage reduction.
