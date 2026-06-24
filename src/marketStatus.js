// ========================================
// marketStatus.js - v4 - Badge Global Intelligent (Europe 9h → US 22h)
// ========================================

export class MarketStatus {
    constructor(storage) {
        this.storage = storage;
        this.containerId = null;
        this.badgeType = 'compact';
        this.autoRefreshInterval = null;
        this.currentBadgeHTML = '';
    }

    // État GLOBAL de l'app : ouvert tant qu'Europe OU US est ouvert
    getGlobalStatus() {
        const now = new Date();
        const day = now.getDay();
        const parisMinutes = now.getHours() * 60 + now.getMinutes();

        // Week-end → tout fermé
        if (day === 0 || day === 6) {
            return {
                state: 'CLOSED',
                label: 'Marchés Fermés',
                shortLabel: 'Fermé',
                color: '#fbbf24',
                dotClass: 'closed'
            };
        }

        // 9h00 Paris → 22h00 Paris = au moins un des deux marchés est ouvert
        if (parisMinutes >= 9 * 60 && parisMinutes < 22 * 60) {
            return {
                state: 'OPEN',
                label: 'Marchés Ouverts',
                shortLabel: 'En direct',
                color: '#10b981',
                dotClass: 'open'
            };
        }

        // Entre 22h00 et 9h00 → Fermé (anciennement Futures)
        return {
            state: 'CLOSED',
            label: 'Marchés Fermés',
            shortLabel: 'Fermé',
            color: '#fbbf24',
            dotClass: 'closed'
        };
    }

    // Statut LOCAL par type d'actif (utilisé dans les cartes indices)
    getAssetStatus(ticker) {
        const now = new Date();
        const day = now.getDay();
        const parisMinutes = now.getHours() * 60 + now.getMinutes();
        const isWeekend = day === 0 || day === 6;

        // Crypto 24/7 : BTC-EUR, ETH-EUR, SOL-EUR, BNB-EUR, XRP-EUR...
        if (/^[A-Z]+-[A-Z]{3}$/.test(ticker)) {
            return { label: '24/7', color: '#f59e0b' };
        }

        // Forex 24/5 : *=X
        if (ticker.includes('=X')) {
            return { label: '24/5', color: '#06b6d4' };
        }

        // Commodities 24/5 : GC=F, SI=F, PL=F, HG=F, CL=F, BZ=F...
        if (ticker.endsWith('=F')) {
            return { label: '24/5', color: '#fbbf24' };
        }

        // Marchés US (NYSE/NASDAQ 9h30-16h NY = ~15h30-22h Paris)
        if (['^GSPC', '^IXIC', '^DJI', '^RUT'].includes(ticker)) {
            const ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const h = ny.getHours();
            const m = ny.getMinutes();
            const isOpen = (h > 9 || (h === 9 && m >= 30)) && h < 16;
            return {
                label: isWeekend || !isOpen ? 'CLOSED' : 'LIVE',
                color: isWeekend || !isOpen ? '#fbbf24' : '#10b981'
            };
        }

        // Marchés Europe (9h-17h35 Paris)
        if (['^FCHI', '^GDAXI', '^STOXX50E', '^FTSE', '^IBEX'].includes(ticker)) {
            const isOpen = parisMinutes >= 9 * 60 && parisMinutes < 17 * 60 + 35;
            return {
                label: isWeekend || !isOpen ? 'CLOSED' : 'LIVE',
                color: isWeekend || !isOpen ? '#fbbf24' : '#10b981'
            };
        }

        // Marchés asiatiques (heures approximatives en heure de Paris)
        if (ticker === '^N225' || ticker === '^HSI') {
            const isOpen = !isWeekend && parisMinutes >= 60 && parisMinutes < 10 * 60;
            return {
                label: isOpen ? 'LIVE' : 'CLOSED',
                color: isOpen ? '#10b981' : '#fbbf24'
            };
        }

        // Par défaut
        return { label: 'LIVE', color: '#10b981' };
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
        const status = this.getGlobalStatus();
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
                color: ${status.color}; padding: 5px 9px; border: 1px solid ${status.color}33;
                background: ${status.color}11; border-radius: 8px; backdrop-filter: blur(4px);
                box-shadow: 0 2px 6px rgba(0,0,0,0.2);">
                <span style="width: 7px; height: 7px; border-radius: 50%; background: ${status.color}; 
                             animation: pulse 2s infinite; box-shadow: 0 0 8px ${status.color};"></span>
                <span>${status.label}</span>
            </span>
            <style>@keyframes pulse { 0%,100% {opacity:0.7} 50% {opacity:1} }</style>
        `;
    }
}

export function initMarketStatus(storage) {
    return new MarketStatus(storage);
}