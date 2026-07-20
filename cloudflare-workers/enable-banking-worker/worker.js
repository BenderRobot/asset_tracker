/**
 * Cloudflare Worker - Enable Banking Proxy
 *
 * Connecte les comptes bancaires de l'utilisateur (Revolut, Boursorama, Trade Republic...)
 * via l'API Enable Banking (Open Banking / PSD2), et synchronise comptes + transactions
 * vers Firestore. Aucune dépendance npm : tout est fait avec la Web Crypto API native
 * (compatible avec l'environnement Edge de Cloudflare Workers).
 *
 * Routes exposées :
 *   GET  /aspsps?country=FR   -> liste des banques disponibles (aide au mapping nom/pays exact)
 *   POST /connect             -> génère l'URL d'autorisation Enable Banking (auth: Firebase ID token)
 *   GET  /callback            -> callback OAuth Enable Banking : échange le code, récupère les
 *                                 comptes/transactions, les écrit dans Firestore, puis redirige
 *                                 l'utilisateur vers le dashboard.
 *
 * Variables d'environnement attendues (voir wrangler.toml) :
 *   [vars]   ENABLE_BANKING_APP_ID, ENABLE_BANKING_REDIRECT_URL, FRONTEND_URL,
 *            FIREBASE_PROJECT_ID, FIREBASE_SA_EMAIL
 *   [secret] ENABLE_BANKING_PRIVATE_KEY, FIREBASE_SA_PRIVATE_KEY, STATE_HMAC_SECRET
 */

// ─── CORS (même convention que les autres Workers du projet) ────────────────

const ALLOWED_ORIGIN = 'https://asset-tracker.fr';

const EXTRA_ORIGINS = [
  'https://asset-tracker-beta.web.app',
  'https://asset-tracker-479809-b80f1.web.app',
];

function corsHeaders(origin) {
  const isLocalhost = origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:');
  const allowed = origin === ALLOWED_ORIGIN || EXTRA_ORIGINS.includes(origin) || isLocalhost;
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// ─── Encodage / PEM helpers ──────────────────────────────────────────────────

function b64urlEncode(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pemToBinary(pem) {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// ─── JWT RS256 : signature générique (utilisée pour Enable Banking ET Google) ─

async function importRsaPrivateKey(pem) {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(pem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

async function signJwtRS256(header, payload, privateKeyPem) {
  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(JSON.stringify(payload))}`;
  const key = await importRsaPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(signature)}`;
}

// ─── Vérification du Firebase ID Token (RS256 via JWKS Google, sans lib externe) ─

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

// ─── Signature du paramètre "state" (lie la session OAuth banque à l'UID Firebase) ─
// Le callback Enable Banking (redirection top-level du navigateur) ne peut pas porter
// l'Authorization header : on encode donc l'UID dans "state" et on le protège par HMAC
// pour empêcher qu'un tiers falsifie l'UID cible lors du callback.

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signState(claims, secret) {
  const nonce = b64urlEncode(crypto.getRandomValues(new Uint8Array(12)));
  const expiresAt = Math.floor(Date.now() / 1000) + 1800; // 30 min pour compléter le consentement
  const encoded = b64urlEncode(JSON.stringify({ ...claims, nonce, expiresAt }));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(encoded));
  return `${encoded}.${b64urlEncode(sig)}`;
}

async function verifyState(state, secret) {
  const [encoded, sigB64] = state.split('.');
  if (!encoded || !sigB64) throw new Error('state malformé');

  const key = await hmacKey(secret);
  const valid = await crypto.subtle.verify('HMAC', key, b64urlDecode(sigB64), new TextEncoder().encode(encoded));
  if (!valid) throw new Error('signature state invalide');

  const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(encoded)));
  if (Number(claims.expiresAt) < Math.floor(Date.now() / 1000)) throw new Error('state expiré');
  if (!claims.uid) throw new Error('uid manquant dans state');

  return claims; // { uid, aspspName, aspspCountry, nonce, expiresAt }
}

// ─── Enable Banking API ──────────────────────────────────────────────────────

const ENABLE_BANKING_BASE_URL = 'https://api.enablebanking.com';
const CONSENT_VALID_DAYS = 90; // À ne pas dépasser aspsp.maximum_consent_validity (cf. GET /aspsps)

async function getEnableBankingJwt(env) {
  const iat = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'RS256', kid: env.ENABLE_BANKING_APP_ID };
  const payload = { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 };
  return signJwtRS256(header, payload, env.ENABLE_BANKING_PRIVATE_KEY);
}

async function enableBankingFetch(env, path, options = {}) {
  const jwt = await getEnableBankingJwt(env);
  const res = await fetch(`${ENABLE_BANKING_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Enable Banking ${options.method || 'GET'} ${path} -> HTTP ${res.status}: ${errText}`);
  }
  return res.json();
}

// ─── Accès Firestore via l'API REST (Admin SDK non compatible avec les Workers) ─
// Le Worker s'authentifie auprès de Google avec un compte de service (OAuth2 JWT
// Bearer flow) puis appelle directement l'API REST Firestore avec l'access_token obtenu.

let cachedGoogleToken = null;
let cachedGoogleTokenExpiry = 0;

async function getGoogleAccessToken(env) {
  if (cachedGoogleToken && Date.now() < cachedGoogleTokenExpiry - 60_000) return cachedGoogleToken;

  const iat = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: env.FIREBASE_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const assertion = await signJwtRS256(header, payload, env.FIREBASE_SA_PRIVATE_KEY);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Échec de l'obtention du token Google (compte de service) : HTTP ${res.status} ${errText}`);
  }
  const data = await res.json();
  cachedGoogleToken = data.access_token;
  cachedGoogleTokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedGoogleToken;
}

function toFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toFirestoreValue) } };
  if (typeof v === 'object') return { mapValue: { fields: objectToFirestoreFields(v) } };
  return { stringValue: String(v) };
}

function objectToFirestoreFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    fields[k] = toFirestoreValue(v);
  }
  return fields;
}

async function firestoreUpsert(env, accessToken, path, data) {
  // PATCH sans updateMask = le document est remplacé par exactement les champs fournis (upsert idempotent).
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: objectToFirestoreFields(data) }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Firestore PATCH ${path} -> HTTP ${res.status}: ${errText}`);
  }
  return res.json();
}

// ─── Synchronisation comptes + transactions ──────────────────────────────────

const TRANSACTIONS_LOOKBACK_DAYS = 180;
const MAX_TRANSACTION_PAGES = 10; // garde-fou anti-boucle infinie sur continuation_key

async function fetchAllTransactions(env, accountId) {
  const dateFrom = new Date(Date.now() - TRANSACTIONS_LOOKBACK_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const all = [];
  let continuationKey = null;

  for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
    let path = `/accounts/${accountId}/transactions?date_from=${dateFrom}`;
    if (continuationKey) path += `&continuation_key=${encodeURIComponent(continuationKey)}`;
    const data = await enableBankingFetch(env, path);
    all.push(...(data.transactions || []));
    continuationKey = data.continuation_key || null;
    if (!continuationKey) break;
  }
  return all;
}

function buildTransactionDocId(accountId, tx) {
  const ref = tx.entry_reference || tx.transaction_id || `${tx.booking_date}_${tx.transaction_amount?.amount}`;
  return `${accountId}_${ref}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 400);
}

function formatTransaction(accountId, tx) {
  const isDebit = tx.credit_debit_indicator === 'DBIT';
  return {
    accountId,
    amount: tx.transaction_amount ? Number(tx.transaction_amount.amount) : null,
    currency: tx.transaction_amount?.currency || null,
    direction: tx.credit_debit_indicator || null,
    bookingDate: tx.booking_date || null,
    valueDate: tx.value_date || null,
    status: tx.status || null,
    description: Array.isArray(tx.remittance_information) ? tx.remittance_information.join(' ') : (tx.remittance_information || ''),
    counterparty: (isDebit ? tx.creditor?.name : tx.debtor?.name) || null,
    merchantCategoryCode: tx.merchant_category_code || null,
    source: 'enable-banking',
    syncedAt: new Date().toISOString(),
  };
}

async function syncBankDataToFirestore(env, uid, code, aspspName, aspspCountry) {
  const session = await enableBankingFetch(env, '/sessions', { method: 'POST', body: JSON.stringify({ code }) });
  const accounts = session.accounts || [];
  const accessToken = await getGoogleAccessToken(env);

  await firestoreUpsert(env, accessToken, `users/${uid}/bankConnections/${session.session_id}`, {
    sessionId: session.session_id,
    aspspName: aspspName || null,
    aspspCountry: aspspCountry || null,
    accountUids: accounts.map((a) => a.uid),
    connectedAt: new Date().toISOString(),
  });

  for (const account of accounts) {
    const accountId = account.uid;

    const [balances, transactions] = await Promise.all([
      enableBankingFetch(env, `/accounts/${accountId}/balances`).catch(() => ({ balances: [] })),
      fetchAllTransactions(env, accountId),
    ]);

    await firestoreUpsert(env, accessToken, `users/${uid}/bankAccounts/${accountId}`, {
      iban: account.account_id?.iban || null,
      name: account.name || null,
      currency: account.currency || null,
      cashAccountType: account.cash_account_type || null,
      balances: (balances.balances || []).map((b) => ({
        name: b.name || null,
        amount: b.balance_amount ? Number(b.balance_amount.amount) : null,
        currency: b.balance_amount?.currency || null,
        referenceDate: b.reference_date || null,
      })),
      updatedAt: new Date().toISOString(),
    });

    for (const tx of transactions) {
      const docId = buildTransactionDocId(accountId, tx);
      await firestoreUpsert(env, accessToken, `users/${uid}/transactions/${docId}`, formatTransaction(accountId, tx));
    }
  }

  return accounts.length;
}

// ─── Handlers HTTP ────────────────────────────────────────────────────────────

async function handleListAspsps(env, url, origin) {
  const country = url.searchParams.get('country');
  const path = country ? `/aspsps?country=${encodeURIComponent(country)}` : '/aspsps';
  const data = await enableBankingFetch(env, path);
  return jsonResponse(data, 200, origin);
}

async function handleConnect(request, env, origin) {
  const idToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!idToken) return jsonResponse({ error: 'Authorization: Bearer <Firebase ID token> requis' }, 401, origin);

  let firebasePayload;
  try {
    firebasePayload = await verifyFirebaseIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch (err) {
    return jsonResponse({ error: `Token Firebase invalide : ${err.message}` }, 401, origin);
  }

  const body = await request.json().catch(() => ({}));
  const { aspspName, aspspCountry } = body;
  if (!aspspName || !aspspCountry) {
    return jsonResponse({ error: 'aspspName et aspspCountry sont requis (voir GET /aspsps)' }, 400, origin);
  }

  const state = await signState({ uid: firebasePayload.sub, aspspName, aspspCountry }, env.STATE_HMAC_SECRET);
  const validUntil = new Date(Date.now() + CONSENT_VALID_DAYS * 24 * 3600 * 1000).toISOString();

  const data = await enableBankingFetch(env, '/auth', {
    method: 'POST',
    body: JSON.stringify({
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: aspspCountry },
      state,
      redirect_url: env.ENABLE_BANKING_REDIRECT_URL,
      psu_type: 'personal',
    }),
  });

  return jsonResponse({ url: data.url }, 200, origin);
}

function redirectToFrontend(env, params) {
  const target = new URL(env.FRONTEND_URL);
  Object.entries(params).forEach(([k, v]) => target.searchParams.set(k, v));
  return new Response(null, { status: 302, headers: { Location: target.toString() } });
}

async function handleCallback(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const bankError = url.searchParams.get('error') || url.searchParams.get('error_description');

  if (bankError) return redirectToFrontend(env, { bank_error: bankError });
  if (!code || !state) return redirectToFrontend(env, { bank_error: 'missing_code_or_state' });

  let stateClaims;
  try {
    stateClaims = await verifyState(state, env.STATE_HMAC_SECRET);
  } catch (err) {
    console.error('[EnableBankingProxy][CALLBACK] state invalide:', err.message);
    return redirectToFrontend(env, { bank_error: 'invalid_state' });
  }

  const { uid, aspspName, aspspCountry } = stateClaims;

  try {
    const accountCount = await syncBankDataToFirestore(env, uid, code, aspspName, aspspCountry);
    return redirectToFrontend(env, { bank_connected: '1', accounts: String(accountCount) });
  } catch (err) {
    console.error('[EnableBankingProxy][CALLBACK] sync failed:', err.stack || err.message);
    return redirectToFrontend(env, { bank_error: 'sync_failed' });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/aspsps' && request.method === 'GET') {
        return await handleListAspsps(env, url, origin);
      }
      if (url.pathname === '/connect' && request.method === 'POST') {
        return await handleConnect(request, env, origin);
      }
      if (url.pathname === '/callback' && request.method === 'GET') {
        return await handleCallback(url, env);
      }
      return jsonResponse({ error: 'Not found' }, 404, origin);
    } catch (err) {
      console.error('[EnableBankingProxy][FATAL]', err.stack || err.message);
      return jsonResponse({ error: err.message }, 500, origin);
    }
  },
};
