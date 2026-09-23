/**
 * Cloudflare Worker - Gemini AI Proxy
 * Remplace: getgeminianalysis-oyvn6lsoeq-ew.a.run.app (Cloud Run)
 *
 * Reçoit: POST { prompt: "..." } (legacy) ou { system, history, message } (assistant)
 * Retourne: { text: "..." }
 *
 * La clé API Gemini est stockée dans les Secrets Cloudflare (env.GEMINI_API_KEY)
 *
 * SECURITY FIX (audit P0/P1) : ce Worker n'avait AUCUNE authentification —
 * seul un contrôle CORS/Origin protégeait l'appel, qui ne bloque que les
 * navigateurs, pas un appel direct (curl, script) qui peut envoyer n'importe
 * quel header Origin. Un attaquant pouvait donc consommer le quota Gemini
 * (payant) sans limite. Fix : exige désormais un Firebase ID token valide
 * (Authorization: Bearer <token>), vérifié par signature RS256 contre les
 * clés publiques Google (JWKS) — même mécanisme que
 * cloudflare-workers/enable-banking-worker/worker.js::verifyFirebaseIdToken,
 * qui l'implémentait déjà correctement pour ce Worker-là. Ajoute aussi une
 * validation stricte de la taille des entrées et un quota journalier par
 * utilisateur (KV) pour borner le coût en cas d'abus par un compte légitime
 * compromis ou malveillant.
 */

const ALLOWED_ORIGIN = 'https://asset-tracker.fr';
const GEMINI_MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const FIREBASE_PROJECT_ID = 'asset-tracker-479809-b80f1'; // public (voir src/firebaseConfig.js), pas un secret

const EXTRA_ORIGINS = [
  'https://asset-tracker-beta.web.app',
  'https://asset-tracker-479809-b80f1.web.app',
];

// ─── Limites anti-abus (coût Gemini) ─────────────────────────────────────────
const MAX_TEXT_LEN = 8000;       // par champ (prompt/message/system/un message d'historique)
const MAX_HISTORY_MESSAGES = 40; // nombre de tours de conversation transmis
const DEFAULT_DAILY_QUOTA = 200; // requêtes / utilisateur / jour (env.GEMINI_DAILY_QUOTA peut l'ajuster)

function corsHeaders(origin) {
  const isLocalhost = origin.startsWith('http://localhost:') || origin === 'http://localhost' || origin.startsWith('http://127.0.0.1:') || origin === 'http://127.0.0.1';
  const allowed = origin === ALLOWED_ORIGIN || EXTRA_ORIGINS.includes(origin) || isLocalhost;
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}

// ─── Vérification du Firebase ID Token (RS256 via JWKS Google, sans lib externe) ─
// Copié à l'identique de cloudflare-workers/enable-banking-worker/worker.js —
// ce Worker (Gemini) n'a pas de mécanisme de partage de code entre Workers
// (chacun est déployé indépendamment, sans étape de build), donc une petite
// duplication ciblée est préférable à une dépendance de build inter-Workers.

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let cachedFirebaseJwks = null;
let cachedFirebaseJwksAt = 0;

async function getFirebaseJwks() {
  if (cachedFirebaseJwks && Date.now() - cachedFirebaseJwksAt < 3600_000) return cachedFirebaseJwks;
  const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com');
  if (!res.ok) throw new Error('Impossible de récupérer les clés publiques Firebase (JWKS)');
  const data = await res.json();
  cachedFirebaseJwks = data.keys || [];
  cachedFirebaseJwksAt = Date.now();
  return cachedFirebaseJwks;
}

async function verifyFirebaseIdToken(idToken, projectId) {
  const [headerB64, payloadB64, sigB64] = idToken.split('.');
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error('Token malformé');

  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(headerB64)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64)));

  const jwks = await getFirebaseJwks();
  const jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Clé de signature Firebase inconnue (kid)');

  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('Signature invalide');

  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) throw new Error('Token expiré');
  if (payload.aud !== projectId) throw new Error('Audience inattendue');
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Issuer inattendu');
  if (!payload.sub) throw new Error('uid manquant');

  return payload; // payload.sub === uid Firebase
}

async function authenticate(request) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) throw new Error('missing_token');
  const payload = await verifyFirebaseIdToken(match[1], FIREBASE_PROJECT_ID);
  return payload.sub;
}

// ─── Quota journalier par utilisateur (KV) ───────────────────────────────────
// FAIL-OPEN délibéré ici (pas sur l'authentification, qui reste fail-closed) :
// si le binding KV n'est pas encore provisionné (ex: juste après un déploiement,
// avant `wrangler kv:namespace create` — voir wrangler.toml), on préfère
// dégrader la protection anti-coût plutôt que de rendre tout l'assistant
// indisponible pour une erreur de configuration d'infrastructure.
async function checkAndIncrementQuota(env, uid) {
  if (!env.RATE_LIMIT) {
    console.warn('[GeminiProxy] RATE_LIMIT KV binding absent — quota non appliqué (voir wrangler.toml).');
    return { allowed: true };
  }
  const dayKey = new Date().toISOString().slice(0, 10);
  const key = `gemini:${uid}:${dayKey}`;
  const quota = Number(env.GEMINI_DAILY_QUOTA) > 0 ? Number(env.GEMINI_DAILY_QUOTA) : DEFAULT_DAILY_QUOTA;

  const current = Number(await env.RATE_LIMIT.get(key)) || 0;
  if (current >= quota) return { allowed: false, quota };

  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 90000 }); // ~25h, couvre le changement de jour/fuseau
  return { allowed: true };
}

// ─── Validation stricte des entrées ──────────────────────────────────────────
function validateBody(body) {
  const tooLong = (s) => typeof s === 'string' && s.length > MAX_TEXT_LEN;
  if (tooLong(body.prompt) || tooLong(body.system) || tooLong(body.message)) {
    return `Champ texte trop volumineux (max ${MAX_TEXT_LEN} caractères)`;
  }
  if (body.history !== undefined) {
    if (!Array.isArray(body.history)) return 'history doit être un tableau';
    if (body.history.length > MAX_HISTORY_MESSAGES) return `history trop long (max ${MAX_HISTORY_MESSAGES} messages)`;
    for (const msg of body.history) {
      if (tooLong(msg?.text)) return `Message d'historique trop volumineux (max ${MAX_TEXT_LEN} caractères)`;
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    // Identité — FAIL CLOSED : un token absent, malformé, expiré ou signé par
    // une autre autorité (mauvais projet Firebase) est TOUJOURS rejeté. Jamais
    // de repli sur un uid fourni par le client (body.uid ou équivalent).
    let uid;
    try {
      uid = await authenticate(request);
    } catch (err) {
      console.warn('[GeminiProxy] Auth rejected:', err.message);
      return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[GeminiProxy] GEMINI_API_KEY secret not configured!');
      return jsonResponse({ error: 'Proxy misconfigured' }, 500, origin);
    }

    try {
      const body = await request.json();

      const validationError = validateBody(body);
      if (validationError) {
        return jsonResponse({ error: validationError }, 400, origin);
      }

      const quotaCheck = await checkAndIncrementQuota(env, uid);
      if (!quotaCheck.allowed) {
        return jsonResponse({ error: `Quota journalier dépassé (${quotaCheck.quota} requêtes/jour)` }, 429, origin);
      }

      // Support two payload formats:
      // 1. Simple: { prompt: "..." }  (legacy, news summaries)
      // 2. Multi-turn: { system: "...", history: [{role, text}], message: "..." }
      let contents = [];

      if (body.system || body.history || body.message) {
        if (body.system) {
          contents.push({ role: 'user', parts: [{ text: body.system }] });
          contents.push({ role: 'model', parts: [{ text: 'Compris, je suis ton assistant financier personnel. Pose-moi tes questions !' }] });
        }
        if (Array.isArray(body.history)) {
          body.history.forEach(msg => {
            contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts: [{ text: msg.text }] });
          });
        }
        if (body.message) {
          contents.push({ role: 'user', parts: [{ text: body.message }] });
        }
      } else if (body.prompt) {
        contents = [{ role: 'user', parts: [{ text: body.prompt }] }];
      } else {
        return jsonResponse({ error: 'prompt or message field required' }, 400, origin);
      }

      const isAssistantRequest = !!(body.system || body.history || body.message);
      const enableWebSearch = body.enableWebSearch !== false && isAssistantRequest;

      const geminiBody = {
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          thinkingConfig: { thinkingBudget: 0 },
        },
      };
      if (enableWebSearch) {
        geminiBody.tools = [{ google_search: {} }];
      }

      const geminiRes = await fetch(`${GEMINI_MODEL_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error('[GeminiProxy] Gemini API error:', geminiRes.status, errText);
        // Ne jamais renvoyer le texte d'erreur upstream brut au client (peut
        // contenir des détails internes) — seulement au log serveur.
        return jsonResponse({ error: 'Upstream AI provider error' }, 502, origin);
      }

      const geminiData = await geminiRes.json();
      const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      return jsonResponse({ text }, 200, origin);

    } catch (err) {
      console.error('[GeminiProxy] Error:', err.message);
      return jsonResponse({ error: 'Internal error' }, 500, origin);
    }
  }
};
