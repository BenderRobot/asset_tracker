// Tests du VRAI code du Worker Prices (cloudflare-workers/prices-worker/worker.js).
// BUG FOUND (audit sécurité, P1) : aucune validation du format de `symbol`,
// aucune limite de débit, et les erreurs upstream (texte brut Yahoo) étaient
// renvoyées telles quelles au client. Ces tests prouvent le nouveau
// comportement contre le VRAI module, `fetch` global étant stubé pour éviter
// tout appel réseau réel vers Yahoo.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import worker, { _resetRateLimiterStateForTests } from '../cloudflare-workers/prices-worker/worker.js';

// INCIDENT POST-MORTEM (2026-09-23) : l'ancien rate limiter consommait une
// écriture KV (`env.RATE_LIMIT.put()`) À CHAQUE requête autorisée — le plan
// gratuit Cloudflare Workers KV limite les écritures à 1000/jour PAR COMPTE,
// quota épuisé en production, exception non interceptée, 500 sur TOUTE
// requête (historique et live) pour le reste de la journée. Le rate limiter
// n'utilise plus KV du tout : API native Cloudflare Rate Limiting
// (`env.RATE_LIMITER`, voir wrangler.toml) avec repli en mémoire locale à
// l'isolate (zéro I/O, donc structurellement incapable d'échouer pour une
// raison d'infrastructure) si ce binding est absent — voir worker.js.
//
// `fakeKV()` ci-dessous n'est conservé QUE pour prouver l'invariant inverse :
// même fourni, `env.RATE_LIMIT` (KV) ne doit plus JAMAIS être appelé par ce
// code (voir test dédié plus bas).
function fakeKV() {
    const store = new Map();
    return {
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async put(key, value) { store.set(key, value); }
    };
}

// `env.RATE_LIMITER` natif — absent par défaut (makeEnv), pour exercer le
// repli en mémoire dans la majorité des tests (c'est ce chemin qui a le plus
// besoin d'un filet de tests, puisque c'est lui qui remplace l'ancien code
// KV cassé). Un test dédié plus bas vérifie explicitement le binding natif.
function fakeRateLimiter(limit) {
    const counts = new Map(); // key -> count dans la fenêtre courante (best-effort pour le test)
    return {
        async limit({ key }) {
            const n = (counts.get(key) || 0) + 1;
            counts.set(key, n);
            return { success: n <= limit };
        }
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
    beforeEach(() => { _resetRateLimiterStateForTests(); });
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
        // Limite relevée : ce test vérifie le FORMAT des symboles, pas le rate
        // limiting — le repli mémoire (voir en-tête du fichier) compte par IP
        // pour la durée de vie du module, indépendamment de l'objet `env` fourni
        // à chaque appel (contrairement à l'ancien mock KV, recréé à chaque
        // makeEnv() — une particularité du test, jamais du vrai KV en
        // production, où le namespace persiste, lui, entre les requêtes).
        const env = makeEnv({ PRICE_RATE_LIMIT_PER_MINUTE: '100' });
        for (const symbol of ['SU.PA', 'BTC-EUR', '%5EGSPC', 'GC%3DF']) {
            const res = await worker.fetch(getRequest(`symbol=${symbol}`, {}), env);
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

    // ============================================================
    // INCIDENT POST-MORTEM (2026-09-23) — voir en-tête du fichier.
    // ============================================================

    it("une requête normale (autorisée) ne provoque JAMAIS d'écriture KV — cause racine de l'incident éliminée structurellement", async () => {
        stubFetch();
        const kv = fakeKV();
        const putSpy = vi.spyOn(kv, 'put');
        const getSpy = vi.spyOn(kv, 'get');

        // RATE_LIMIT (KV) toujours fourni dans l'env (comme en production tant
        // que gemini-worker partage le namespace) mais ne doit plus JAMAIS être
        // lu ni écrit par checkRateLimit — remplacé par le binding natif/repli
        // mémoire, tous deux sans aucune I/O KV. Limite relevée : ce test
        // vérifie l'ABSENCE d'écriture KV, pas le rate limiting lui-même.
        const env = makeEnv({ RATE_LIMIT: kv, PRICE_RATE_LIMIT_PER_MINUTE: '100' });
        for (let i = 0; i < 5; i++) {
            const res = await worker.fetch(getRequest(`symbol=AAPL${i}`), env);
            expect(res.status).toBe(200);
        }

        expect(putSpy).not.toHaveBeenCalled();
        expect(getSpy).not.toHaveBeenCalled();
    });

    it('un quota KV épuisé (le scénario exact de l\'incident : "KV put() limit exceeded for the day") ne fait plus jamais 500 — RATE_LIMIT n\'est simplement plus utilisé', async () => {
        stubFetch();
        const brokenKV = {
            async get() { throw new Error('KV get() limit exceeded for the day.'); },
            async put() { throw new Error('KV put() limit exceeded for the day.'); }
        };
        const res = await worker.fetch(getRequest('symbol=AAPL'), makeEnv({ RATE_LIMIT: brokenKV }));
        expect(res.status).toBe(200);
    });

    it("l'API native Cloudflare Rate Limiting (env.RATE_LIMITER) est utilisée en priorité quand disponible", async () => {
        stubFetch();
        const limiter = fakeRateLimiter(2);
        const limitSpy = vi.spyOn(limiter, 'limit');
        const env = makeEnv({ RATE_LIMITER: limiter, PRICE_RATE_LIMIT_PER_MINUTE: '2' });

        const r1 = await worker.fetch(getRequest('symbol=AAPL'), env);
        const r2 = await worker.fetch(getRequest('symbol=MSFT'), env);
        const r3 = await worker.fetch(getRequest('symbol=NVDA'), env);

        expect(limitSpy).toHaveBeenCalledTimes(3);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(429); // le binding natif a bien tranché, pas le repli mémoire
    });

    it('binding natif défaillant (erreur à l\'appel) → repli automatique sur le compteur mémoire, jamais un 500', async () => {
        stubFetch();
        const brokenLimiter = { async limit() { throw new Error('Rate limiting binding unavailable'); } };
        const res = await worker.fetch(getRequest('symbol=AAPL'), makeEnv({ RATE_LIMITER: brokenLimiter }));
        expect(res.status).toBe(200); // repli mémoire a autorisé la requête, pas de crash
    });

    it("checkRateLimit() qui lèverait malgré tout une exception ne bloque JAMAIS de vraies données financières (fail-open explicite, défense en profondeur)", async () => {
        stubFetch();
        // Simule un rate limiter totalement cassé, y compris son propre appel —
        // le call-site dans fetch() a son propre try/catch indépendant de
        // checkRateLimit() lui-même (voir worker.js).
        // Object.defineProperty APRÈS la construction de env : un getter passé
        // dans un objet spread ({...overrides}) serait invoqué IMMÉDIATEMENT
        // par makeEnv() elle-même (le spread lit la propriété) plutôt que
        // paresseusement quand le Worker y accède — ce n'est pas ce qu'on veut
        // tester ici.
        const env = makeEnv();
        Object.defineProperty(env, 'RATE_LIMITER', {
            get() { throw new Error('Accessing env.RATE_LIMITER itself throws'); }
        });
        const res = await worker.fetch(getRequest('symbol=AAPL'), env);
        expect(res.status).toBe(200);
    });
});
