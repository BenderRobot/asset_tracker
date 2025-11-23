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

    // Event Listener
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleSidebar();
    });
}