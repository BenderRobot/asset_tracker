// VALIDATION ARCHITECTURE (2026-09-24) — MarketDataRepository.
//
// Teste la couche d'orchestration/cache en ISOLATION du moteur financier
// (dataManager est un double contrôlable ici) : ce fichier vérifie le
// contrat cache-first / stale-while-revalidate / coalescing / fail-closed du
// Repository lui-même, pas les formules financières (déjà verrouillées par
// failClosedPriceData.test.js, financialFallbackIntegrity.test.js,
// historicalFetchDeduplication.test.js — HistoryCalculator reste l'unique
// producteur des métriques, inchangé par ce module).
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketDataRepository } from '../src/marketDataRepository.js';
import { marketDataMetrics } from '../src/marketDataMetrics.js';
import { purchase } from './helpers.js';

function validSnapshot(totalValue) {
    const id = `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return {
        snapshotStartedAt: Date.now(),
        historicalFxMap: new Map(),
        todayGraphData: { resolvedPrices: new Map(), dataQuality: { valid: true, reason: null, failedInstruments: [] } },
        holdings: [],
        summary: {},
        cashReserve: { total: 0 },
        portfolioSnapshot: {
            snapshotId: id,
            generatedAt: Date.now(),
            status: 'valid',
            invalidReason: null,
            invalidInstruments: [],
            totalValue
        }
    };
}

function invalidSnapshot(reason = 'PRICE_DATA_UNAVAILABLE', failedTickers = ['AAPL']) {
    return {
        snapshotStartedAt: Date.now(),
        historicalFxMap: new Map(),
        todayGraphData: { resolvedPrices: new Map(), dataQuality: { valid: false, reason, failedInstruments: failedTickers } },
        holdings: [],
        summary: {},
        cashReserve: { total: 0 },
        portfolioSnapshot: {
            snapshotId: `snap-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            generatedAt: Date.now(),
            status: 'invalid',
            invalidReason: reason,
            invalidInstruments: failedTickers,
            totalValue: null
        }
    };
}

function fakeDataManager(impl) {
    return {
        buildTodaySnapshot: vi.fn(impl),
        api: { fetchBatchPrices: vi.fn(async () => true) },
        storage: { getCurrentPrice: vi.fn(() => ({ price: 100, previousClose: 99, currency: 'EUR' })) }
    };
}

beforeEach(() => {
    marketDataMetrics.reset();
    localStorage.clear();
});
afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
});

describe('MarketDataRepository — coalescing (3 chemins d\'init concurrents)', () => {
    it('3 demandes simultanées pour le MÊME portefeuille (cache froid) -> 1 seule opération, tous reçoivent le même snapshot (KPI/table/chart cohérents)', async () => {
        let resolveFn;
        const pending = new Promise(r => { resolveFn = r; });
        const dm = fakeDataManager(async () => { await pending; return validSnapshot(1000); });
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        const p1 = repo.getSnapshot(purchases); // simule refreshDataInBackground()
        const p2 = repo.getSnapshot(purchases); // simule loadPortfolioData()
        const p3 = repo.getSnapshot(purchases); // simule initHistoricalChart()
        resolveFn();
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(1);
        expect(r1.snapshot.snapshotId).toBe(r2.snapshot.snapshotId);
        expect(r2.snapshot.snapshotId).toBe(r3.snapshot.snapshotId);
    });
});

describe('MarketDataRepository — cache-first', () => {
    it('cache valide (< TTL frais) -> 0 nouvel appel au moteur, rendu immédiat depuis le cache', async () => {
        const dm = fakeDataManager(async () => validSnapshot(1000));
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        await repo.getSnapshot(purchases);
        const second = await repo.getSnapshot(purchases);

        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(1);
        expect(second.fromCache).toBe(true);
        expect(second.stale).toBe(false);
    });

    it('cache stale (> TTL frais, même jour) -> rendu IMMÉDIAT avec l\'ancien snapshot, refresh lancé en tâche de fond sans bloquer', async () => {
        let calls = 0;
        const dm = fakeDataManager(async () => { calls++; return validSnapshot(1000 + calls); });
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        const first = await repo.getSnapshot(purchases);
        expect(calls).toBe(1);

        repo._memory.computedAt = Date.now() - 60 * 1000; // périmé (TTL frais = 30s)

        const second = await repo.getSnapshot(purchases);
        expect(second.fromCache).toBe(true);
        expect(second.stale).toBe(true);
        // L'ANCIEN est rendu immédiatement, jamais le résultat du refresh en cours.
        expect(second.snapshot.portfolioSnapshot.totalValue).toBe(first.snapshot.portfolioSnapshot.totalValue);

        await new Promise(r => setTimeout(r, 0)); // laisse le refresh background se résoudre
        expect(calls).toBe(2);
    });

    it('aucun cache -> fetch initial attendu (bloquant), résultat retourné directement', async () => {
        const dm = fakeDataManager(async () => validSnapshot(500));
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        const result = await repo.getSnapshot(purchases);
        expect(result.fromCache).toBe(false);
        expect(result.snapshot.portfolioSnapshot.totalValue).toBe(500);
    });
});

describe('MarketDataRepository — règle financière critique (fail-closed)', () => {
    it('un refresh BACKGROUND qui revient invalide ne dégrade jamais un snapshot déjà valide : l\'ancien reste servi, marqué degraded', async () => {
        let calls = 0;
        const dm = fakeDataManager(async () => {
            calls++;
            return calls === 1 ? validSnapshot(1000) : invalidSnapshot('PRICE_DATA_UNAVAILABLE', ['AAPL']);
        });
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        await repo.getSnapshot(purchases);
        repo._memory.computedAt = Date.now() - 60 * 1000; // déclenche le refresh background au prochain appel

        const duringRefresh = await repo.getSnapshot(purchases);
        expect(duringRefresh.snapshot.portfolioSnapshot.status).toBe('valid');
        expect(duringRefresh.snapshot.portfolioSnapshot.totalValue).toBe(1000);

        await new Promise(r => setTimeout(r, 0)); // le refresh raté se termine

        const afterFailedRefresh = await repo.getSnapshot(purchases);
        expect(afterFailedRefresh.snapshot.portfolioSnapshot.status).toBe('valid');
        expect(afterFailedRefresh.snapshot.portfolioSnapshot.totalValue).toBe(1000); // toujours l'ancien
        expect(afterFailedRefresh.degraded).toBe(true); // mais signalé dégradé
    });

    it('aucun cache existant + le premier calcul revient invalide -> snapshot invalide propagé tel quel (priceDataUnavailable), jamais un throw ni une valeur fabriquée', async () => {
        const dm = fakeDataManager(async () => invalidSnapshot('PRICE_DATA_UNAVAILABLE', ['AAPL']));
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        const result = await repo.getSnapshot(purchases);
        expect(result.snapshot.portfolioSnapshot.status).toBe('invalid');
        expect(result.snapshot.portfolioSnapshot.totalValue).toBeNull();
        expect(result.snapshot.portfolioSnapshot.invalidInstruments).toContain('AAPL');
    });
});

describe('MarketDataRepository — invalidation', () => {
    it('invalidate() explicite force un vrai recalcul au prochain getSnapshot(), même si le cache était encore frais', async () => {
        let calls = 0;
        const dm = fakeDataManager(async () => { calls++; return validSnapshot(1000); });
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        await repo.getSnapshot(purchases);
        expect(calls).toBe(1);

        repo.invalidate('test');
        await repo.getSnapshot(purchases);
        expect(calls).toBe(2);
    });

    it('changement de portefeuille (signature différente) -> jamais l\'ancien snapshot d\'un autre portefeuille, toujours un recalcul', async () => {
        let calls = 0;
        const dm = fakeDataManager(async () => { calls++; return validSnapshot(1000 * calls); });
        const repo = new MarketDataRepository(dm);

        const purchasesA = [purchase({ ticker: 'AAPL', quantity: 5 })];
        const purchasesB = [purchase({ ticker: 'MSFT', quantity: 3 })];

        const r1 = await repo.getSnapshot(purchasesA);
        const r2 = await repo.getSnapshot(purchasesB);

        expect(calls).toBe(2);
        expect(r1.snapshot.portfolioSnapshot.totalValue).not.toBe(r2.snapshot.portfolioSnapshot.totalValue);
    });

    it('changement de jour calendaire depuis le dernier calcul -> invalidation implicite (renouvellement de la clôture veille), même dans la fenêtre TTL fraîche', async () => {
        let calls = 0;
        const dm = fakeDataManager(async () => { calls++; return validSnapshot(1000); });
        const repo = new MarketDataRepository(dm);
        const purchases = [purchase({ ticker: 'AAPL' })];

        await repo.getSnapshot(purchases);
        expect(calls).toBe(1);

        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        repo._memory.computedAt = yesterday.getTime(); // "il y a quelques secondes hier"

        const previousSession = await repo.getSnapshot(purchases);
        expect(previousSession.previousSession).toBe(true);
        expect(previousSession.stale).toBe(true);
        await repo._inFlight?.promise;
        expect(calls).toBe(2); // recalculé malgré un âge < TTL frais, à cause du changement de jour
    });
});


it('explicit refresh bypasses live cache while SWR refresh keeps the live TTL', async () => {
    const dm = fakeDataManager(async () => validSnapshot(1000));
    const repo = new MarketDataRepository(dm);
    const purchases = [purchase({ ticker: 'AAPL' })];

    await repo.getSnapshot(purchases);
    await repo.refresh(purchases);

    expect(dm.api.fetchBatchPrices).toHaveBeenNthCalledWith(1, ['AAPL'], false);
    expect(dm.api.fetchBatchPrices).toHaveBeenNthCalledWith(2, ['AAPL'], true);

    repo._memory.computedAt = Date.now() - 60 * 1000;
    await repo.getSnapshot(purchases);
    await repo._inFlight?.promise;
    expect(dm.api.fetchBatchPrices).toHaveBeenNthCalledWith(3, ['AAPL'], false);
});

describe('Snapshot persistence and invalidation boundaries', () => {
    it('restores all Maps after a reload without recalculating', async () => {
        const dm = fakeDataManager(() => validSnapshot(100));
        const ledger = [purchase({ ticker: 'AAA' })];
        const original = await new MarketDataRepository(dm).getSnapshot(ledger);
        const restored = await new MarketDataRepository(dm).getSnapshot(ledger);
        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(1);
        expect(restored.snapshot._engine.historicalFxMap).toBeInstanceOf(Map);
        expect(restored.snapshot.prices).toBeInstanceOf(Map);
        expect(restored.snapshot.snapshotId).toBe(original.snapshot.snapshotId);
    });
    it('invalidates currency and transaction type edits', async () => {
        const dm = fakeDataManager(() => validSnapshot(100));
        const repo = new MarketDataRepository(dm);
        const row = purchase({ ticker: 'AAA', currency: 'EUR' });
        await repo.getSnapshot([row]);
        await repo.getSnapshot([{ ...row, currency: 'USD' }]);
        await repo.getSnapshot([{ ...row, currency: 'USD', type: 'dividend' }]);
        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(3);
    });
    it('does not publish or persist a result completed after invalidate', async () => {
        let resolve;
        const dm = fakeDataManager(() => new Promise(r => { resolve = r; }));
        const repo = new MarketDataRepository(dm);
        const listener = vi.fn();
        repo.subscribe(listener);
        const pending = repo.getSnapshot([purchase({ ticker: 'AAA' })]);
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await Promise.resolve();
        repo.invalidate();
        resolve(validSnapshot(100));
        await rejected;
        expect(listener).not.toHaveBeenCalled();
        expect(repo._memory).toBeNull();
    });
    it('isolates persisted snapshots by authenticated user', async () => {
        const dm = fakeDataManager(() => validSnapshot(100));
        dm.storage.marketDataSync = { auth: { currentUser: { uid: 'alice' } } };
        const repo = new MarketDataRepository(dm);
        const rows = [purchase({ ticker: 'AAA' })];
        await repo.getSnapshot(rows);
        dm.storage.marketDataSync.auth.currentUser = { uid: 'bob' };
        await repo.getSnapshot(rows);
        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(2);
        expect(repo._memory.userId).toBe('bob');
    });
    it('notifies subscribers when stale data is replaced in the background', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
            const dm = fakeDataManager(() => validSnapshot(100));
            const repo = new MarketDataRepository(dm);
            const rows = [purchase({ ticker: 'AAA' })];
            await repo.getSnapshot(rows);
            const listener = vi.fn();
            repo.subscribe(listener);
            vi.advanceTimersByTime(31000);
            const stale = await repo.getSnapshot(rows);
            expect(stale.stale).toBe(true);
            await repo._inFlight?.promise;
            expect(listener).toHaveBeenCalledWith(expect.objectContaining({ background: true, stale: false }));
        } finally { vi.useRealTimers(); }
    });
});


it('keeps the last valid snapshot unchanged and dated after a live-price refresh failure', async () => {
    const dm = fakeDataManager(() => validSnapshot(100));
    dm.api.liveFailures = new Map();
    const repo = new MarketDataRepository(dm);
    const rows = [purchase({ticker:'AAA'})];
    const good = await repo.getSnapshot(rows);
    dm.api.liveFailures.set('AAA',{reason:'HTTP 429'});
    const failed = await repo.refresh(rows);
    expect(failed.snapshot.snapshotId).toBe(good.snapshot.snapshotId);
    expect(failed.snapshot.generatedAt).toBe(good.snapshot.generatedAt);
    expect(failed.degraded).toBe(true);
    expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(1);
});

it('holds the tab lock through publication and shares the result with a second repository', async () => {
    let tail = Promise.resolve();
    const locks = { request: vi.fn((_key, task) => {
        const result = tail.then(task);
        tail = result.catch(() => {});
        return result;
    }) };
    Object.defineProperty(navigator,'locks',{value:locks,configurable:true});
    try {
        const dm = fakeDataManager(() => validSnapshot(100));
        const rows = [purchase({ticker:'AAA'})];
        const a = new MarketDataRepository(dm), b = new MarketDataRepository(dm);
        const [first,second] = await Promise.all([a.getSnapshot(rows),b.getSnapshot(rows)]);
        expect(dm.buildTodaySnapshot).toHaveBeenCalledTimes(1);
        expect(first.snapshot.snapshotId).toBe(second.snapshot.snapshotId);
        expect(first.snapshot.generatedAt).toBe(second.snapshot.generatedAt);
    } finally { delete navigator.locks; }
});
