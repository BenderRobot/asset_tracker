// Tests du VRAI code du Worker Prices (cloudflare-workers/prices-worker/worker.js).
// BUG FOUND (audit sécurité, P1) : aucune validation du format de `symbol`,
// aucune limite de débit, et les erreurs upstream (texte brut Yahoo) étaient
// renvoyées telles quelles au client. Ces tests prouvent le nouveau
// comportement contre le VRAI module, `fetch` global étant stubé pour éviter
// tout appel réseau réel vers Yahoo.
import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../cloudflare-workers/prices-worker/worker.js';

function fakeKV() {
    const store = new Map();
    return {
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async put(key, value) { store.set(key, value); }
    };
}

function makeEnv(overrides = {}) {
    return { RATE_LIMIT: fakeKV(), PRICE_RATE_LIMIT_PER_MINUTE: '3', ...overrides };
}

function getRequest(query, headers = {}) {
    return new Request(`https://asset-tracker-prices.example.workers.dev/?${query}`, {
        method: 'GET',
        headers: { 'Origin': 'https://asset-tracker.fr', 'CF-Connecting-IP': '203.0.113.7', ...headers }
    });
}

const CHART_URL_PREFIX = 'https://query1.finance.yahoo.com/v8/finance/chart/';

function stubFetch({ yahooOk = true } = {}) {
    return vi.stubGlobal('fetch', vi.fn(async (url) => {
        const u = String(url);
        if (u.startsWith(CHART_URL_PREFIX)) {
            if (!yahooOk) return { ok: false, status: 503, text: async () => 'internal yahoo trace leak — should never reach the client' };
            return { ok: true, json: async () => ({ chart: { result: [{ meta: { currency: 'EUR' }, timestamp: [1700000000], indicators: { quote: [{ close: [100] }] } }] } }) };
        }
        throw new Error(`Unexpected fetch to ${u}`);
    }));
}

describe('Prices Worker — validation, rate limiting, erreurs génériques (P1)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('symbol au format invalide (caractères interdits) → 400, jamais transmis à Yahoo', async () => {
        stubFetch();
        const res = await worker.fetch(getRequest('symbol=' + encodeURIComponent('<script>alert(1)</script>')), makeEnv());
        expect(res.status).toBe(400);
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it('symbol trop long → 400', async () => {
        stubFetch();
        const res = await worker.fetch(getRequest('symbol=' + 'A'.repeat(50)), makeEnv());
        expect(res.status).toBe(400);
    });

    it('symbol valide (ticker classique) → 200, transmis à Yahoo', async () => {
        stubFetch();
        const res = await worker.fetch(getRequest('symbol=AAPL'), makeEnv());
        expect(res.status).toBe(200);
    });

    it('symbol valide avec suffixe exchange / devise (SU.PA, BTC-EUR, ^GSPC, GC=F) → accepté', async () => {
        stubFetch();
        for (const symbol of ['SU.PA', 'BTC-EUR', '%5EGSPC', 'GC%3DF']) {
            const res = await worker.fetch(getRequest(`symbol=${symbol}`, {}), makeEnv());
            expect(res.status).toBe(200);
        }
    });

    it('symbol manquant → 400 (comportement déjà existant, inchangé)', async () => {
        stubFetch();
        const res = await worker.fetch(getRequest(''), makeEnv());
        expect(res.status).toBe(400);
    });

    it('dépassement de la limite de débit par IP → 429', async () => {
        stubFetch();
        const env = makeEnv({ PRICE_RATE_LIMIT_PER_MINUTE: '2' });
        const r1 = await worker.fetch(getRequest('symbol=AAPL'), env);
        const r2 = await worker.fetch(getRequest('symbol=MSFT'), env);
        const r3 = await worker.fetch(getRequest('symbol=NVDA'), env);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(429);
    });

    it('la limite de débit est isolée PAR IP', async () => {
        stubFetch();
        const env = makeEnv({ PRICE_RATE_LIMIT_PER_MINUTE: '1' });
        const r1 = await worker.fetch(getRequest('symbol=AAPL', { 'CF-Connecting-IP': '1.1.1.1' }), env);
        const r2 = await worker.fetch(getRequest('symbol=AAPL', { 'CF-Connecting-IP': '1.1.1.1' }), env);
        const r3 = await worker.fetch(getRequest('symbol=AAPL', { 'CF-Connecting-IP': '2.2.2.2' }), env);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(429);
        expect(r3.status).toBe(200);
    });

    it('une erreur upstream Yahoo ne fuit jamais son texte brut au client', async () => {
        stubFetch({ yahooOk: false });
        const res = await worker.fetch(getRequest('symbol=AAPL'), makeEnv());
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(JSON.stringify(data)).not.toMatch(/internal yahoo trace leak/);
    });

    it('sans binding KV, le Worker reste fonctionnel (fail-open documenté, pas fail-closed sur l\'infra)', async () => {
        stubFetch();
        const res = await worker.fetch(getRequest('symbol=AAPL'), { PRICE_RATE_LIMIT_PER_MINUTE: '3' }); // pas de RATE_LIMIT
        expect(res.status).toBe(200);
    });
});
