// ========================================
// marketStatus.js - (v3 - Fix Export & Status)
// ========================================

export class MarketStatus {
    constructor(storage) {
        this.storage = storage;
        this.containerId = null;
        this.badgeType = 'compact';
        this.autoRefreshInterval = null;
        this.currentBadgeHTML = '';
    }

    getStatus() {
        const now = new Date();
        const day = now.getDay(); // 0=Dim, 6=Sam
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const time = hours * 60 + minutes;

        // Weekend
        if (day === 6 || day === 0) {
            return {
                state: 'CLOSED',
                label: 'Marchés Fermés',
                shortLabel: 'Fermé',
                color: '#fbbf24', // Jaune
                dotClass: 'closed'
            };
        }

        // Semaine
        if (time < 9 * 60) {
            return {
                state: 'FUTURES',
                label: 'Pré-marché',
                shortLabel: 'Futures',
                color: '#60a5fa', // Bleu
                dotClass: 'futures'
            };
        }

        if (time >= 9 * 60 && time < 17 * 60 + 35) {
            return {
                state: 'OPEN',
                label: 'Marchés Ouverts',
                shortLabel: 'En direct',
                color: '#10b981', // Vert
                dotClass: 'open'
            };
        }

        if (time >= 17 * 60 + 35 && time < 22 * 60) {
            return {
                state: 'OPEN_US',
                label: 'US Ouvert',
                shortLabel: 'US Open',
                color: '#10b981', // Vert
                dotClass: 'open'
            };
        }

        return {
            state: 'FUTURES',
            label: 'Post-marché',
            shortLabel: 'Futures',
            color: '#8b5cf6', // Violet
            dotClass: 'futures'
        };
    }

    startAutoRefresh(containerId, badgeType = 'compact') {
        this.containerId = containerId;
        this.badgeType = badgeType;
        this._updateStatus();
        if (this.autoRefreshInterval) clearInterval(this.autoRefreshInterval);
        this.autoRefreshInterval = setInterval(() => this._updateStatus(), 60 * 1000);
    }

    _updateStatus() {
        const container = document.getElementById(this.containerId);
        if (!container) return;
        const status = this.getStatus();
        const newBadgeHTML = this.createCompactBadge(status);
        if (newBadgeHTML !== this.currentBadgeHTML) {
            container.innerHTML = newBadgeHTML;
            this.currentBadgeHTML = newBadgeHTML;
        }
    }

    createCompactBadge(status) {
        return `
            <span class="market-status-compact" style="
                display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600;
                color: ${status.color}; padding: 4px 8px; border: 1px solid var(--border-color);
                background: rgba(255, 255, 255, 0.03); border-radius: 6px;">
                <span style="width: 6px; height: 6px; border-radius: 50%; background: ${status.color}; box-shadow: 0 0 6px ${status.color};"></span>
                <span>${status.label}</span>
            </span>
        `;
    }
}

// === CORRECTION CRITIQUE : RÉ-EXPORT DE LA FONCTION HELPER ===
export function initMarketStatus(storage) {
    return new MarketStatus(storage);
}