/**
 * Cloudflare Worker - Prices Proxy
 * Supports:
 *   - type=STOCK/CRYPTO (default): historical chart via /v8/finance/chart
 *   - type=QUOTE_SUMMARY: fundamental data via /v10/finance/quoteSummary
 *   - type=FUNDAMENTALS: multi-year annual financial statements via /ws/fundamentals-timeseries
 *   - type=SEARCH: ticker search via /v1/finance/search
 */

// quoteSummary's incomeStatementHistory/balanceSheetHistory/cashflowStatementHistory modules
// only return { endDate, netIncome } per year now (Yahoo gutted them). fundamentals-timeseries
// is the endpoint that still returns full historical line items — each key below is a Yahoo
// "type" verified to return real annual data (income statement, balance sheet, cash flow, shares).
const FUNDAMENTALS_METRICS = [
  // Income statement
  'annualTotalRevenue', 'annualCostOfRevenue', 'annualGrossProfit', 'annualOperatingExpense',
  'annualOperatingIncome', 'annualPretaxIncome', 'annualTaxProvision', 'annualNetIncome',
  'annualBasicEPS', 'annualDilutedEPS',
  // Balance sheet
  'annualTotalAssets', 'annualCurrentAssets', 'annualCashAndCashEquivalents',
  'annualTotalLiabilitiesNetMinorityInterest', 'annualCurrentLiabilities', 'annualLongTermDebt',
  'annualTotalDebt', 'annualStockholdersEquity',
  // Cash flow
  'annualOperatingCashFlow', 'annualCapitalExpenditure', 'annualFreeCashFlow',
  'annualInvestingCashFlow', 'annualFinancingCashFlow', 'annualCommonStockDividendPaid',
  'annualRepurchaseOfCapitalStock', 'annualEndCashPosition',
  // Shares
  'annualBasicAverageShares', 'annualDilutedAverageShares',
];

// Yahoo returns one { meta: { type: [name] }, [name]: [{ asOfDate, reportedValue }] } block per
// requested metric. Reshape that into one row per fiscal year with all metrics as columns, which
// is far easier for the frontend to consume than hunting through 28 separate arrays.
function reshapeFundamentalsTimeseries(raw, symbol) {
  const results = raw?.timeseries?.result || [];
  const byYear = {};

  for (const block of results) {
    const metric = block?.meta?.type?.[0];
    const series = metric ? block[metric] : null;
    if (!metric || !Array.isArray(series)) continue;

    for (const point of series) {
      const asOfDate = point?.asOfDate;
      if (!asOfDate) continue;
      const year = asOfDate.slice(0, 4);
      if (!byYear[year]) byYear[year] = { year, endDate: asOfDate };
      byYear[year][metric] = point.reportedValue?.raw ?? null;
    }
  }

  const years = Object.values(byYear).sort((a, b) => a.year.localeCompare(b.year));
  return { symbol, years };
}

const ALLOWED_ORIGIN = 'https://asset-tracker.fr';

const EXTRA_ORIGINS = [
  'https://asset-tracker-beta.web.app',
  'https://asset-tracker-479809-b80f1.web.app',
];

function corsHeaders(origin) {
  const allowed = origin === ALLOWED_ORIGIN || EXTRA_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

// diag (optionnel) : { attempts, finalStatus } renseigné par fetchYahoo — voir
// commentaire de fetchYahoo. Purement diagnostique (validation architecture
// 2026-09-24, décision #7 "mesurer les deux niveaux Browser→Worker et
// Worker→Yahoo") : n'affecte ni le statut HTTP ni le corps de la réponse,
// seulement deux en-têtes que le frontend peut lire pour distinguer le coût
// réseau réellement supporté par le Worker (retries internes inclus) du
// simple aller-retour Browser→Worker.
function jsonResponse(data, status = 200, origin = '', diag = null) {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };
  if (diag) {
    if (diag.attempts != null) headers['X-Yahoo-Attempts'] = String(diag.attempts);
    if (diag.finalStatus != null) headers['X-Yahoo-Final-Status'] = String(diag.finalStatus);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

// SECURITY FIX (audit P1) : ces valeurs étaient codées en dur dans le code
// source (donc committées en clair indéfiniment dans git). Elles ne sont pas
// un secret à haut risque (un cookie/crumb Yahoo public, sans lien avec un
// compte utilisateur de l'app) mais restent un identifiant de session — elles
// viennent désormais de secrets Cloudflare (env.YAHOO_FALLBACK_COOKIE/
// _CRUMB, voir wrangler.toml) au lieu d'être committées. Comportement de
// repli INCHANGÉ : si l'acquisition dynamique échoue, on retombe sur ces
// valeurs (désormais externalisées) exactement comme avant — on ne
// transforme jamais cet échec en un PRIX fabriqué, seulement en un identifiant
// de session de repli déjà utilisé tel quel par le code précédent.
let cachedCrumb = null;
let cachedCookie = null;

async function getYahooCrumb(env) {
  if (cachedCrumb && cachedCookie) return { crumb: cachedCrumb, cookie: cachedCookie };
  const fallbackCookie = env?.YAHOO_FALLBACK_COOKIE || null;
  const fallbackCrumb = env?.YAHOO_FALLBACK_CRUMB || null;

  try {
    const res1 = await fetch('https://fc.yahoo.com', {
      headers: YAHOO_HEADERS,
      redirect: 'manual'
    });
    const setCookie = res1.headers.get('set-cookie');
    if (!setCookie) {
        // Fallback vers le cookie/crumb de secours (secret Cloudflare)
        cachedCrumb = fallbackCrumb;
        cachedCookie = fallbackCookie;
        return { crumb: fallbackCrumb, cookie: fallbackCookie };
    }

    // Extract actual cookies (A3 or B), ignoring Expires containing commas
    const matchList = setCookie.match(/(A3|B)=([^;]+)/g) || [];
    const cookies = matchList.join('; ');

    const res2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...YAHOO_HEADERS, 'Cookie': cookies }
    });
    if (!res2.ok) throw new Error("Crumb request failed");

    // Extract text block
    const crumb = await res2.text();
    cachedCrumb = crumb;
    cachedCookie = cookies;
    return { crumb, cookie: cookies };
  } catch (err) {
    cachedCrumb = fallbackCrumb;
    cachedCookie = fallbackCookie;
    return { crumb: fallbackCrumb, cookie: fallbackCookie };
  }
}

async function fetchYahoo(url, origin, env, opts = {}) {
  // If we need crumb, inject it and the cookie
  let fetchUrl = url;
  const headers = {
    ...YAHOO_HEADERS,
    'sec-ch-ua': '"Chromium";v="120", "Not)A;Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-fetch-site': 'same-site',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'Accept': 'application/json, text/javascript, */*; q=0.01',
  };

  if (opts.useCrumb) {
    const { crumb, cookie } = await getYahooCrumb(env);
    if (crumb) {
      fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + `crumb=${crumb}`;
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }
  }

  // Overrides
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;

  // Try query2 first, then query1
  const tryUrls = [];
  if (fetchUrl.includes('query1.finance.yahoo.com')) {
    tryUrls.push(fetchUrl.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com'));
    tryUrls.push(fetchUrl);
  } else if (fetchUrl.includes('query2.finance.yahoo.com')) {
    tryUrls.push(fetchUrl);
    tryUrls.push(fetchUrl.replace('query2.finance.yahoo.com', 'query1.finance.yahoo.com'));
  } else {
    tryUrls.push(fetchUrl);
  }

  // attempts/finalStatus : purs compteurs diagnostiques (voir jsonResponse et
  // marketDataMetrics.js côté frontend) — ne changent ni le nombre réel de
  // tentatives ni leur logique de retry, seulement ce qui est rapporté au
  // frontend une fois la boucle terminée.
  let lastErr = null;
  let attempts = 0;
  let finalStatus = null;
  for (const u of tryUrls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      attempts++;
      try {
        const res = await fetch(u, { headers, cf: { cacheTtl: 60 } });
        finalStatus = res.status;
        if (!res.ok) {
          lastErr = new Error(`Yahoo HTTP ${res.status}`);
          // On 401, clear crumb cache and retry next loop
          if (res.status === 401) {
            cachedCrumb = null;
            cachedCookie = null;
          }
          await new Promise(r => setTimeout(r, 200 + attempt * 150));
          continue;
        }
        const json = await res.json();
        return { json, attempts, finalStatus };
      } catch (err) {
        lastErr = err;
        finalStatus = 'network_error';
        await new Promise(r => setTimeout(r, 200 + attempt * 150));
        continue;
      }
    }
  }
  const finalErr = lastErr || new Error('Yahoo fetch failed');
  finalErr.attempts = attempts;
  finalErr.finalStatus = finalStatus;
  throw finalErr;
}

// SECURITY FIX (audit P1) : aucune validation de format n'existait sur
// `symbol` — n'importe quelle chaîne était encodée puis transmise telle
// quelle à Yahoo. Restreint aux caractères réellement utilisés par les
// tickers de l'app (lettres, chiffres, '.', '-', '=', '^' — voir
// MarketUtils.formatTicker : AAPL, SU.PA, BTC-EUR, ^GSPC, GC=F, EURUSD=X) et
// à une longueur raisonnable — un identifiant "symbol" qui ne ressemble à
// aucun ticker plausible est rejeté avant tout appel réseau.
const SYMBOL_RE = /^[A-Za-z0-9.\-=^]{1,20}$/;
function isValidSymbol(symbol) {
  return typeof symbol === 'string' && SYMBOL_RE.test(symbol);
}

// SECURITY FIX (audit P1) : ce Worker est public par nature (aucune
// authentification utilisateur n'a de sens pour de simples cotations
// boursières publiques), mais rien ne bornait le débit de requêtes — un
// script pouvait l'appeler en boucle et risquer de faire bannir l'IP
// partagée du Worker par Yahoo, ou consommer les ressources du Worker.
//
// INCIDENT DU 2026-09-23 (post-mortem, cause racine du "HTTP 500 sur toutes
// les requêtes historiques") : la version précédente appelait
// `env.RATE_LIMIT.put()` — une écriture KV — À CHAQUE requête autorisée, pas
// seulement à la première d'une fenêtre. Le plan gratuit Cloudflare Workers
// KV limite les écritures à 1000/jour PAR COMPTE (partagées avec
// gemini-worker, même namespace). Ce quota s'est épuisé en cours de journée ;
// `checkRateLimit` n'entourait pas son propre appel `.put()` d'un try/catch,
// donc l'exception ("KV put() limit exceeded for the day") remontait non
// interceptée jusqu'au catch-all générique de `fetch()` — un problème de
// PLOMBERIE anti-abus a fait tomber TOUTE donnée de prix, historique et
// live, pour le reste de la journée (confirmé en direct via `wrangler tail`).
//
// Fix : deux changements INDÉPENDANTS, tous deux nécessaires :
//   1. Ne plus jamais consommer une écriture KV par requête — le rate
//      limiter utilise désormais l'API native Cloudflare Workers Rate
//      Limiting (binding `env.RATE_LIMITER`, voir wrangler.toml) quand elle
//      est provisionnée : c'est une fonctionnalité de plateforme dédiée,
//      SANS quota d'écriture exposé au développeur (contrairement à KV),
//      recommandée par Cloudflare precisément pour ce cas d'usage.
//   2. Repli en mémoire LOCALE À L'ISOLATE (zéro I/O, donc structurellement
//      incapable d'échouer pour une raison d'infrastructure) si ce binding
//      est absent — remplace l'ancien binding KV, qui n'est plus utilisé du
//      tout par cette fonction (voir wrangler.toml, binding retiré).
//      Compromis assumé, identique à celui déjà accepté pour le cache
//      cachedCrumb/cachedCookie plus haut dans ce fichier : approximatif
//      (une nouvelle requête à une autre instance/colo repart à zéro), mais
//      c'est déjà l'exigence explicite de cette fonctionnalité depuis
//      l'origine ("juste une protection anti-abus best-effort" — voir
//      wrangler.toml). Que CE mécanisme de repli échoue pour une raison
//      technique est IMPOSSIBLE par construction (aucun appel réseau, aucune
//      I/O) — il ne peut donc plus jamais transformer une panne de rate
//      limiting en panne de données financières (règle explicite de l'audit :
//      "les erreurs du mécanisme de rate limiting ne doivent pas devenir
//      silencieusement des erreurs de données financières").
const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

// Repli en mémoire — fenêtre fixe par IP, aucune I/O. `rateLimitBuckets` vit
// tant que cet isolate Worker reste chaud (comportement identique à
// cachedCrumb/cachedCookie ci-dessus) ; bornage explicite de la taille pour
// qu'un isolate longue durée ne puisse pas accumuler indéfiniment de mémoire
// sous une attaque distribuée (dans ce cas dégradé, on vide tout plutôt que
// de faire de la gestion LRU précise — un faux négatif occasionnel reste
// acceptable pour une protection "best-effort").
const rateLimitBuckets = new Map(); // ip -> { windowStart, count }
const MAX_TRACKED_IPS = 5000;

// TEST-ONLY : les tests importent ce module UNE FOIS et appellent worker.fetch()
// dans plusieurs `it()` successifs — sans ce reset, l'état de ce Map (qui vit
// tant que l'isolate/le process de test reste chaud, exactement comme en
// production) s'accumulerait entre tests indépendants. Jamais appelé par le
// Worker lui-même en production.
export function _resetRateLimiterStateForTests() {
  rateLimitBuckets.clear();
}

function checkRateLimitInMemory(env, ip) {
  const limit = Number(env.PRICE_RATE_LIMIT_PER_MINUTE) > 0 ? Number(env.PRICE_RATE_LIMIT_PER_MINUTE) : DEFAULT_RATE_LIMIT_PER_MINUTE;
  const windowMs = 60000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;

  let bucket = rateLimitBuckets.get(ip);
  if (!bucket || bucket.windowStart !== windowStart) {
    if (rateLimitBuckets.size >= MAX_TRACKED_IPS) rateLimitBuckets.clear();
    bucket = { windowStart, count: 0 };
    rateLimitBuckets.set(ip, bucket);
  }
  if (bucket.count >= limit) return { allowed: false, limit };
  bucket.count += 1;
  return { allowed: true };
}

async function checkRateLimit(env, ip) {
  // API native Cloudflare Rate Limiting (voir wrangler.toml pour l'activer) —
  // gérée entièrement côté plateforme, aucune écriture KV, aucun quota
  // journalier visible de ce code. Toute erreur (binding mal configuré,
  // erreur de plateforme...) retombe sur le repli mémoire ci-dessous — ne
  // JAMAIS laisser une erreur de ce mécanisme remonter jusqu'au catch-all
  // de fetch() (c'est exactement ce qui a causé l'incident).
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      return { allowed: success };
    } catch (err) {
      try { console.error('[PricesProxy][RateLimiter] Binding natif indisponible, repli mémoire.', err?.message || err); } catch (e) { /* noop */ }
    }
  }
  return checkRateLimitInMemory(env, ip);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      // Défense en profondeur (règle explicite de l'audit) : même si
      // checkRateLimit() est désormais conçu pour ne jamais lever d'exception
      // (natif avec son propre try/catch + repli mémoire sans I/O), une
      // panne du RATE LIMITER LUI-MÊME ne doit jamais empêcher de servir de
      // VRAIES données financières — on autorise la requête (fail-open) et on
      // journalise, plutôt que de répéter l'incident du 2026-09-23.
      let rateLimit = { allowed: true };
      try {
        rateLimit = await checkRateLimit(env, ip);
      } catch (err) {
        try { console.error('[PricesProxy][RateLimiter] Erreur inattendue, requête autorisée par défaut.', err?.message || err); } catch (e) { /* noop */ }
      }
      if (!rateLimit.allowed) {
        return jsonResponse({ error: 'Too many requests' }, 429, origin);
      }

      const url = new URL(request.url);
      const symbol = url.searchParams.get('symbol');
      const type = (url.searchParams.get('type') || 'STOCK').toUpperCase();

      if (symbol && !isValidSymbol(symbol)) {
        return jsonResponse({ error: 'Invalid symbol format' }, 400, origin);
      }

      // ─── SEARCH ──────────────────────────────────────────────────────────────
      if (type === 'SEARCH') {
        if (!symbol) return jsonResponse({ error: 'symbol required' }, 400, origin);
        try {
          const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&lang=en-US&region=US&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
          const { json, attempts, finalStatus } = await fetchYahoo(searchUrl, origin, env);
          return jsonResponse(json, 200, origin, { attempts, finalStatus });
        } catch (err) {
          try { console.error(`[PricesProxy][SEARCH] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
          return jsonResponse({ error: 'Upstream provider error' }, 502, origin, { attempts: err.attempts, finalStatus: err.finalStatus });
        }
      }

      // ─── QUOTE SUMMARY (Fundamentals) ────────────────────────────────────────
      if (type === 'QUOTE_SUMMARY') {
        if (!symbol) return jsonResponse({ error: 'symbol required' }, 400, origin);
        try {
          const modules = [
            'assetProfile',
            'defaultKeyStatistics',
            'financialData',
            'summaryDetail',
            'price',
            'earningsTrend',
            'incomeStatementHistory',
            'cashflowStatementHistory',
            'balanceSheetHistory',
          ].join(',');
          const quoteSummaryUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&lang=en-US&region=US`;
          const { json, attempts, finalStatus } = await fetchYahoo(quoteSummaryUrl, origin, env, { useCrumb: true });
          return jsonResponse(json, 200, origin, { attempts, finalStatus });
        } catch (err) {
          try { console.error(`[PricesProxy][QUOTE_SUMMARY] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
          return jsonResponse({ error: 'Upstream provider error' }, 502, origin, { attempts: err.attempts, finalStatus: err.finalStatus });
        }
      }

      // ─── FUNDAMENTALS (multi-year statements) ────────────────────────────────
      if (type === 'FUNDAMENTALS') {
        if (!symbol) return jsonResponse({ error: 'symbol required' }, 400, origin);
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const period1 = nowSec - 15 * 365 * 24 * 3600; // 15 years of annual history
          const fundamentalsUrl = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${FUNDAMENTALS_METRICS.join(',')}&period1=${period1}&period2=${nowSec}`;
          const { json, attempts, finalStatus } = await fetchYahoo(fundamentalsUrl, origin, env, { useCrumb: true });
          return jsonResponse(reshapeFundamentalsTimeseries(json, symbol), 200, origin, { attempts, finalStatus });
        } catch (err) {
          try { console.error(`[PricesProxy][FUNDAMENTALS] Error for ${symbol}.`, err.stack || err.message); } catch (e) { console.error(e); }
          return jsonResponse({ error: 'Upstream provider error' }, 502, origin, { attempts: err.attempts, finalStatus: err.finalStatus });
        }
      }

      // ─── HISTORICAL CHART (default) ──────────────────────────────────────────
      if (!symbol) return jsonResponse({ error: 'symbol parameter required' }, 400, origin);

      try {
        const range = url.searchParams.get('range') || '5d';
        const interval = url.searchParams.get('interval') || '1d';
        const period1 = url.searchParams.get('period1');
        const period2 = url.searchParams.get('period2');
        const events = url.searchParams.get('events'); // ex: div, div|split

        let yahooParams = `interval=${interval}&includePrePost=false`;
        if (period1 && period2) {
          yahooParams += `&period1=${period1}&period2=${period2}`;
        } else {
          yahooParams += `&range=${range}`;
        }
        if (events) {
          yahooParams += `&events=${encodeURIComponent(events)}`;
        }

        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${yahooParams}`;
        const { json, attempts, finalStatus } = await fetchYahoo(yahooUrl, origin, env);
        return jsonResponse(json, 200, origin, { attempts, finalStatus });

      } catch (err) {
        try { console.error(`[PricesProxy][CHART] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
        return jsonResponse({ error: 'Upstream provider error', symbol }, 502, origin, { attempts: err.attempts, finalStatus: err.finalStatus });
      }
    } catch (err) {
      // Catch any unexpected error and always reply with CORS headers
      try { console.error('[PricesProxy][FATAL] Unhandled error:', err.stack || err); } catch (e) { console.error(e); }
      return jsonResponse({ error: 'Unhandled error in worker' }, 500, request.headers.get('Origin') || '');
    }
  }
};
