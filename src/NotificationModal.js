export class NotificationModal {
    constructor(notificationManager, dataManager) {
        this.nm = notificationManager;
        this.dm = dataManager;
        this.modal = document.getElementById('notification-modal');
        this.btn = document.getElementById('notifications-btn');
        this.closeBtn = document.getElementById('close-notification-modal');
        this.form = document.getElementById('add-rule-form');
        this.assetsSelect = document.getElementById('rule-asset');
        this.rulesList = document.getElementById('rules-list');

        this.init();
    }

    init() {
        console.log('[NotificationModal] Init...');
        if (!this.modal) console.error('[NotificationModal] Modal not found!');
        if (!this.btn) console.error('[NotificationModal] Button not found!');

        if (!this.modal || !this.btn) return;

        // Force initial state
        this.modal.style.display = 'none';

        // Open Modal
        this.btn.addEventListener('click', (e) => {
            console.log('[NotificationModal] Button clicked');
            e.preventDefault();
            this.open();
        });

        // Close Modal
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.close());
        }

        window.addEventListener('click', (e) => {
            if (e.target === this.modal) this.close();
        });

        // Form Submit
        if (this.form) {
            this.form.addEventListener('submit', (e) => {
                e.preventDefault();
                this.addRule();
            });
        }

        this.bindSettingsEventListeners();
        console.log('[NotificationModal] Initialized successfully');
    }

    open() {
        console.log('[NotificationModal] Opening...');
        try {
            this.populateAssets();
            this.renderRules();
        } catch (e) {
            console.error('[NotificationModal] Error rendering content:', e);
        }

        // Use CSS class for transition and flex display
        this.modal.style.display = 'flex';
        // Small timeout to allow display:flex to apply before adding class (for transition if any)
        setTimeout(() => {
            this.modal.classList.add('show');
        }, 10);

        this.loadSettingsUI();
    }

    loadSettingsUI() {
        const settings = this.nm.settings;
        if (!settings) return;

        // Indices
        const idxEnabled = document.getElementById('setting-indices-enabled');
        const idxThreshold = document.getElementById('setting-indices-threshold');
        if (idxEnabled) idxEnabled.checked = settings.indices.enabled;
        if (idxThreshold) idxThreshold.value = settings.indices.threshold;

        // Stocks
        const stocksEnabled = document.getElementById('setting-stocks-enabled');
        const stocksThreshold = document.getElementById('setting-stocks-threshold');
        if (stocksEnabled) stocksEnabled.checked = settings.stocks.enabled;
        if (stocksThreshold) stocksThreshold.value = settings.stocks.threshold;
    }

    bindSettingsEventListeners() {
        const updateSettings = () => {
            const newSettings = {
                indices: {
                    enabled: document.getElementById('setting-indices-enabled').checked,
                    threshold: parseFloat(document.getElementById('setting-indices-threshold').value) || 1.0
                },
                stocks: {
                    enabled: document.getElementById('setting-stocks-enabled').checked,
                    threshold: parseFloat(document.getElementById('setting-stocks-threshold').value) || 3.0
                }
            };
            this.nm.saveSettings(newSettings);
        };

        ['setting-indices-enabled', 'setting-indices-threshold', 'setting-stocks-enabled', 'setting-stocks-threshold'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.addEventListener('change', updateSettings);
        });
    }

    close() {
        console.log('[NotificationModal] Closing...');
        this.modal.classList.remove('show');
        setTimeout(() => {
            this.modal.style.display = 'none';
        }, 300); // Match transition duration
    }

    populateAssets() {
        if (!this.assetsSelect) return;
        this.assetsSelect.innerHTML = '';

        // 1. Portfolio Assets
        const purchases = this.dm.getPurchases();
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

    renderRules() {
        if (!this.rulesList) return;
        this.rulesList.innerHTML = '';

        const rules = this.nm.rules || [];

        if (rules.length === 0) {
            this.rulesList.innerHTML = '<div class="empty-state">Aucune règle personnalisée</div>';
            return;
        }

        rules.forEach(rule => {
            const item = document.createElement('div');
            item.className = 'rule-item';
            item.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px;";

            const conditionSymbol = rule.condition === 'greater' ? '>' : '<';
            const metricText = rule.metric === 'price' ? 'Prix' : '%';
            const valueText = rule.metric === 'price' ? `${rule.value}` : `${rule.value}%`;

            item.innerHTML = `
                <div class="rule-info">
                    <strong>${rule.asset}</strong>: ${metricText} ${conditionSymbol} ${valueText}
                </div>
                <button class="delete-rule-btn" data-id="${rule.id}" style="background: none; border: none; color: var(--danger-color); cursor: pointer;">
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
            this.renderRules(); // Will eventually update via snapshot, but instant feedback is nice. 
            // Actually, since it's firestore sync, we should wait for the snapshot update to re-render.
            // But for better UX, let's clear form.
            this.form.reset();
            // Let snapshot handle re-render.
        } catch (e) {
            alert("Erreur lors de l'ajout de la règle");
        }
    }

    async deleteRule(id) {
        if (confirm("Supprimer cette règle ?")) {
            await this.nm.deleteRule(id);
            // Snapshot will re-render
        }
    }
}
