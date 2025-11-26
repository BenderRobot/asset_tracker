// geminiService.js - Service centralisé (MODIFIÉ)

import { GEMINI_API_KEY } from './config.js';

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
 * (Cette fonction reste inchangée, elle n'a pas besoin des détails du portefeuille)
 */
export async function fetchGeminiSummary(context) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) {
        await new Promise(r => setTimeout(r, 500));
        return `<strong>Mode Démo :</strong> Clé API manquante.`;
    }

    const prompt = `Tu es un analyste financier. Résume cette news en français (max 3 phrases). Contexte: "${cleanText(context)}"`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        if (response.ok) {
            const data = await response.json();
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }
        }
    } catch (e) { console.warn("Gemini Summary API Error:", e); }
    return "Analyse indisponible.";
}

/**
 * Appelle l'API Gemini pour fournir une analyse contextuelle (impact).
 * @param {string} title - Le titre de l'article.
 * @param {string} summary - Le résumé principal de l'article.
 * @param {object} holdingDetails - NOUVEAU: Les détails du portefeuille de l'actif concerné.
 * @returns {Promise<string>} L'analyse contextuelle formatée en HTML.
 */
export async function fetchGeminiContext(title, summary, holdingDetails) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY.length < 20) return `<strong>Mode Démo :</strong> Clé API manquante.`;

    // NOUVEAU: Construire le contexte du portefeuille
    let portfolioContext = "";
    if (holdingDetails && holdingDetails.quantity > 0) {
        portfolioContext = `\n\n[Détails du Portefeuille pour ${holdingDetails.ticker}]: Vous détenez ${holdingDetails.quantity.toFixed(2)} unités. Valeur actuelle: ${holdingDetails.currentValue.toFixed(2)} €. Gain/Perte total: ${holdingDetails.gainEUR.toFixed(2)} € (${holdingDetails.gainPct.toFixed(2)}%).`;
    }
    
    // Le prompt intègre les données de l'actif détenu
    const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé et les détails de ton portefeuille, explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle. Concentre-toi sur la position actuelle (montant détenu, gain/perte) : ${portfolioContext}\nTitre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });
        if (response.ok) {
            const data = await response.json();
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }
        }
    } catch (e) { console.warn("Gemini Context API Error:", e); }
    return "Analyse contextuelle indisponible.";
}