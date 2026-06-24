import { auth, db } from './firebaseConfig.js';

const PAGE_TO_MODULE = {
    'dashboard.html':   'dashboard',
    'investments.html': 'assets',
    'index.html':       'transactions',
    'analytics.html':   'analytics',
    'watchlist.html':   'watchlist',
    'screener.html':    'screener',
    'news.html':        'news',
    'realestate.html':  'realestate',
    'assistant.html':   'assistant',
};

auth.onAuthStateChanged(async user => {
    if (!user) {
        window.location.href = 'login.html';
        return;
    }

    // L'admin a accès à tout
    if (localStorage.getItem('isAdmin') === 'true') return;

    // Vérifier si cette page nécessite un module
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';
    const requiredModule = PAGE_TO_MODULE[currentPage];
    if (!requiredModule) return;

    try {
        const snap = await db.collection('users').doc(user.uid).get();
        const modules = snap.exists ? (snap.data().modules || {}) : {};
        if (modules[requiredModule] === false) {
            // Module désactivé → rediriger vers dashboard
            window.location.href = 'dashboard.html';
        }
    } catch (e) {
        // En cas d'erreur réseau, laisser l'accès (ne pas bloquer l'utilisateur)
    }
});
