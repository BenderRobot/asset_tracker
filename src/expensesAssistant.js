// ========================================
// expensesAssistant.js - Rapport IA "optimiser mon cashflow" (page Dépenses)
// ========================================

import { auth } from './firebaseConfig.js';
import { GEMINI_PROXY_URL } from './config.js';
import { buildExpensesContext, formatExpensesContextAsText } from './expensesContext.js';

function formatGeminiText(text) {
  return (text || '')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
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
    if (!ctx) {
      outputEl.innerHTML = '<div class="empty-state">Pas assez de données bancaires pour analyser tes dépenses. Connecte une banque et laisse l\'historique se remplir un peu.</div>';
      return;
    }

    const dataText = formatExpensesContextAsText(ctx);
    const prompt = `Tu es un conseiller en budget personnel pour l'application Asset Tracker. Voici les données financières réelles de l'utilisateur (montants en euros) :

${dataText}

Rédige un rapport en français, concis, avec émojis et bullet points, structuré ainsi :
1. Une ligne de résumé : cashflow mensuel actuel, et une estimation réaliste du montant supplémentaire qu'il pourrait dégager chaque mois pour investir en bourse.
2. 3 à 5 actions concrètes et priorisées pour réduire les dépenses, en citant les postes/charges précis des données ci-dessus, avec le montant estimé économisable par mois pour chacune.
3. Une remarque sur les charges fixes qui semblent élevées, en doublon, ou renégociables (abonnements, assurances, télécom, énergie).
Ne donne aucun conseil sur quoi acheter en bourse (aucun ticker, aucun produit) : uniquement sur la capacité d'épargne mensuelle dégageable. Termine par une phrase rappelant que ce n'est pas un conseil financier réglementé.`;

    const res = await fetch(GEMINI_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok || data.error || !data.text) throw new Error(data.error || `HTTP ${res.status}`);

    outputEl.innerHTML = formatGeminiText(data.text);
  } catch (err) {
    console.error('[ExpensesAssistant] Error:', err);
    outputEl.innerHTML = `<div class="empty-state">Erreur pendant l'analyse (${err.message}). <button id="expenses-ai-retry-btn" class="btn btn-primary" style="margin-left:8px; padding:6px 12px;">Réessayer</button></div>`;
    document.getElementById('expenses-ai-retry-btn')?.addEventListener('click', analyze);
  } finally {
    if (btn) btn.disabled = false;
  }
}

btn?.addEventListener('click', analyze);
