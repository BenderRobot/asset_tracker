// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HistoricalPointStore, isDeltaFetchEligible } from '../src/historicalPointStore.js';
const DAY = 86400000;
const now = Date.parse('2026-09-24T12:00:00Z');
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());
describe('Conservative daily coverage', () => {
  it('only permits daily delta, not unfinished weekly/monthly bars', () => {
    expect(isDeltaFetchEligible('1d')).toBe(true);
    for (const interval of ['5m','1wk','1mo']) expect(isDeltaFetchEligible(interval)).toBe(false);
  });
  it('never infers coverage from first and last point', () => {
    const store = new HistoricalPointStore();
    store.merge('AAA','1d',{ [now-3*DAY]:100, [now-DAY]:102 });
    expect(store.planFetch('AAA','1d',(now-3*DAY)/1000,now/1000).plan).toBe('full');
  });
  it('rejects a weekday gap even when the provider reported success', () => {
    const store = new HistoricalPointStore();
    store.merge('AAA','1d',{ [now-3*DAY]:100, [now-DAY]:102 }, {startTs:(now-3*DAY)/1000,endTs:now/1000});
    expect(store.planFetch('AAA','1d',(now-3*DAY)/1000,now/1000).plan).toBe('full');
  });
  it('persists known coverage and revalidates the open daily tail after TTL', () => {
    const store = new HistoricalPointStore();
    const points = Object.fromEntries(Array.from({length:11},(_,i)=>[now-(10-i)*DAY,100+i]));
    store.merge('AAA','1d',points,{startTs:(now-10*DAY)/1000,endTs:now/1000});
    const restored = new HistoricalPointStore();
    expect(restored.planFetch('AAA','1d',(now-10*DAY)/1000,now/1000).plan).toBe('none');
    vi.advanceTimersByTime(16*60000);
    const delta = restored.planFetch('AAA','1d',(now-10*DAY)/1000,Date.now()/1000);
    expect(delta.plan).toBe('delta');
    expect(delta.fetchStartTs).toBe((now-3*DAY)/1000);
  });
  it('keeps currencies and intervals isolated and rejects invalid numbers', () => {
    const store = new HistoricalPointStore();
    store.merge('AAA|fx:0.9','1d',{ [now-DAY]:90 });
    store.merge('AAA|fx:0.8','1d',{ [now-DAY]:80 });
    store.merge('AAA|fx:0.9','1d',{ [now-DAY]:NaN });
    expect(store.getKnownPoints('AAA|fx:0.9','1d',0,now/1000)[now-DAY]).toBe(90);
    expect(store.getKnownPoints('AAA|fx:0.8','1d',0,now/1000)[now-DAY]).toBe(80);
  });
});
