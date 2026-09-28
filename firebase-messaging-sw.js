// firebase-messaging-sw.js
// Service Worker FCM : reçoit les notifications push quand l'app n'est pas au
// premier plan. Enregistré par src/fcmManager.js ; doit rester à la racine
// publique pour couvrir toutes les pages (scope "/").
//
// Un Service Worker classique ne peut pas importer les modules ES de src/ :
// le SDK est chargé via importScripts, dans la même version compat que les
// pages (9.6.1), et la config est recopiée de src/firebaseConfig.js.

importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.6.1/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey: "AIzaSyBTOp0H9KbCAwhfbtG0IDQmVkOORbXpZiU",
    authDomain: "asset-tracker-479809-b80f1.firebaseapp.com",
    projectId: "asset-tracker-479809-b80f1",
    storageBucket: "asset-tracker-479809-b80f1.firebasestorage.app",
    messagingSenderId: "405474617830",
    appId: "1:405474617830:web:6d2388705df26dd5bb4e27"
});

const messaging = firebase.messaging();

const DEFAULT_ICON = '/icons/android-chrome-192x192.png';
const DEFAULT_URL = '/dashboard.html';

// Les messages contenant un bloc `notification` sont affichés automatiquement
// par le SDK en arrière-plan ; les afficher ici aussi créerait un doublon.
// Seuls les messages "data-only" sont donc rendus manuellement.
messaging.onBackgroundMessage((payload) => {
    if (payload.notification) return;

    const data = payload.data || {};
    return self.registration.showNotification(data.title || 'Asset Tracker', {
        body: data.body || '',
        icon: data.icon || DEFAULT_ICON,
        badge: DEFAULT_ICON,
        tag: data.tag || 'asset-tracker-alert',
        data: { url: data.url || DEFAULT_URL }
    });
});

// Clic sur une notification : réutilise un onglet de l'app s'il existe,
// sinon en ouvre un sur l'URL portée par le message.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(
        event.notification.data?.url || event.notification.data?.FCM_MSG?.data?.url || DEFAULT_URL,
        self.location.origin
    ).href;

    event.waitUntil((async () => {
        const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        const existing = windows.find(w => new URL(w.url).origin === self.location.origin);
        if (existing) {
            await existing.focus();
            if (existing.url !== target && 'navigate' in existing) await existing.navigate(target);
            return;
        }
        await clients.openWindow(target);
    })());
});
