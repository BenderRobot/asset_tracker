// Tests du VRAI code du Worker Gemini (cloudflare-workers/gemini-worker/worker.js),
// importé et exécuté directement — Node fournit nativement fetch/Request/
// Response/crypto.subtle, donc ce module s'exécute tel quel sous Vitest, sans
// harnais Cloudflare. `fetch` global est stubé pour rediriger le JWKS Firebase
// et l'appel Gemini vers des réponses contrôlées ; aucun réseau réel.
//
// BUG FOUND (audit sécurité) : ce Worker n'avait AUCUNE authentification —
// seul un contrôle CORS/Origin, qui ne protège pas contre un appel direct
// (curl/script). Ces tests prouvent que le nouveau code REJETTE réellement
// les requêtes non authentifiées et applique un quota, pas seulement qu'il
// "devrait" le faire en théorie.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import worker from '../cloudflare-workers/gemini-worker/worker.js';

const PROJECT_ID = 'asset-tracker-479809-b80f1';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const GEMINI_URL_PREFIX = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

function base64url(buf) {
    return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let keyPair, publicJwk;

beforeAll(async () => {
    keyPair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify']
    );
    publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    publicJwk.kid = 'test-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
});

async function makeToken({
    uid = 'user-123',
    exp = Math.floor(Date.now() / 1000) + 3600,
    aud = PROJECT_ID,
    iss = `https://securetoken.google.com/${PROJECT_ID}`,
    kid = 'test-kid',
    privateKey = keyPair.privateKey
} = {}) {
    const header = { alg: 'RS256', kid };
    const payload = { sub: uid, aud, iss, exp, iat: Math.floor(Date.now() / 1000) };
    const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(signingInput));
    return `${signingInput}.${base64url(sig)}`;
}

function fakeKV() {
    const store = new Map();
    return {
        async get(key) { return store.has(key) ? store.get(key) : null; },
        async put(key, value) { store.set(key, value); },
        _store: store
    };
}

function stubFetch({ geminiOk = true } = {}) {
    return vi.stubGlobal('fetch', vi.fn(async (url) => {
        const u = String(url);
        if (u === JWKS_URL) {
            return { ok: true, json: async () => ({ keys: [publicJwk] }) };
        }
        if (u.startsWith(GEMINI_URL_PREFIX)) {
            if (!geminiOk) return { ok: false, status: 503, text: async () => 'upstream broken (should never reach the client)' };
            return {
                ok: true,
                json: async () => ({ candidates: [{ content: { parts: [{ text: 'Réponse IA factice.' }] } }] })
            };
        }
        throw new Error(`Unexpected fetch to ${u}`);
    }));
}

function makeEnv(overrides = {}) {
    return { GEMINI_API_KEY: 'fake-key-for-tests', RATE_LIMIT: fakeKV(), GEMINI_DAILY_QUOTA: '3', ...overrides };
}

function postRequest(body, headers = {}) {
    return new Request('https://asset-tracker-gemini.example.workers.dev/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://asset-tracker.fr', ...headers },
        body: JSON.stringify(body)
    });
}

describe('Gemini Worker — authentification et quotas (P0)', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('requête sans token → 401', async () => {
        stubFetch();
        const res = await worker.fetch(postRequest({ prompt: 'salut' }), makeEnv());
        expect(res.status).toBe(401);
        const data = await res.json();
        expect(data.error).toBe('Unauthorized');
    });

    it('token invalide (signature falsifiée) → 401', async () => {
        stubFetch();
        const goodToken = await makeToken();
        const tamperedToken = goodToken.slice(0, -4) + 'XXXX'; // corrompt la signature
        const res = await worker.fetch(postRequest({ prompt: 'salut' }, { Authorization: `Bearer ${tamperedToken}` }), makeEnv());
        expect(res.status).toBe(401);
    });

    it('token expiré → 401', async () => {
        stubFetch();
        const expiredToken = await makeToken({ exp: Math.floor(Date.now() / 1000) - 60 });
        const res = await worker.fetch(postRequest({ prompt: 'salut' }, { Authorization: `Bearer ${expiredToken}` }), makeEnv());
        expect(res.status).toBe(401);
    });

    it('token signé pour un AUTRE projet Firebase → 401 (audience rejetée)', async () => {
        stubFetch();
        const wrongAudToken = await makeToken({ aud: 'un-autre-projet-firebase' });
        const res = await worker.fetch(postRequest({ prompt: 'salut' }, { Authorization: `Bearer ${wrongAudToken}` }), makeEnv());
        expect(res.status).toBe(401);
    });

    it('utilisateur authentifié avec un token valide → autorisé (200)', async () => {
        stubFetch();
        const token = await makeToken({ uid: 'alice' });
        const res = await worker.fetch(postRequest({ prompt: 'salut' }, { Authorization: `Bearer ${token}` }), makeEnv());
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.text).toBe('Réponse IA factice.');
    });

    it('input trop volumineux (prompt > limite) → 400, jamais transmis à Gemini', async () => {
        stubFetch();
        const geminiSpy = vi.mocked(fetch);
        const token = await makeToken();
        const hugePrompt = 'x'.repeat(20000);
        const res = await worker.fetch(postRequest({ prompt: hugePrompt }, { Authorization: `Bearer ${token}` }), makeEnv());
        expect(res.status).toBe(400);
        // Seul le JWKS a dû être appelé — jamais l'API Gemini avec ce prompt.
        expect(geminiSpy.mock.calls.some(([u]) => String(u).startsWith(GEMINI_URL_PREFIX))).toBe(false);
    });

    it('history avec trop de messages → 400', async () => {
        stubFetch();
        const token = await makeToken();
        const history = Array.from({ length: 100 }, (_, i) => ({ role: 'user', text: `msg ${i}` }));
        const res = await worker.fetch(postRequest({ message: 'salut', history }, { Authorization: `Bearer ${token}` }), makeEnv());
        expect(res.status).toBe(400);
    });

    it('dépassement du quota journalier → 429', async () => {
        stubFetch();
        const token = await makeToken({ uid: 'bob' });
        const env = makeEnv({ GEMINI_DAILY_QUOTA: '2' });

        const r1 = await worker.fetch(postRequest({ prompt: 'q1' }, { Authorization: `Bearer ${token}` }), env);
        const r2 = await worker.fetch(postRequest({ prompt: 'q2' }, { Authorization: `Bearer ${token}` }), env);
        const r3 = await worker.fetch(postRequest({ prompt: 'q3' }, { Authorization: `Bearer ${token}` }), env);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(429);
    });

    it('le quota est isolé PAR utilisateur (bob épuisé n\'affecte pas alice)', async () => {
        stubFetch();
        const env = makeEnv({ GEMINI_DAILY_QUOTA: '1' });
        const bobToken = await makeToken({ uid: 'bob2' });
        const aliceToken = await makeToken({ uid: 'alice2' });

        const rBob1 = await worker.fetch(postRequest({ prompt: 'q1' }, { Authorization: `Bearer ${bobToken}` }), env);
        const rBob2 = await worker.fetch(postRequest({ prompt: 'q2' }, { Authorization: `Bearer ${bobToken}` }), env);
        const rAlice1 = await worker.fetch(postRequest({ prompt: 'q1' }, { Authorization: `Bearer ${aliceToken}` }), env);

        expect(rBob1.status).toBe(200);
        expect(rBob2.status).toBe(429);
        expect(rAlice1.status).toBe(200);
    });

    it('une erreur upstream Gemini ne fuit jamais son texte brut au client', async () => {
        stubFetch({ geminiOk: false });
        const token = await makeToken();
        const res = await worker.fetch(postRequest({ prompt: 'salut' }, { Authorization: `Bearer ${token}` }), makeEnv());
        expect(res.status).toBe(502);
        const data = await res.json();
        expect(data.error).not.toMatch(/upstream broken/);
    });
});
