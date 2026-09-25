// @vitest-environment jsdom
import { it, expect, vi, beforeAll, afterEach } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { PriceAPI } from '../src/api.js';
import { createFakeStorage, purchase } from './helpers.js';
import { marketDataMetrics } from '../src/marketDataMetrics.js';
let DashboardApp;
beforeAll(async () => {
  const original = document.addEventListener.bind(document);
  const spy = vi.spyOn(document, 'addEventListener').mockImplementation((type,...args) => {
    if (type !== 'DOMContentLoaded') original(type,...args);
  });
  ({ DashboardApp } = await import('../src/dashboardApp.js'));
  spy.mockRestore();
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });
it('dashboard and chart share one computation; reload restores a snapshot with zero network calls', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  localStorage.clear();
  marketDataMetrics.reset();
  const purchases = [purchase({ticker:'FLOWAAA'}),purchase({ticker:'FLOWBBB'})];
  const storage = createFakeStorage({assetTypes:{FLOWAAA:'Stock',FLOWBBB:'Stock'},purchases,conversionRate:0.9});
  vi.stubGlobal('fetch',vi.fn(async url => {
    const query = new URL(url).searchParams;
    const start = Number(query.get('period1')) || Math.floor(Date.now()/1000)-7*86400;
    const end = Number(query.get('period2')) || Math.floor(Date.now()/1000);
    const timestamp = [];
    for(let t=start;t<=end;t+=86400) timestamp.push(t);
    return {ok:true,status:200,json:async()=>({chart:{result:[{
      meta:{currency:'EUR',regularMarketPrice:102,previousClose:100},timestamp,
      indicators:{quote:[{close:timestamp.map(()=>100)}]}
    }]}})};
  }));
  const dm = new DataManager(storage,new PriceAPI(storage));
  const app = Object.create(DashboardApp.prototype);
  Object.assign(app,{storage,dataManager:dm,ui:{updatePortfolioSummary:vi.fn()},
    renderKPIs:vi.fn(),renderAllocation:vi.fn(),showCacheBadge:vi.fn(),hideCacheBadge:vi.fn()});
  const compute = vi.spyOn(dm,'buildTodaySnapshot');
  const results = [];
  dm.repository.subscribe(result=>{results.push(result);app.renderSnapshot(result);});
  await Promise.all([app.loadPortfolioData(),dm.repository.getSnapshot(purchases,[])]);
  expect(compute).toHaveBeenCalledTimes(1);
  expect(results).toHaveLength(1);
  expect(app._latestPortfolioSnapshotId).toBe(results[0].snapshot.snapshotId);
  expect(results[0].snapshot.portfolioSnapshot.status).toBe('valid');
  expect(app.ui.updatePortfolioSummary).toHaveBeenCalledWith(
    expect.objectContaining({
      totalCurrentEUR: results[0].snapshot.portfolioSnapshot.totalValue,
      totalInvestedEUR: results[0].snapshot.portfolioSnapshot.invested,
      gainTotal: results[0].snapshot.portfolioSnapshot.totalReturn,
      totalDayChangeEUR: results[0].snapshot.portfolioSnapshot.dayPnl
    }),
    expect.any(Number),
    0,
    undefined
  );
  const cold = marketDataMetrics.snapshot();
  expect(cold.historicalCalculations).toBe(1);
  expect(cold.networkRequests).toBe(8); // 2 live + 2 intraday + 4 daily reference requests in this fixture
  const urls = fetch.mock.calls.map(([url]) => url);
  expect(new Set(urls).size).toBe(urls.length);
  marketDataMetrics.reset();
  const reloaded = new DataManager(storage,new PriceAPI(storage));
  const warm = await reloaded.repository.getSnapshot(purchases,[]);
  expect(warm.fromCache).toBe(true);
  expect(warm.snapshot.snapshotId).toBe(results[0].snapshot.snapshotId);
  expect(warm.snapshot._engine.todayGraphData.resolvedPrices).toBeInstanceOf(Map);
  expect(marketDataMetrics.snapshot()).toMatchObject({networkRequests:0,historicalCalculations:0});
});
