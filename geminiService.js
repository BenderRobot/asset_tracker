// geminiService.js - Service centralisé (GCP PROXY)

import { GEMINI_PROXY_URL } from './config.js';

/**
 * Nettoie le texte pour l'utilisation dans les chaînes JSON ou les prompts.
 * @param {string} text - Le texte à nettoyer.
 */
function cleanText(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

/**
 * Appelle l'API Gemini pour générer un résumé.
 */
export async function fetchGeminiSummary(context) {
    // NOTE: La clé API est maintenant gérée côté GCP dans le proxy

    const prompt = `Tu es un analyste financier. Résume cette news en français (max 3 phrases). Contexte: "${cleanText(context)}"`;

    console.log('[fetchGeminiSummary] Starting...');
    console.log('[fetchGeminiSummary] GEMINI_PROXY_URL:', GEMINI_PROXY_URL);

    try {
        const response = await fetch(GEMINI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });

        console.log('[fetchGeminiSummary] Response status:', response.status, 'ok:', response.ok);

        if (response.ok) {
            const data = await response.json();
            console.log('[fetchGeminiSummary] Response data:', data);

            // Nouveau format simplifié du proxy: {text: "..."}
            if (data.text) {
                console.log('[fetchGeminiSummary] Success! Using simplified format');
                return data.text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }

            // Ancien format complet: {candidates: [{content: {parts: [{text: "..."}]}}]}
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                console.log('[fetchGeminiSummary] Success! Using full format');
                return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }

            console.warn('[fetchGeminiSummary] No text found in response');
        }
    } catch (e) {
        console.error('[fetchGeminiSummary] Exception:', e);
    }
    console.log('[fetchGeminiSummary] Returning fallback');
    return "Analyse indisponible.";
}

/**
 * Appelle l'API Gemini pour fournir une analyse contextuelle (impact).
 * @param {string} title - Le titre de l'article.
 * @param {string} summary - Le résumé principal de l'article.
 * @param {object} holdingDetails - Les détails du portefeuille de l'actif concerné.
 * @returns {Promise<string>} L'analyse contextuelle formatée en HTML.
 */
export async function fetchGeminiContext(title, summary, holdingDetails) {
    // NOTE: La clé API est maintenant gérée côté GCP dans le proxy

    // Construire le contexte du portefeuille
    let portfolioContext = "";
    if (holdingDetails && holdingDetails.quantity > 0) {
        portfolioContext = `\n\n[Détails du Portefeuille pour ${holdingDetails.ticker}]: Vous détenez ${holdingDetails.quantity.toFixed(2)} unités. Valeur actuelle: ${holdingDetails.currentValue.toFixed(2)} €. Gain/Perte total: ${holdingDetails.gainEUR.toFixed(2)} € (${holdingDetails.gainPct.toFixed(2)}%).`;
    }

    const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé et les détails de ton portefeuille, explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle. Concentre-toi sur la position actuelle (montant détenu, gain/perte) : ${portfolioContext}\nTitre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;

    try {
        const response = await fetch(GEMINI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });
        if (response.ok) {
            const data = await response.json();

            // Nouveau format simplifié du proxy: {text: "..."}
            if (data.text) {
                return data.text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }

            // Ancien format complet
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }
        }
    } catch (e) { console.warn("Gemini Context API Error:", e); }
    return "Analyse contextuelle indisponible.";
}