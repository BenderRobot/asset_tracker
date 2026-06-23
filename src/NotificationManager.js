import { db, auth } from './firebaseConfig.js';
import { getCompanyLogo } from './logoUtils.js';

export class NotificationManager {
    constructor(dataManager) {
        this.db = db;
        this.dataManager = dataManager;
        this.rules = [];
        this.unsubscribe = null;
        this.recentNotifications = new Map();
        this.hasPermission = false;

        this.settings = {
            portfolio: { enabled: true, threshold: 1.0 },
            indices: { enabled: true, threshold: 1.0 },
            stocks: { enabled: true, threshold: 3.0 }
        };

        this.tickerMap = {
            '^GSPC': 'S&P 500',
            '^IXIC': 'NASDAQ',
            '^FCHI': 'CAC 40',
            '^STOXX50E': 'EURO STOXX 50',
            'GC=F': 'Or (Gold)',
            'BTC-EUR': 'Bitcoin',
            'EURUSD=X': 'EUR/USD'
        };

        this.init();
    }

    getAssetName(ticker, data) {
        if (this.tickerMap[ticker]) return this.tickerMap[ticker];
        if (data && data.shortName) return data.shortName;
        return ticker;
    }

    async init() {
        this.requestPermission();

        auth.onAuthStateChanged(user => {
            if (user) {
                this.subscribeToRules(user.uid);
                this.loadSettings(user.uid);
            } else {
                this.rules = [];
                this.settings = {
                    portfolio: { enabled: true, threshold: 1.0 },
                    indices: { enabled: true, threshold: 1.0 },
                    stocks: { enabled: true, threshold: 3.0 }
                };
                if (this.unsubscribe) this.unsubscribe();
            }
        });
    }

    requestPermission() {
        if (!("Notification" in window)) {
            return;
        }

        if (Notification.permission === "granted") {
            this.hasPermission = true;
        } else if (Notification.permission !== "denied") {
            Notification.requestPermission().then(permission => {
                if (permission === "granted") {
                    this.hasPermission = true;
                }
            });
        }
    }

    subscribeToRules(uid) {
        if (this.unsubscribe) this.unsubscribe();

        this.unsubscribe = db.collection('users').doc(uid).collection('notificationRules')
            .onSnapshot(snapshot => {
                this.rules = [];
                snapshot.forEach(doc => {
                    this.rules.push({ id: doc.id, ...doc.data() });
                });
            });
    }

    loadSettings(uid) {
        db.collection('users').doc(uid).collection('settings').doc('notifications')
            .onSnapshot(doc => {
                if (doc.exists) {
                    this.settings = { ...this.settings, ...doc.data() };
                }
            });
    }

    async saveSettings(newSettings) {
        const user = auth.currentUser;
        if (!user) return;

        this.settings = { ...this.settings, ...newSettings };
        await db.collection('users').doc(user.uid).collection('settings').doc('notifications').set(this.settings, { merge: true });
    }

    checkAll(currentData, globalSummary = null) {
        if (!currentData || Object.keys(currentData).length === 0) return;

        if (globalSummary) {
            this.checkGlobalPortfolio(globalSummary);
        }

        this.checkGenericRules(currentData);
        this.checkCustomRules(currentData);
    }

    checkGlobalPortfolio(summary) {
        if (!this.settings.portfolio || !this.settings.portfolio.enabled) return;

        const pct = summary.dayChangePct;
        if (typeof pct === 'undefined' || pct === null) return;

        const absPct = Math.abs(pct);
        const threshold = this.settings.portfolio.threshold || 1.0;

        if (absPct >= threshold) {
            const direction = pct >= 0 ? "Hausse 🚀" : "Baisse 📉";
            this.triggerDebounced(
                `global_portfolio`,
                `Portefeuille Global: ${direction}`,
                `Votre portefeuille a varié de ${pct > 0 ? '+' : ''}${pct.toFixed(2)}% aujourd'hui.`,
                '/icons/android-chrome-192x192.png'
            );
        }
    }

    checkGenericRules(currentData) {
        Object.keys(currentData).forEach(ticker => {
            const data = currentData[ticker];
            let pct = data.changePercent;
            if (pct === undefined && data.regularMarketChangePercent !== undefined) pct = data.regularMarketChangePercent;

            if (typeof pct === 'undefined' || pct === null) return;

            const absPct = Math.abs(pct);
            const isIndex = ticker.startsWith('^') || ticker.endsWith('=F') || ticker.includes('index');

            if (isIndex && this.settings.indices && this.settings.indices.enabled && absPct >= this.settings.indices.threshold) {
                const name = this.getAssetName(ticker, data);
                const logo = getCompanyLogo(ticker, name);

                this.triggerDebounced(
                    `generic_${ticker}`,
                    `Market Movement: ${name}`,
                    `${name} has moved by ${pct.toFixed(2)}%`,
                    logo.hasLogo ? logo.url : null
                );
            }

            if (!isIndex && this.settings.stocks.enabled && absPct >= this.settings.stocks.threshold) {
                const name = this.getAssetName(ticker, data);
                const logo = getCompanyLogo(ticker, name);

                this.triggerDebounced(
                    `generic_${ticker}`,
                    `Asset Alert: ${name}`,
                    `${name} has moved by ${pct.toFixed(2)}%`,
                    logo.hasLogo ? logo.url : null
                );
            }
        });
    }

    checkCustomRules(currentData) {
        this.rules.forEach(rule => {
            const ticker = rule.asset;
            const data = currentData[ticker];

            if (!data) return;

            let metricValue;
            let displayValue;

            if (rule.metric === 'price') {
                metricValue = data.price;
                displayValue = `${metricValue} ${data.currency || ''}`;
            }
            else if (rule.metric === 'change') {
                metricValue = data.changePercent;
                if (metricValue === undefined) metricValue = data.regularMarketChangePercent;
                displayValue = `${metricValue ? metricValue.toFixed(2) : '?'}%`;
            }
            else return;

            if (metricValue === undefined || metricValue === null) return;

            let triggered = false;
            const threshold = parseFloat(rule.value);

            if (rule.condition === 'greater' && metricValue > threshold) triggered = true;
            if (rule.condition === 'less' && metricValue < threshold) triggered = true;

            if (triggered) {
                const name = this.getAssetName(ticker, data);
                const logo = getCompanyLogo(ticker, name);

                this.triggerDebounced(
                    `custom_${rule.id}`,
                    `Custom Alert: ${name}`,
                    `${name} is ${rule.condition} than ${rule.value} (Current: ${displayValue})`,
                    logo.hasLogo ? logo.url : null
                );
            }
        });
    }

    triggerDebounced(key, title, body, iconUrl = null) {
        const now = Date.now();
        const lastTime = this.recentNotifications.get(key) || 0;

        // Debounce: 60 minutes
        if (now - lastTime > 60 * 60 * 1000) {
            this.trigger(title, body, iconUrl);
            this.recentNotifications.set(key, now);
        }
    }

    async trigger(title, body, iconUrl = null) {
        if (Notification.permission !== 'granted') return;

        const absoluteIcon = iconUrl ?
            (iconUrl.startsWith('http') ? iconUrl : `${location.origin}${iconUrl}`) :
            `${location.origin}/icons/android-chrome-192x192.png`;

        const options = {
            body: body,
            icon: absoluteIcon,
            badge: `${location.origin}/icons/android-chrome-192x192.png`,
            vibrate: [200, 100, 200],
            requireInteraction: false,
            silent: false,
            tag: 'asset-tracker-alert',
            renotify: false,
            timestamp: Date.now()
        };

        try {
            if ('serviceWorker' in navigator) {
                const reg = await navigator.serviceWorker.ready;
                await reg.showNotification(title, options);
            }
        } catch (e) {
            console.error("Notification error:", e);
        }
    }

    async addRule(rule) {
        const user = auth.currentUser;
        if (!user) throw new Error("User not logged in");

        return await db.collection('users').doc(user.uid).collection('notificationRules').add({
            ...rule,
            createdAt: Date.now()
        });
    }

    async deleteRule(ruleId) {
        const user = auth.currentUser;
        if (!user) throw new Error("User not logged in");

        return await db.collection('users').doc(user.uid).collection('notificationRules').doc(ruleId).delete();
    }
}
