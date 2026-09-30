// toast.js
// Notification visuelle non bloquante, partagée par les pages. Sert surtout à
// signaler les échecs d'écriture Firestore, autrefois seulement journalisés
// en console : la ligne supprimée « réapparaissait » sans explication.

const COLORS = { success: '#10b981', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
const STACK_ID = 'app-toast-stack';

function getStack() {
    let stack = document.getElementById(STACK_ID);
    if (!stack) {
        stack = document.createElement('div');
        stack.id = STACK_ID;
        stack.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px;max-width:min(420px,calc(100vw - 40px));';
        document.body.appendChild(stack);
    }
    return stack;
}

export function showToast(message, type = 'info', { duration } = {}) {
    const toast = document.createElement('div');
    toast.className = `notification notification-${type}`;
    // Une erreur interrompt les lecteurs d'écran ; le reste est annoncé poliment
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.textContent = message;
    toast.style.cssText = `
      padding: 15px 20px; background: ${COLORS[type] || COLORS.info}; color: white;
      border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.3); font-weight: 600;
      transition: opacity 0.3s;
    `;
    getStack().appendChild(toast);

    // Une erreur reste plus longtemps : l'utilisateur doit avoir le temps de la lire
    const visibleMs = duration ?? (type === 'error' ? 6000 : 3000);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, visibleMs);
}

// Message d'échec d'écriture lisible, sans jargon Firestore.
export function describeWriteError(error) {
    switch (error?.code) {
        case 'permission-denied': return 'accès refusé';
        case 'unavailable': return 'serveur injoignable, vérifiez votre connexion';
        case 'unauthenticated': return 'session expirée, reconnectez-vous';
        case 'not-found': return 'élément introuvable';
        default: return error?.message || 'erreur inconnue';
    }
}

export function showWriteError(action, error) {
    showToast(`Échec : ${action} (${describeWriteError(error)}). La modification a été annulée.`, 'error');
}
