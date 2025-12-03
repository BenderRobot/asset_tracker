import { auth } from './firebaseConfig.js';

// Vérifier l'état de connexion
auth.onAuthStateChanged(user => {
    if (!user) {
        // Si l'utilisateur n'est pas connecté, rediriger vers la page de login
        // On sauvegarde l'URL actuelle pour rediriger après le login (optionnel, à implémenter plus tard)
        window.location.href = 'login.html';
    }
});
