/**
 * Cloudflare Worker - Gemini AI Proxy
 * Remplace: getgeminianalysis-oyvn6lsoeq-ew.a.run.app (Cloud Run)
 * 
 * Reçoit: POST { prompt: "..." }
 * Retourne: { text: "..." }
 * 
 * La clé API Gemini est stockée dans les Secrets Cloudflare (env.GEMINI_API_KEY)
 */

const ALLOWED_ORIGIN = 'https://asset-tracker.fr';
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash:generateContent';

const EXTRA_ORIGINS = [
  'https://asset-tracker-beta.web.app',
  'https://asset-tracker-479809-b80f1.web.app',
];

function corsHeaders(origin) {
  const isLocalhost = origin.startsWith('http://localhost:') || origin === 'http://localhost' || origin.startsWith('http://127.0.0.1:') || origin === 'http://127.0.0.1';
  const allowed = origin === ALLOWED_ORIGIN || EXTRA_ORIGINS.includes(origin) || isLocalhost;
  return {
    'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('[GeminiProxy] GEMINI_API_KEY secret not configured!');
      return jsonResponse({ error: 'Proxy misconfigured' }, 500, origin);
    }

    try {
      const body = await request.json();

      // Support two payload formats:
      // 1. Simple: { prompt: "..." }  (legacy, news summaries)
      // 2. Multi-turn: { system: "...", history: [{role, text}], message: "..." }
      let contents = [];

      if (body.system || body.history || body.message) {
        // Multi-turn format for the assistant
        if (body.system) {
          // System instruction as a first user turn (Gemini 1.5 flash supports systemInstruction)
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
        // Legacy single-turn format
        contents = [{ role: 'user', parts: [{ text: body.prompt }] }];
      } else {
        return jsonResponse({ error: 'prompt or message field required' }, 400, origin);
      }

      const GEMINI_MODEL_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

      // Assistant : recherche web activée par défaut (analyse marché, actualités, fondamentaux)
      // News/résumés legacy { prompt } : pas de recherche (économie API)
      const isAssistantRequest = !!(body.system || body.history || body.message);
      const enableWebSearch = body.enableWebSearch !== false && isAssistantRequest;

      const geminiBody = {
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
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
        throw new Error(`Gemini API HTTP ${geminiRes.status}: ${errText}`);
      }

      const geminiData = await geminiRes.json();
      const text = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';

      return jsonResponse({ text }, 200, origin);

    } catch (err) {
      console.error('[GeminiProxy] Error:', err.message);
      return jsonResponse({ error: err.message }, 500, origin);
    }
  }
};
