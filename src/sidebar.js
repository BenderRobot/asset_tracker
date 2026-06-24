import { auth, db } from './firebaseConfig.js';
import logger from '../utils/logger.js';

// ── Sidebar HTML injection ─────────────────────────────────────────────────
// Single source of truth for sidebar markup — no more copy-paste across pages.

const NAV_ITEMS = [
    { href: 'dashboard.html',   icon: '🚀', label: 'Dashboard' },
    { href: 'investments.html', icon: '📈', label: 'Assets' },
    { href: 'index.html',       icon: '📋', label: 'Transactions' },
    { href: 'analytics.html',   icon: '📊', label: 'Analytics' },
    { href: 'watchlist.html',   icon: '👁️', label: 'Watchlist' },
    { href: 'screener.html',    icon: '🔍', label: 'Screener' },
    { href: 'news.html',        icon: '📰', label: 'News Feeds' },
    { href: 'realestate.html',  icon: '🏢', label: 'Immobilier' },
    { href: 'assistant.html',   icon: '🤖', label: 'Assistant IA' },
];

function buildSidebar() {
    const currentPage = window.location.pathname.split('/').pop() || 'index.html';

    const sidebarEl = document.getElementById('app-sidebar');
    const mobileHeaderEl = document.getElementById('mobile-header');

    if (sidebarEl && sidebarEl.children.length === 0) {
        const navHTML = NAV_ITEMS.map(({ href, icon, label }) =>
            `<a href="${href}" class="nav-item${href === currentPage ? ' active' : ''}">
                <div class="nav-icon">${icon}</div><span class="nav-text">${label}</span>
            </a>`
        ).join('');

        sidebarEl.innerHTML = `
            <div class="sidebar-header">
                <div class="nav-icon" style="display:flex;align-items:center;justify-content:center;">
                    <img src="/icons/android-chrome-192x192.png" alt="Logo" style="width:32px;height:32px;object-fit:contain;">
                </div>
                <span class="app-logo-text">Asset Tracker</span>
            </div>
            <nav class="sidebar-nav">
                ${navHTML}
                <a href="admin-invitations.html" class="nav-item" id="admin-invitations-link" style="display:none;">
                    <div class="nav-icon"><i class="fas fa-star"></i></div>
                    <span class="nav-text">Administration</span>
                </a>
            </nav>
            <div class="sidebar-settings">
                <div class="settings-title">Paramètres</div>
                <a href="settings.html" class="nav-item${currentPage === 'settings.html' ? ' active' : ''}">
                    <div class="nav-icon"><i class="fas fa-cog"></i></div>
                    <span class="nav-text">Paramètres</span>
                </a>
                <a href="#" class="nav-item" id="auth-btn">
                    <div class="nav-icon"><i class="fas fa-sign-out-alt"></i></div>
                    <span class="nav-text">Déconnexion</span>
                </a>
            </div>
            <div class="sidebar-footer">
                <button id="sidebar-toggle" title="Toggle Menu">
                    <i class="fas fa-chevron-left"></i>
                </button>
            </div>`;
    }

    if (mobileHeaderEl && mobileHeaderEl.children.length === 0) {
        mobileHeaderEl.innerHTML = `
            <button id="mobile-menu-btn" title="Menu"><i class="fas fa-bars"></i></button>
            <div class="mobile-logo" style="display:flex;align-items:center;margin-left:auto;margin-right:16px;">
                <img src="/icons/android-chrome-192x192.png" alt="Logo" style="height:24px;width:24px;margin-right:8px;">
                Asset Tracker
            </div>`;
    }
}

buildSidebar();

// ── Modules : application immédiate depuis localStorage ────────────────────
// loginApp.js sauvegarde les modules au moment de la connexion.
// sidebar.js les lit et les applique synchroniquement (pas d'appel Firestore ici).

const HREF_TO_MODULE = {
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

function applyModulesToNav(modules) {
    document.querySelectorAll('.sidebar-nav .nav-item').forEach(item => {
        const href = (item.getAttribute('href') || '').split('/').pop().split('?')[0];
        const moduleId = HREF_TO_MODULE[href];
        if (moduleId) {
            item.style.display = modules[moduleId] === false ? 'none' : '';
        }
    });
}

// Appliquer immédiatement (type="module" s'exécute après parsing DOM, avant DOMContentLoaded)
if (localStorage.getItem('isAdmin') !== 'true') {
    try {
        const modules = JSON.parse(localStorage.getItem('userModules'));
        if (modules) applyModulesToNav(modules);
    } catch (e) { /* ignore */ }
}

// ── Sidebar toggle ─────────────────────────────────────────────────────────
const sidebar = document.getElementById('app-sidebar');
const toggleBtn = document.getElementById('sidebar-toggle');
const icon = toggleBtn ? toggleBtn.querySelector('i') : null;
const html = document.documentElement;

if (sidebar && toggleBtn) {
    function updateUI(isCollapsed) {
        if (icon) icon.className = isCollapsed ? 'fas fa-chevron-right' : 'fas fa-chevron-left';
    }

    function toggleSidebar() {
        const isCollapsed = html.classList.toggle('sidebar-collapsed');
        localStorage.setItem('sidebarState', isCollapsed);
        updateUI(isCollapsed);
    }

    const savedState = localStorage.getItem('sidebarState') === 'true';
    updateUI(savedState);

    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });
}

// ── Mobile Sidebar ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const sidebarElement = document.getElementById('app-sidebar');

    if (mobileBtn && sidebarElement) {
        logger.debug('Mobile Menu Initialized');

        mobileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebarElement.classList.toggle('mobile-open');

            let overlay = document.querySelector('.mobile-overlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'mobile-overlay';
                document.body.appendChild(overlay);
                overlay.addEventListener('click', () => {
                    sidebarElement.classList.remove('mobile-open');
                    overlay.classList.remove('show');
                });
            }
            overlay.classList.toggle('show', sidebarElement.classList.contains('mobile-open'));
        });

        sidebarElement.querySelectorAll('.nav-item').forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    sidebarElement.classList.remove('mobile-open');
                    document.querySelector('.mobile-overlay')?.classList.remove('show');
                }
            });
        });
    }
});

// ── Auth / Logout + mise à jour des modules si changés par l'admin ─────────
document.addEventListener('DOMContentLoaded', () => {
    const authBtn = document.getElementById('auth-btn');
    const adminInvitationsLink = document.getElementById('admin-invitations-link');

    if (!authBtn) return;

    auth.onAuthStateChanged(async user => {
        if (user) {
            try {
                const snap = await db.collection('users').doc(user.uid).get();
                const data = snap.exists ? snap.data() : {};
                const isAdmin = data.isAdmin === true;
                localStorage.setItem('isAdmin', isAdmin);

                if (adminInvitationsLink && isAdmin) {
                    adminInvitationsLink.style.display = 'flex';
                }

                // Rafraîchir les modules depuis Firestore (pour refléter les changements admin)
                if (!isAdmin) {
                    const modules = data.modules || {};
                    const cached = localStorage.getItem('userModules');
                    const fresh = JSON.stringify(modules);
                    if (cached !== fresh) {
                        localStorage.setItem('userModules', fresh);
                        applyModulesToNav(modules);
                    }
                }
            } catch (e) {
                logger.debug('Could not refresh user data:', e);
            }

            // Bouton déconnexion
            authBtn.innerHTML = `
                <div class="nav-icon"><i class="fas fa-sign-out-alt"></i></div>
                <span class="nav-text">Déconnexion</span>
            `;
            const newBtn = authBtn.cloneNode(true);
            authBtn.parentNode.replaceChild(newBtn, authBtn);
            newBtn.addEventListener('click', (e) => {
                e.preventDefault();
                auth.signOut().then(() => {
                    localStorage.removeItem('isAdmin');
                    localStorage.removeItem('userModules');
                    localStorage.removeItem('userBrokers');
                    window.location.href = 'login.html';
                });
            });
        } else {
            if (adminInvitationsLink) adminInvitationsLink.style.display = 'none';
            localStorage.removeItem('isAdmin');
            localStorage.removeItem('userModules');
            localStorage.removeItem('userBrokers');
            authBtn.innerHTML = `
                <div class="nav-icon"><i class="fas fa-sign-in-alt"></i></div>
                <span class="nav-text">Connexion</span>
            `;
            authBtn.href = 'login.html';
        }
    });
});
