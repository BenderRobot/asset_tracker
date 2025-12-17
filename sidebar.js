import { auth } from './firebaseConfig.js';

// sidebar.js – Version Zéro-Flash & Footer Fixe
const sidebar = document.getElementById('app-sidebar');
const toggleBtn = document.getElementById('sidebar-toggle');
const icon = toggleBtn ? toggleBtn.querySelector('i') : null;
const html = document.documentElement; // On cible <html>

if (sidebar && toggleBtn) {
    // Fonction pour mettre à jour l'UI (Icônes seulement, la largeur est gérée par CSS)
    function updateUI(isCollapsed) {
        if (isCollapsed) {
            if (icon) icon.className = 'fas fa-chevron-right';
        } else {
            if (icon) icon.className = 'fas fa-chevron-left';
        }
    }

    // Fonction de bascule
    function toggleSidebar() {
        const isCollapsed = html.classList.toggle('sidebar-collapsed');
        localStorage.setItem('sidebarState', isCollapsed);
        updateUI(isCollapsed);
    }

    // État initial (déjà géré par le script dans le head, on met juste à jour l'icône)
    const savedState = localStorage.getItem('sidebarState') === 'true';
    updateUI(savedState);

    // Event Listener Desktop
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });
}

// Mobile Sidebar Logic
document.addEventListener('DOMContentLoaded', () => {
    const mobileBtn = document.getElementById('mobile-menu-btn');
    const sidebarElement = document.getElementById('app-sidebar'); // Renamed to avoid specific conflict if any, though var scope is fine

    if (mobileBtn && sidebarElement) {
        console.log("Mobile Menu Initialized");

        mobileBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            console.log("Mobile Button Clicked");
            sidebarElement.classList.toggle('mobile-open');

            // Créer l'overlay s'il n'existe pas
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

            // Afficher/Masquer overlay
            if (sidebarElement.classList.contains('mobile-open')) {
                overlay.classList.add('show');
            } else {
                overlay.classList.remove('show');
            }
        });

        // Fermer sidebar si on clique sur un lien de navigation sur mobile
        const navLinks = sidebarElement.querySelectorAll('.nav-item');
        navLinks.forEach(link => {
            link.addEventListener('click', () => {
                if (window.innerWidth <= 768) {
                    sidebarElement.classList.remove('mobile-open');
                    const overlay = document.querySelector('.mobile-overlay');
                    if (overlay) overlay.classList.remove('show');
                }
            });
        });
    } else {
        console.log("Mobile elements not found", { mobileBtn: !!mobileBtn, sidebar: !!sidebarElement });
    }
});


// GESTION LOGIN / LOGOUT
// On attend que le DOM soit chargé pour être sûr que le bouton existe
document.addEventListener('DOMContentLoaded', () => {
    const authBtn = document.getElementById('auth-btn');
    if (authBtn) {
        auth.onAuthStateChanged(user => {
            console.log("Auth State Changed:", user ? "Logged In" : "Logged Out");

            if (user) {
                // Connecté -> Logout
                authBtn.innerHTML = `
                    <div class="nav-icon"><i class="fas fa-sign-out-alt"></i></div>
                    <span class="nav-text">Déconnexion</span>
                `;
                // On remplace le clone pour éviter les event listeners multiples
                const newBtn = authBtn.cloneNode(true);
                authBtn.parentNode.replaceChild(newBtn, authBtn);

                newBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    auth.signOut().then(() => {
                        window.location.href = 'login.html';
                    });
                });
            } else {
                // Déconnecté -> Login
                authBtn.innerHTML = `
                    <div class="nav-icon"><i class="fas fa-sign-in-alt"></i></div>
                    <span class="nav-text">Connexion</span>
                `;
                authBtn.href = "login.html";
            }
        });
    }
});