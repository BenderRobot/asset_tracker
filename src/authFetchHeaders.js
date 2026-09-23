// SECURITY FIX (audit P0) — le Worker Gemini exige désormais un Firebase ID
// token valide (voir cloudflare-workers/gemini-worker/worker.js) ; ce petit
// helper est LE SEUL endroit qui construit l'en-tête Authorization envoyé par
// le client, pour que les 6 appelants (geminiService.js, assistantApp.js,
// expensesAssistant.js) l'obtiennent tous de la même façon plutôt que
// chacun sa propre logique.
import { auth } from './firebaseConfig.js';

// Retourne { Authorization: 'Bearer <idToken>' } si un utilisateur est
// connecté, sinon un objet vide (le Worker renverra alors 401 — c'est le
// comportement voulu : jamais d'appel "anonyme" silencieux vers une API
// facturée).
export async function getAuthHeader() {
    const user = auth.currentUser;
    if (!user) return {};
    try {
        const idToken = await user.getIdToken();
        return { Authorization: `Bearer ${idToken}` };
    } catch (e) {
        console.warn('[authFetchHeaders] getIdToken failed:', e.message);
        return {};
    }
}
