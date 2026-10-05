(function () {
    var page = window.location.pathname.split('/').pop() || 'index.html';

    var NAV = [
        { href: 'dashboard.html',   icon: '🚀', label: 'Dashboard' },
        { href: 'investments.html', icon: '📈', label: 'Assets' },
        { href: 'index.html',       icon: '📋', label: 'Transactions' },
        { href: 'expenses.html',    icon: '💸', label: 'Dépenses' },
        { href: 'analytics.html',   icon: '📊', label: 'Analytics' },
        { href: 'watchlist.html',   icon: '👁️', label: 'Watchlist' },
        { href: 'screener.html',    icon: '🔍', label: 'Screener' },
        { href: 'news.html',        icon: '📰', label: 'News Feeds' },
        { href: 'realestate.html',  icon: '🏢', label: 'Immobilier' },
        { href: 'assistant.html',   icon: '🤖', label: 'Assistant IA' },
    ];

    var navHTML = NAV.map(function (item) {
        var active = item.href === page ? ' active' : '';
        return '<a href="' + item.href + '" class="nav-item' + active + '">' +
               '<div class="nav-icon">' + item.icon + '</div>' +
               '<span class="nav-text">' + item.label + '</span></a>';
    }).join('');

    var settingsActive = page === 'settings.html' ? ' active' : '';

    var sidebar = document.getElementById('app-sidebar');
    if (sidebar && sidebar.children.length === 0) {
        sidebar.innerHTML =
            '<div class="sidebar-header">' +
              '<div class="nav-icon" style="display:flex;align-items:center;justify-content:center;">' +
                '<img src="/icons/android-chrome-192x192.png" alt="Logo" style="width:32px;height:32px;object-fit:contain;">' +
              '</div>' +
              '<span class="app-logo-text">Asset Tracker</span>' +
            '</div>' +
            '<nav class="sidebar-nav">' +
              navHTML +
              '<a href="admin-invitations.html" class="nav-item" id="admin-invitations-link" style="display:none;">' +
                '<div class="nav-icon"><i class="fas fa-star"></i></div>' +
                '<span class="nav-text">Administration</span>' +
              '</a>' +
            '</nav>' +
            '<div class="sidebar-settings">' +
              '<div class="settings-title">Paramètres</div>' +
              '<a href="settings.html" class="nav-item' + settingsActive + '">' +
                '<div class="nav-icon"><i class="fas fa-cog"></i></div>' +
                '<span class="nav-text">Paramètres</span>' +
              '</a>' +
              '<a href="#" class="nav-item" id="auth-btn">' +
                '<div class="nav-icon"><i class="fas fa-sign-out-alt"></i></div>' +
                '<span class="nav-text">Déconnexion</span>' +
              '</a>' +
            '</div>' +
            '<div class="sidebar-footer">' +
              '<span class="app-version" id="app-version" title="Version de l\'application"></span>' +
              '<button id="sidebar-toggle" title="Toggle Menu"><i class="fas fa-chevron-left"></i></button>' +
            '</div>';

        var versionElement = document.getElementById('app-version');
        if (versionElement && window.fetch) {
            fetch('/version.json', { cache: 'no-store' })
                .then(function (response) {
                    if (!response.ok) throw new Error('Version indisponible');
                    return response.json();
                })
                .then(function (release) {
                    if (!release || !release.version) return;
                    versionElement.textContent = 'v' + release.version;
                    versionElement.title = 'Version ' + release.version + ' · build Git ' + release.build;
                })
                .catch(function () {
                    // La navigation ne doit jamais dependre du fichier de version.
                });
        }
    }

    var header = document.getElementById('mobile-header');
    if (header && header.children.length === 0) {
        header.innerHTML =
            '<button id="mobile-menu-btn" title="Menu"><i class="fas fa-bars"></i></button>' +
            '<div class="mobile-logo" style="display:flex;align-items:center;margin-left:auto;margin-right:16px;">' +
              '<img src="/icons/android-chrome-192x192.png" alt="Logo" style="height:24px;width:24px;margin-right:8px;">' +
              'Asset Tracker' +
            '</div>';
    }
})();
