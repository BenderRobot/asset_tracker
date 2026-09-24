import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchMarketResponse } from '../src/marketDataTransport.js';
import { marketDataMetrics } from '../src/marketDataMetrics.js';
afterEach(() => vi.unstubAllGlobals());
const url = 'https://example.test/?symbol=AAA';
const valid = { chart: { result: [{ timestamp: [1], indicators: { quote: [{ close: [100] }] } }] } };
describe('Shared provider transport', () => {
  it('coalesces a live and a chart consumer and returns independent bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => valid })));
    const [a,b] = await Promise.all([fetchMarketResponse(url, 1000, 'live-price'), fetchMarketResponse(url, 1000, 'historical')]);
    const first = await a.json(); first.chart.result[0].timestamp[0] = 999;
    expect((await b.json()).chart.result[0].timestamp[0]).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await fetchMarketResponse(url);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('backs off on 429 without turning it into a cached quote', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    await expect(fetchMarketResponse(url)).rejects.toMatchObject({ status: 429 });
    await expect(fetchMarketResponse(url)).rejects.toMatchObject({ status: 429 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('counts actual requests, excludes Binance 5xx from worker5xx', async () => {
    marketDataMetrics.reset();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502 })));
    await expect(fetchMarketResponse(url, 1000, 'binance')).rejects.toThrow();
    expect(marketDataMetrics.snapshot()).toMatchObject({ networkRequests: 1, worker5xx: 0 });
  });
});
