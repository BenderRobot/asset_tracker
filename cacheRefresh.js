// Cache-Busting Refresh Handler
// Clears all caches and forces a hard reload

document.addEventListener('DOMContentLoaded', () => {
    const refreshBtn = document.getElementById('cache-refresh-btn');

    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            try {
                // 1. Clear all caches
                if ('caches' in window) {
                    const cacheNames = await caches.keys();
                    await Promise.all(
                        cacheNames.map(cacheName => caches.delete(cacheName))
                    );
                    console.log('All caches cleared');
                }

                // 2. Unregister service workers
                if ('serviceWorker' in navigator) {
                    const registrations = await navigator.serviceWorker.getRegistrations();
                    await Promise.all(
                        registrations.map(reg => reg.unregister())
                    );
                    console.log('Service workers unregistered');
                }

                // 3. Add timestamp to URL to force reload
                const url = new URL(window.location.href);
                url.searchParams.set('_nocache', Date.now());

                // 4. Reload the page
                window.location.href = url.toString();

            } catch (error) {
                console.error('Error clearing cache:', error);
                // Fallback: simple reload
                window.location.reload(true);
            }
        });
    }
});
