// @vitest-environment jsdom
//
// BUG FOUND (audit sécurité, P1 — isolation multi-utilisateur) : le handler
// de déconnexion (src/sidebar.js) ne vidait que isAdmin/userModules/
// userBrokers — TOUTES les autres données mises en cache dans localStorage
// (purchases, currentData, watchlist, snapshot portefeuille...) survivaient à
// la déconnexion. Sur un appareil partagé (ordinateur familial, poste de
// travail commun), l'utilisateur SUIVANT à se connecter pouvait voir
// momentanément le portefeuille de l'utilisateur précédent, le temps que
// Firestore recharge les vraies données (rendu "cache-first" — voir
// dashboardApp.js::loadCachedData). Ce test simule tout le flux (bouton
// déconnexion réellement cliqué, sur le vrai module sidebar.js) et vérifie
// que le cache financier est bien vidé, en ne préservant que la préférence
// d'affichage pure `sidebarState`.
import { describe, it, expect, afterEach } from 'vitest';

describe('Déconnexion — isolation du cache financier entre utilisateurs (P1)', () => {
    afterEach(() => {
        localStorage.clear();
        document.body.innerHTML = '';
    });

    it('vide tout le localStorage financier à la déconnexion, sauf sidebarState', async () => {
        document.body.innerHTML = '<button id="auth-btn"></button><div id="app-sidebar"></div>';

        // Simule des données réelles laissées en cache par un utilisateur précédent.
        localStorage.setItem('purchases', JSON.stringify([{ ticker: 'AAPL', quantity: 10 }]));
        localStorage.setItem('currentData', JSON.stringify({ AAPL: { price: 200 } }));
        localStorage.setItem('watchlist', JSON.stringify(['TSLA']));
        localStorage.setItem('portfolio_snapshot_cache', JSON.stringify({ data: {} }));
        localStorage.setItem('sidebarState', 'true');
        localStorage.setItem('isAdmin', 'true');
        localStorage.setItem('userModules', JSON.stringify({ dashboard: true }));

        globalThis.firebase = {
            apps: [{}],
            initializeApp() { return {}; },
            app() { return {}; },
            auth() {
                return {
                    currentUser: { uid: 'user-1' },
                    onAuthStateChanged(cb) { cb({ uid: 'user-1' }); return () => {}; },
                    signOut() { return Promise.resolve(); }
                };
            },
            firestore() {
                return {
                    collection() {
                        return { doc() { return { get: async () => ({ exists: true, data: () => ({ isAdmin: false, modules: {} }) }) }; } };
                    }
                };
            }
        };

        delete window.location;
        window.location = { href: '' };

        await import('../src/sidebar.js');
        document.dispatchEvent(new Event('DOMContentLoaded'));
        await new Promise((r) => setTimeout(r, 0));

        const logoutBtn = document.getElementById('auth-btn');
        expect(logoutBtn).toBeTruthy();
        logoutBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        // Toutes les données financières/utilisateur doivent avoir disparu.
        expect(localStorage.getItem('purchases')).toBeNull();
        expect(localStorage.getItem('currentData')).toBeNull();
        expect(localStorage.getItem('watchlist')).toBeNull();
        expect(localStorage.getItem('portfolio_snapshot_cache')).toBeNull();
        expect(localStorage.getItem('isAdmin')).toBeNull();
        expect(localStorage.getItem('userModules')).toBeNull();

        // Seule la préférence d'affichage pure survit.
        expect(localStorage.getItem('sidebarState')).toBe('true');

        expect(window.location.href).toBe('login.html');
    });
});
