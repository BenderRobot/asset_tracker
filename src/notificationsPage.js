import { auth } from './firebaseConfig.js';
import { DataManager } from './dataManager.js';
import { Storage } from './storage.js';
import { PriceAPI } from './api.js';
import { NotificationManager } from './NotificationManager.js';

class NotificationsPage {
    constructor() {
        this.storage = new Storage();
        // We pass storage to API, though API might not be heavily used here, DataManager needs it.
        this.api = new PriceAPI(this.storage);
        this.dataManager = new DataManager(this.storage, this.api);

        this.nm = new NotificationManager(this.dataManager);

        this.form = document.getElementById('add-rule-form');
        this.assetsSelect = document.getElementById('rule-asset');
        this.rulesList = document.getElementById('rules-list');

        this.init();
    }

    async init() {
        // DEBUG: Proof that the new JS is loaded
        // setTimeout(() => alert("🔔 Système de notifications v2 chargé !"), 1000);
        console.log('[NotificationsPage] Init...');

        // Auth Guard
        auth.onAuthStateChanged(async user => {
            if (user) {
                console.log('[NotificationsPage] User ready:', user.uid);

                // Initialize assets immediately from cache
                this.populateAssets();

                // Listen for fresh data from Storage sync
                window.addEventListener('purchases-updated', () => {
                    console.log('[NotificationsPage] Purchases updated, refreshing dropdown...');
                    this.populateAssets();
                });

                // Wait for NM to load settings/rules via its internal subscription
                this.subscribeToRulesUI(user.uid);
                this.bindSettingsEventListeners();

                // Load initial settings UI
                // We need to wait for NM settings to load.
                // Hacky retry:
                setTimeout(() => this.loadSettingsUI(), 1000);
                setTimeout(() => this.loadSettingsUI(), 3000);

            } else {
                window.location.href = 'login.html';
            }
        });

        // Form Submit
        if (this.form) {
            this.form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.addRule();
            });
        }
    }

    subscribeToRulesUI(uid) {
        if (this._unsubRules)    this._unsubRules();
        if (this._unsubSettings) this._unsubSettings();

        this._unsubRules = this.nm.db.collection('users').doc(uid).collection('notificationRules')
            .onSnapshot(snapshot => {
                const rules = [];
                snapshot.forEach(doc => {
                    rules.push({ id: doc.id, ...doc.data() });
                });
                this.renderRules(rules);
            });

        this._unsubSettings = this.nm.db.collection('users').doc(uid).collection('settings').doc('notifications')
            .onSnapshot(doc => {
                if (doc.exists) {
                    this.updateSettingsUI(doc.data());
                }
            });
    }

    updateSettingsUI(settings) {
        if (!settings) return;

        // Portfolio Global
        const portEnabled = document.getElementById('setting-portfolio-enabled');
        const portThreshold = document.getElementById('setting-portfolio-threshold');
        if (portEnabled && settings.portfolio) portEnabled.checked = settings.portfolio.enabled;
        if (portThreshold && settings.portfolio) portThreshold.value = settings.portfolio.threshold;

        // Indices
        const idxEnabled = document.getElementById('setting-indices-enabled');
        const idxThreshold = document.getElementById('setting-indices-threshold');
        if (idxEnabled && settings.indices) idxEnabled.checked = settings.indices.enabled;
        if (idxThreshold && settings.indices) idxThreshold.value = settings.indices.threshold;

        // Stocks
        const stocksEnabled = document.getElementById('setting-stocks-enabled');
        const stocksThreshold = document.getElementById('setting-stocks-threshold');
        if (stocksEnabled && settings.stocks) stocksEnabled.checked = settings.stocks.enabled;
        if (stocksThreshold && settings.stocks) stocksThreshold.value = settings.stocks.threshold;
    }

    // Fallback load
    loadSettingsUI() {
        this.updateSettingsUI(this.nm.settings);
    }

    bindSettingsEventListeners() {
        const updateSettings = async () => {
            const saveBtn = document.getElementById('save-settings-btn');
            if (saveBtn) {
                saveBtn.textContent = 'Enregistrement...';
                saveBtn.disabled = true;
            }

            const newSettings = {
                portfolio: {
                    enabled: document.getElementById('setting-portfolio-enabled')?.checked || false,
                    threshold: parseFloat(document.getElementById('setting-portfolio-threshold')?.value) || 1.0
                },
                indices: {
                    enabled: document.getElementById('setting-indices-enabled').checked,
                    threshold: parseFloat(document.getElementById('setting-indices-threshold').value) || 1.0
                },
                stocks: {
                    enabled: document.getElementById('setting-stocks-enabled').checked,
                    threshold: parseFloat(document.getElementById('setting-stocks-threshold').value) || 3.0
                }
            };

            try {
                await this.nm.saveSettings(newSettings);
                if (saveBtn) {
                    saveBtn.textContent = 'Enregistré !';
                    setTimeout(() => {
                        saveBtn.textContent = 'Enregistrer les paramètres';
                        saveBtn.disabled = false;
                    }, 2000);
                }
            } catch (e) {
                console.error("Save failed", e);
                if (saveBtn) {
                    saveBtn.textContent = 'Erreur';
                    saveBtn.disabled = false;
                }
            }
        };

        const saveBtn = document.getElementById('save-settings-btn');
        if (saveBtn) {
            saveBtn.addEventListener('click', updateSettings);
        }

        const testBtn = document.getElementById('test-notification-btn');
        if (testBtn) {
            testBtn.addEventListener('click', async () => {
                // ULTRA SIMPLE TEST: Does the button even work?
                alert("✅ Bouton cliqué ! Le code fonctionne.");

                // Now try notification
                try {
                    await this.nm.trigger('Test', 'Notification de test depuis Asset Tracker');
                } catch (e) {
                    alert("❌ Erreur: " + e.message);
                }
            });
        } else {
            console.error("[NotificationsPage] Test button NOT FOUND in DOM!");
        }

        // Keep auto-save for checkboxes ? Maybe better to rely only on button if user asked for "validate".
        // Let's keep it manual for thresholds, but maybe auto for checkboxes is fine.
        // For consistency with user request "validate", let's make it ALL manual via button.
        // It avoids confusion.
    }

    populateAssets() {
        if (!this.assetsSelect) return;
        this.assetsSelect.innerHTML = '';

        // 1. Portfolio Assets
        // Use storage directly to avoid DataManager issues
        const purchases = this.storage.getPurchases();
        const tickers = [...new Set(purchases.map(p => p.ticker))].sort();

        // Group: Portfolio
        const groupPortfolio = document.createElement('optgroup');
        groupPortfolio.label = "Portefeuille";
        tickers.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = t;
            groupPortfolio.appendChild(opt);
        });
        this.assetsSelect.appendChild(groupPortfolio);

        // 2. Indices / Crypto (Common)
        const groupIndices = document.createElement('optgroup');
        groupIndices.label = "Indices / Crypto (Suivis)";
        const commonIndices = ["BTC-EUR", "^GSPC", "^IXIC", "^STOXX50E", "^FCHI"];
        commonIndices.forEach(t => {
            if (!tickers.includes(t)) { // Avoid duplicates
                const opt = document.createElement('option');
                opt.value = t;
                opt.textContent = t;
                groupIndices.appendChild(opt);
            }
        });
        this.assetsSelect.appendChild(groupIndices);
    }

    renderRules(rules) {
        if (!this.rulesList) return;
        this.rulesList.innerHTML = '';

        if (rules.length === 0) {
            this.rulesList.innerHTML = '<div class="empty-state">Aucune règle personnalisée</div>';
            return;
        }

        rules.forEach(rule => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            item.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 15px; background: var(--bg-tertiary); border-radius: 8px; margin-bottom: 10px; border: 1px solid var(--border-color);";

            const conditionSymbol = rule.condition === 'greater' ? '>' : '<';
            const metricText = rule.metric === 'price' ? 'Prix' : '% Variation';
            const valueText = rule.metric === 'price' ? `${rule.value}` : `${rule.value}%`;

            item.innerHTML = `
                <div class="rule-info" style="font-size: 15px;">
                    <strong style="color: var(--text-primary);">${rule.asset}</strong> 
                    <span style="color: var(--text-secondary); margin: 0 8px;">•</span>
                    ${metricText} <strong style="color: var(--accent-color);">${conditionSymbol} ${valueText}</strong>
                </div>
                <button class="delete-rule-btn" data-id="${rule.id}" style="background: rgba(220, 53, 69, 0.1); border: none; color: var(--danger-color); cursor: pointer; padding: 8px; border-radius: 6px; transition: background 0.2s;">
                    <i class="fas fa-trash"></i>
                </button>
            `;

            this.rulesList.appendChild(item);
        });

        // Add Delete Listeners
        this.rulesList.querySelectorAll('.delete-rule-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                this.deleteRule(id);
            });
        });
    }

    async addRule() {
        const asset = document.getElementById('rule-asset').value;
        const metric = document.getElementById('rule-metric').value;
        const condition = document.getElementById('rule-condition').value;
        const value = document.getElementById('rule-value').value;

        if (!asset || !value) return;

        const rule = {
            asset,
            metric,
            condition,
            value: parseFloat(value),
            active: true
        };

        try {
            await this.nm.addRule(rule);
            this.form.reset();
        } catch (e) {
            alert("Erreur lors de l'ajout de la règle");
        }
    }

    async deleteRule(id) {
        if (confirm("Supprimer cette règle ?")) {
            await this.nm.deleteRule(id);
        }
    }
}

new NotificationsPage();
