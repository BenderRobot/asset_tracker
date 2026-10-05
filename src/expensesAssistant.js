// ========================================
// expensesAssistant.js - Rapport IA "optimiser mon cashflow" (page Dépenses)
// ========================================

import { auth } from './firebaseConfig.js';
import { GEMINI_PROXY_URL } from './config.js';
import { getAuthHeader } from './authFetchHeaders.js';
import { buildExpensesAnalysisPrompt, buildExpensesContext } from './expensesContext.js';
import { escapeGeminiHtml, formatSafeGeminiHtml } from './safeGeminiHtml.js';

function formatGeminiText(text) {
  return formatSafeGeminiHtml(text);
}

const btn = document.getElementById('expenses-ai-analyze-btn');
const outputEl = document.getElementById('expenses-ai-report');

async function analyze() {
  const user = auth.currentUser;
  if (!user || !btn || !outputEl) return;

  btn.disabled = true;
  outputEl.style.display = 'block';
  outputEl.innerHTML = '<div class="empty-state"><i class="fas fa-spinner fa-spin"></i> Analyse de tes dépenses en cours…</div>';

  try {
    const ctx = await buildExpensesContext(user.uid);
    if (!ctx || !ctx.hasTransactionData) {
      outputEl.innerHTML = '<div class="empty-state">Pas assez de données bancaires pour analyser tes dépenses. Connecte une banque et laisse l\'historique se remplir un peu.</div>';
      return;
    }

    const prompt = buildExpensesAnalysisPrompt(ctx);

    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await getAuthHeader()) },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.text) throw new Error(data.error || `HTTP ${res.status}`);

    outputEl.innerHTML = formatGeminiText(data.text);
  } catch (err) {
    console.error('[ExpensesAssistant] Error:', err);
    outputEl.innerHTML = `<div class="empty-state">Erreur pendant l'analyse (${escapeGeminiHtml(err.message)}). <button id="expenses-ai-retry-btn" class="btn btn-primary" style="margin-left:8px; padding:6px 12px;">Réessayer</button></div>`;
    document.getElementById('expenses-ai-retry-btn')?.addEventListener('click', analyze);
  } finally {
    if (btn) btn.disabled = false;
  }
}

btn?.addEventListener('click', analyze);
