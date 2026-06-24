// geminiService.js - Service centralisé (Cloudflare Workers Proxy)

// URL du Worker Cloudflare (migration depuis GCP Cloud Run)
const GEMINI_PROXY_URL = 'https://asset-tracker-gemini.blaurens31.workers.dev';

/**
 * Nettoie le texte pour l'utilisation dans les prompts Gemini.
 * Supprime les balises HTML et les caractères de contrôle.
 * @param {string} text - Le texte à nettoyer.
 */
function cleanText(text) {
    if (typeof text !== 'string') return '';
    // Supprimer les balises HTML (résultat de fetchGeminiSummary qui formate en HTML)
    return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
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
        portfolioContext = `\n\n[Détails du Portefeuille GLOBAL (Tous comptes) pour ${holdingDetails.ticker}]: Vous détenez ${holdingDetails.quantity.toFixed(2)} unités au total. Valeur actuelle: ${holdingDetails.currentValue.toFixed(2)} €. Gain/Perte total: ${holdingDetails.gainEUR.toFixed(2)} € (${holdingDetails.gainPct.toFixed(2)}%).`;
    }

    const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé et les détails de ton portefeuille GLOBALE (tous comptes confondus), explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle. Concentre-toi sur la position totale (montant détenu, gain/perte) : ${portfolioContext}\nTitre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;

    try {
        const response = await fetch(GEMINI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '(impossible de lire la réponse)');
            console.error(`[fetchGeminiContext] Proxy HTTP ${response.status}:`, errText);
            return "Analyse contextuelle indisponible.";
        }

        const data = await response.json();

        // Format simplifié du proxy: {text: "..."}
        if (data.text) {
            return data.text
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
        }

        // Format complet (fallback)
        const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (fullText) {
            return fullText
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
        }

        console.warn('[fetchGeminiContext] Réponse reçue mais aucun texte trouvé:', data);
    } catch (e) {
        console.error('[fetchGeminiContext] Exception:', e);
    }
    return "Analyse contextuelle indisponible.";
}

/**
 * Appelle l'API Gemini pour fournir des conseils sur la diversification du portefeuille.
 * @param {object} portfolioData - Les données du portefeuille (score, assets, concentration, etc.)
 * @returns {Promise<string>} Les conseils de diversification formatés en HTML.
 */
export async function fetchGeminiDiversificationAdvice(portfolioData) {
    const {
        score,
        hhi,
        effectiveAssets,
        totalAssets,
        top3Weight,
        assetTypeBreakdown,
        heavyCount,
        largestPosition
    } = portfolioData;

    // Construire un prompt détaillé pour Gemini
    const breakdown = Object.entries(assetTypeBreakdown)
        .map(([type, data]) => `${type}: ${data.count} actifs (${data.weight.toFixed(1)}%)`)
        .join(', ');

    const prompt = `Tu es un conseiller financier expert en gestion de portefeuille. Analyse ce portefeuille et fournis 3-4 recommandations concrètes et actionnables pour optimiser la diversification:

Métriques actuelles:
- Score de diversification: ${score}/100
- Indice Herfindahl (HHI): ${hhi}
- Actifs effectifs: ${effectiveAssets} sur ${totalAssets} actifs au total
- Poids des 3 plus grandes positions: ${top3Weight.toFixed(1)}%
- Plus grande position: ${largestPosition.name} (${largestPosition.weight.toFixed(1)}%)
- Positions > 10%: ${heavyCount} actifs

Répartition par type:
${breakdown}

Fournis des conseils spécifiques en format liste à puces. Sois direct et actionnable. Focus sur: 
1) Rééquilibrage des positions trop concentrées
2) Types d'actifs sous-représentés
3) Stratégies pour améliorer le score

Réponds en français, maximum 150 mots.`;

    console.log('[fetchGeminiDiversificationAdvice] Starting...');

    try {
        const response = await fetch(GEMINI_PROXY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt })
        });

        if (response.ok) {
            const data = await response.json();

            // Format simplifié
            if (data.text) {
                return data.text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }

            // Format complet
            if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
                return data.candidates[0].content.parts[0].text.replace(/\n/g, '<br>').replace(/\*\*/g, '<strong>').replace(/__ /g, '</strong>');
            }
        }
    } catch (e) {
        console.error('[fetchGeminiDiversificationAdvice] Error:', e);
    }

    return "Conseils de diversification temporairement indisponibles. Votre score actuel suggère " +
        (score >= 70 ? "une bonne diversification." : score >= 40 ? "une diversification modérée - envisagez de réduire les positions concentrées." : "une faible diversification - il est recommandé de rééquilibrer votre portefeuille.");
}