// sidebar.js – VERSION QUI MARCHE PARTOUT À 100%
const sidebar = document.getElementById('app-sidebar');
const toggleBtn = document.getElementById('sidebar-toggle');
const icon = toggleBtn?.querySelector('i');

if (sidebar && toggleBtn) {
    // Fonction qui gère TOUT (collapse + décalage + sauvegarde + hover)
    function setCollapsed(collapsed) {
        if (collapsed) {
            sidebar.classList.add('collapsed');
            document.body.classList.add('sidebar-collapsed');
            sidebar.style.width = '72px';
            if (icon) icon.classList.replace('fa-chevron-left', 'fa-chevron-right');
        } else {
            sidebar.classList.remove('collapsed');
            document.body.classList.remove('sidebar-collapsed');
            sidebar.style.width = '240px';
            if (icon) icon.classList.replace('fa-chevron-right', 'fa-chevron-left');
        }
        localStorage.setItem('sidebarState', collapsed);
    }

    // Charger l’état au démarrage
    const saved = localStorage.getItem('sidebarState') === 'true';
    setCollapsed(saved);

    // Clic sur le chevron
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        setCollapsed(!sidebar.classList.contains('collapsed'));
    });

    // HOVER EXPAND (le meilleur effet pro)
    sidebar.addEventListener('mouseenter', () => {
        if (sidebar.classList.contains('collapsed')) {
            sidebar.style.width = '240px';
        }
    });
    sidebar.addEventListener('mouseleave', () => {
        if (sidebar.classList.contains('collapsed')) {
            sidebar.style.width = '72px';
        }
    });
}