// ========================================
// marketStatus.js - (v2 - Auto-rafraîchissant)
// ========================================

export class MarketStatus {
    constructor(storage) {
        this.storage = storage;
        this.containerId = null;
        this.badgeType = 'compact'; // 'compact' ou 'full'
        this.autoRefreshInterval = null;
        this.currentBadgeHTML = ''; // Cache pour éviter les ré-écritures DOM inutiles
    }

    // Obtenir l'état actuel du marché (inchangé)
    getStatus() {
        const now = new Date();
        const day = now.getDay(); // 0 = Dimanche, 6 = Samedi
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const currentTime = hours * 60 + minutes;
        
        // Weekend
        if (day === 0 || day === 6) {
            return {
                isOpen: false,
                type: 'weekend',
                icon: '🌙',
                color: '#fbbf24', // Jaune
                message: 'Marchés fermés (weekend)',
                shortMessage: 'Fermé'
            };
        }
        
        // Horaires de bourse européenne : 9h00 - 17h30
        const marketOpen = 9 * 60; // 9h00
        const marketClose = 17 * 60 + 30; // 17h30
        
        if (currentTime < marketOpen) {
            return {
                isOpen: false,
                type: 'before',
                icon: '🌅',
                color: '#60a5fa', // Bleu
                message: 'Ouverture à 9h00',
                shortMessage: 'Pré-ouverture'
            };
        }
        
        if (currentTime >= marketClose) {
            return {
                isOpen: false,
                type: 'after',
                icon: '🌙',
                color: '#a78bfa', // Violet
                message: 'Prix de clôture',
                shortMessage: 'Clôture'
            };
        }
        
        return {
            isOpen: true,
            type: 'open',
            icon: '✓', // Note : L'icône ✓ est correcte, mais FontAwesome est peut-être nécessaire
            color: '#10b981', // Vert
            message: 'Marchés ouverts',
            shortMessage: 'En direct'
        };
    }

    // NOUVEAU : Lance le rafraîchissement automatique
    startAutoRefresh(containerId, badgeType = 'compact') {
        this.containerId = containerId;
        this.badgeType = badgeType;
        
        this.injectPulseAnimation(); // S'assure que l'animation est prête
        
        // Mettre à jour immédiatement
        this._updateStatus();
        
        // Arrêter l'ancien minuteur s'il existe
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }
        
        // Lancer le nouveau minuteur (toutes les 60 secondes)
        this.autoRefreshInterval = setInterval(() => this._updateStatus(), 60 * 1000);
    }
    
    // NOUVEAU : Méthode privée pour mettre à jour le DOM
    _updateStatus() {
        const container = document.getElementById(this.containerId);
        if (!container) return;

        const status = this.getStatus();
        
        // Utilise le badge compact (vu dans vos captures d'écran) par défaut
        const newBadgeHTML = (this.badgeType === 'compact') 
            ? this.createCompactBadge(status) 
            : this.createStatusBadge(status);

        // Optimisation : Ne met à jour le DOM que si le HTML a changé
        if (newBadgeHTML !== this.currentBadgeHTML) {
            container.innerHTML = newBadgeHTML;
            this.currentBadgeHTML = newBadgeHTML;
        }
    }

    // MODIFIÉ : Accepte l'objet 'status'
    createStatusBadge(status) {
        return `
            <div class="market-status-badge" style="
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 6px 12px;
                background: rgba(${this.hexToRgb(status.color)}, 0.15);
                border: 1px solid ${status.color};
                border-radius: 6px;
                font-size: 12px;
                font-weight: 600;
                color: ${status.color};
            ">
                <span style="font-size: 10px;">${status.icon}</span>
                <span>${status.message}</span>
            </div>
        `;
    }

    // MODIFIÉ : Accepte l'objet 'status'
    createCompactBadge(status) {
        // C'est ce badge que vous voyez dans vos captures d'écran
        return `
            <span class="market-status-compact" style="
                display: inline-flex;
                align-items: center;
                gap: 6px; /* Un peu plus d'espace */
                font-size: 12px; /* Un peu plus grand */
                font-weight: 600;
                color: ${status.color};
                padding: 5px 10px;
                background: rgba(${this.hexToRgb(status.color)}, 0.1);
                border-radius: 6px;
            ">
                <span style="
                    width: 7px;
                    height: 7px;
                    border-radius: 50%;
                    background: ${status.color};
                    ${status.isOpen ? 'animation: pulse 2s infinite;' : ''}
                "></span>
                <span>${status.message}</span>
            </span>
        `;
    }
    
    // ... (createPriceAgeBadge inchangé) ...
    
    // Convertir hex en rgb (inchangé)
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? 
            `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` :
            '59, 130, 246';
    }

    // Injecter le badge dans la page (MODIFIÉ)
    injectStatusBadge(containerId = 'market-status-container') {
        // Cette fonction est maintenant un alias pour startAutoRefresh
        this.startAutoRefresh(containerId, 'full');
    }

    // Animation pulse pour le point vert (inchangé)
    injectPulseAnimation() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
        `;
        document.head.appendChild(style);
    }
}

// Fonction helper pour afficher l'état dans le UI (MODIFIÉ)
export function initMarketStatus(storage) {
    // Ne fait plus que créer l'instance
    return new MarketStatus(storage);
}