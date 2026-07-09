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

function jsonResponse(data, status = 200, origin = '') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
};

const FALLBACK_COOKIE = "A3=d=AQABBPHr6WkCEEaGkIeM_yx8FOid40uN4OoFEgEBAQE962nzaeWnJm0A_eMDAA&S=AQAAAkqh87MBpBhIeDBLrVjDJRo";
const FALLBACK_CRUMB = "u6NX/ugBV38";

let cachedCrumb = null;
let cachedCookie = null;

async function getYahooCrumb() {
  if (cachedCrumb && cachedCookie) return { crumb: cachedCrumb, cookie: cachedCookie };
  
  try {
    const res1 = await fetch('https://fc.yahoo.com', {
      headers: YAHOO_HEADERS,
      redirect: 'manual' 
    });
    const setCookie = res1.headers.get('set-cookie');
    if (!setCookie) {
        // Fallback to hardcoded EU consent bypassed crumb/cookie
        cachedCrumb = FALLBACK_CRUMB;
        cachedCookie = FALLBACK_COOKIE;
        return { crumb: FALLBACK_CRUMB, cookie: FALLBACK_COOKIE };
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
    cachedCrumb = FALLBACK_CRUMB;
    cachedCookie = FALLBACK_COOKIE;
    return { crumb: FALLBACK_CRUMB, cookie: FALLBACK_COOKIE };
  }
}

async function fetchYahoo(url, origin, opts = {}) {
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
    const { crumb, cookie } = await getYahooCrumb();
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

  let lastErr = null;
  for (const u of tryUrls) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(u, { headers, cf: { cacheTtl: 60 } });
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
        return await res.json();
      } catch (err) {
        lastErr = err;
        await new Promise(r => setTimeout(r, 200 + attempt * 150));
        continue;
      }
    }
  }
  throw lastErr || new Error('Yahoo fetch failed');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    try {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      const url = new URL(request.url);
      const symbol = url.searchParams.get('symbol');
      const type = (url.searchParams.get('type') || 'STOCK').toUpperCase();

      // ─── SEARCH ──────────────────────────────────────────────────────────────
      if (type === 'SEARCH') {
        if (!symbol) return jsonResponse({ error: 'symbol required' }, 400, origin);
        try {
          const searchUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&lang=en-US&region=US&quotesCount=8&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`;
          const data = await fetchYahoo(searchUrl, origin);
          return jsonResponse(data, 200, origin);
        } catch (err) {
          try { console.error(`[PricesProxy][SEARCH] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
          return jsonResponse({ error: err.message, url: null }, 500, origin);
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
          const data = await fetchYahoo(quoteSummaryUrl, origin, { useCrumb: true });
          return jsonResponse(data, 200, origin);
        } catch (err) {
          try { console.error(`[PricesProxy][QUOTE_SUMMARY] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
          return jsonResponse({ error: err.message, url: null }, 500, origin);
        }
      }

      // ─── FUNDAMENTALS (multi-year statements) ────────────────────────────────
      if (type === 'FUNDAMENTALS') {
        if (!symbol) return jsonResponse({ error: 'symbol required' }, 400, origin);
        try {
          const nowSec = Math.floor(Date.now() / 1000);
          const period1 = nowSec - 15 * 365 * 24 * 3600; // 15 years of annual history
          const fundamentalsUrl = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}?symbol=${encodeURIComponent(symbol)}&type=${FUNDAMENTALS_METRICS.join(',')}&period1=${period1}&period2=${nowSec}`;
          const data = await fetchYahoo(fundamentalsUrl, origin, { useCrumb: true });
          return jsonResponse(reshapeFundamentalsTimeseries(data, symbol), 200, origin);
        } catch (err) {
          try { console.error(`[PricesProxy][FUNDAMENTALS] Error for ${symbol}.`, err.stack || err.message); } catch (e) { console.error(e); }
          return jsonResponse({ error: err.message, url: null }, 500, origin);
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
        const data = await fetchYahoo(yahooUrl, origin);
        return jsonResponse(data, 200, origin);

      } catch (err) {
        try { console.error(`[PricesProxy][CHART] Error for ${symbol}.`, err.stack || err.message); } catch(e) { console.error(e); }
        return jsonResponse({ error: err.message, symbol, url: null }, 500, origin);
      }
    } catch (err) {
      // Catch any unexpected error and always reply with CORS headers
      try { console.error('[PricesProxy][FATAL] Unhandled error:', err.stack || err); } catch (e) { console.error(e); }
      return jsonResponse({ error: 'Unhandled error in worker', detail: err?.message || String(err) }, 500, request.headers.get('Origin') || '');
    }
  }
};
