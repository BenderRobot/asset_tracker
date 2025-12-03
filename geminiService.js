// geminiService.js - Version Proxy Sécurisée (Utilise GEMINI_PROXY_URL de config.js)

import { GEMINI_PROXY_URL } from './config.js';

function cleanText(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// Fonction interne unique pour appeler la Cloud Function
async function callGeminiProxy(prompt) {
    if (GEMINI_PROXY_URL.includes("VOTRE_URL")) {
        await new Promise(r => setTimeout(r, 500));
        return `<strong>Mode Démo :</strong> Proxy IA non configuré.`;
    }

    try {
        const response = await fetch(GEMINI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });
        
        if (!response.ok) throw new Error(`Proxy error: ${response.status}`);
        
        const data = await response.json();
        
        // Formatter la réponse comme votre application l'attend
        return data.text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');

    } catch (e) {
        console.error("Gemini Proxy Error:", e);
        return "Analyse indisponible (Erreur de connexion au serveur IA).";
    }
}

/**
 * Génère le résumé d'une news via le proxy sécurisé.
 */
export async function fetchGeminiSummary(context) {
    const prompt = `Tu es un analyste financier. Résume cette news en français (max 3 phrases). Contexte: "${cleanText(context)}"`;
    return callGeminiProxy(prompt);
}

/**
 * Fournit une analyse contextuelle (impact) via le proxy sécurisé.
 */
export async function fetchGeminiContext(title, summary, holdingDetails) {
    let portfolioContext = "";
    if (holdingDetails && holdingDetails.quantity > 0) {
        portfolioContext = `\n\n[Détails du Portefeuille pour ${holdingDetails.ticker}]: Vous détenez ${holdingDetails.quantity.toFixed(2)} unités. Valeur actuelle: ${holdingDetails.currentValue.toFixed(2)} €. Gain/Perte total: ${holdingDetails.gainEUR.toFixed(2)} € (${holdingDetails.gainPct.toFixed(2)}%).`;
    }
    
    // Le prompt intègre le contexte du portefeuille
    const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé et les détails de ton portefeuille, explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle. Concentre-toi sur la position actuelle : ${portfolioContext} Titre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;
    
    return callGeminiProxy(prompt);
}