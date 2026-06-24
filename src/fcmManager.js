import { db, auth, VAPID_KEY } from './firebaseConfig.js';

/**
 * FCM Manager - Gère les tokens Firebase Cloud Messaging
 */
export class FCMManager {
    constructor() {
        this.messaging = null;
        this.currentToken = null;
        this.VAPID_KEY = VAPID_KEY;
    }

    /**
     * Initialize FCM
     */
    async init() {
        try {
            // Check if Firebase Messaging is available
            if (!firebase.messaging.isSupported()) {
                console.warn('[FCM] Firebase Messaging not supported in this browser');
                return false;
            }

            this.messaging = firebase.messaging();

            // Request permission
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.warn('[FCM] Notification permission denied');
                return false;
            }

            // Get FCM token
            this.currentToken = await this.getToken();
            if (this.currentToken) {
                console.log('[FCM] Token obtained:', this.currentToken);
                await this.saveTokenToFirestore(this.currentToken);

                // Setup foreground message handler
                this.setupForegroundHandler();

                return true;
            } else {
                console.warn('[FCM] No FCM token received');
                return false;
            }

        } catch (error) {
            console.error('[FCM] Initialization error:', error);
            return false;
        }
    }

    /**
     * Get FCM token
     */
    async getToken() {
        if (!this.messaging) {
            console.warn('[FCM] Messaging not initialized');
            return null;
        }

        try {
            console.log('[FCM] Registering Service Worker...');

            // 1. Enregistrer le SW explicitement
            const registration = await navigator.serviceWorker.register('../firebase-messaging-sw.js');
            console.log('[FCM] Service Worker registered with scope:', registration.scope);

            // 2. Attendre qu'il soit actif
            await navigator.serviceWorker.ready;
            console.log('[FCM] Service Worker ready');

            // 3. Demander le token avec le SW registration
            const token = await this.messaging.getToken({
                vapidKey: this.VAPID_KEY,
                serviceWorkerRegistration: registration
            });

            if (!token) {
                console.warn('[FCM] No Instance ID token available. Request permission to generate one.');
            }

            return token;
        } catch (error) {
            console.error('[FCM] Error getting token:', error);
            // Si erreur AbortError, c'est souvent un problème de config VAPID ou de réseau vers FCM
            if (error.code === 'messaging/token-subscribe-failed') {
                console.error('[FCM] Token subscribe failed. Check VAPID key and SW config.');
            }
            return null;
        }
    }

    /**
     * Save FCM token to Firestore user profile
     */
    async saveTokenToFirestore(token) {
        const user = auth.currentUser;
        if (!user) {
            console.warn('[FCM] No authenticated user to save token');
            return;
        }

        try {
            // Save to user's fcmTokens collection (permet multi-devices)
            await db.collection('users').doc(user.uid).collection('fcmTokens').doc(token).set({
                token: token,
                createdAt: Date.now(),
                lastUsed: Date.now(),
                userAgent: navigator.userAgent
            });

            console.log('[FCM] Token saved to Firestore');
        } catch (error) {
            console.error('[FCM] Error saving token:', error);
        }
    }

    /**
     * Handle foreground messages (when app is open)
     */
    onMessage(callback) {
        if (!this.messaging) return;

        this.messaging.onMessage((payload) => {
            console.log('[FCM] Foreground message received:', payload);

            // Call user's callback
            if (callback) {
                callback(payload);
            }

            // Display notification manually (Firebase doesn't auto-display in foreground)
            const title = payload.notification?.title || payload.data?.title || 'Asset Tracker';
            const options = {
                body: payload.notification?.body || payload.data?.body,
                icon: payload.notification?.icon || '/icons/android-chrome-192x192.png',
                badge: '/icons/android-chrome-192x192.png',
                vibrate: [200, 100, 200],
                tag: 'asset-tracker-alert'
            };

            if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then((registration) => {
                    registration.showNotification(title, options);
                });
            }
        });
    }

    /**
     * Get all FCM tokens for current user
     */
    async getUserTokens() {
        const user = auth.currentUser;
        if (!user) return [];

        try {
            const snapshot = await db.collection('users').doc(user.uid).collection('fcmTokens').get();
            return snapshot.docs.map(doc => doc.data().token);
        } catch (error) {
            console.error('[FCM] Error getting user tokens:', error);
            return [];
        }
    }

    /**
     * Delete a specific token
     */
    async deleteToken(token) {
        const user = auth.currentUser;
        if (!user) return;

        try {
            await db.collection('users').doc(user.uid).collection('fcmTokens').doc(token).delete();
            console.log('[FCM] Token deleted');
        } catch (error) {
            console.error('[FCM] Error deleting token:', error);
        }
    }

    /**
     * Refresh token (call periodically to keep it valid)
     */
    async refreshToken() {
        if (!this.messaging) return;

        try {
            await this.messaging.deleteToken();
            this.currentToken = await this.getToken();
            if (this.currentToken) {
                await this.saveTokenToFirestore(this.currentToken);
            }
        } catch (error) {
            console.error('[FCM] Error refreshing token:', error);
        }
    }
}
