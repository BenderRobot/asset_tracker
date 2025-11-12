// ========================================
// marketStatus.js - Indicateurs d'état du marché
// ========================================

export class MarketStatus {
    constructor(storage) {
        this.storage = storage;
    }

    // Obtenir l'état actuel du marché
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
                color: '#fbbf24',
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
                color: '#60a5fa',
                message: 'Ouverture Ã  9h00',
                shortMessage: 'Pré-ouverture'
            };
        }
        
        if (currentTime >= marketClose) {
            return {
                isOpen: false,
                type: 'after',
                icon: '🌙',
                color: '#a78bfa',
                message: 'Prix de clôture',
                shortMessage: 'Clôture'
            };
        }
        
        return {
            isOpen: true,
            type: 'open',
            icon: '✓',
            color: '#10b981',
            message: 'Marchés ouverts',
            shortMessage: 'En direct'
        };
    }

    // Créer un badge HTML pour l'état du marché
    createStatusBadge() {
        const status = this.getStatus();
        
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
                <span>${status.icon}</span>
                <span>${status.message}</span>
            </div>
        `;
    }

    // Badge compact pour le header
    createCompactBadge() {
        const status = this.getStatus();
        
        return `
            <span class="market-status-compact" style="
                display: inline-flex;
                align-items: center;
                gap: 4px;
                font-size: 11px;
                font-weight: 600;
                color: ${status.color};
            ">
                <span style="
                    width: 6px;
                    height: 6px;
                    border-radius: 50%;
                    background: ${status.color};
                    ${status.isOpen ? 'animation: pulse 2s infinite;' : ''}
                "></span>
                <span>${status.shortMessage}</span>
            </span>
        `;
    }

    // Badge d'Ã¢ge du prix pour un ticker
    createPriceAgeBadge(ticker) {
        const age = this.storage.getPriceAge(ticker);
        
        if (!age) return '';
        
        // Déterminer la couleur selon l'Ã¢ge
        let color = '#10b981'; // Vert (récent)
        let icon = '🕐';
        
        if (age.includes('jour')) {
            const days = parseInt(age);
            if (days >= 3) {
                color = '#ef4444'; // Rouge (vieux)
                icon = 'âš ï¸';
            } else {
                color = '#fbbf24'; // Jaune (modéré)
                icon = '🕐';
            }
        } else if (age.includes('h')) {
            const hours = parseInt(age);
            if (hours >= 6) {
                color = '#fbbf24'; // Jaune
                icon = '🕐';
            }
        }
        
        return `
            <span class="price-age-badge" style="
                display: inline-flex;
                align-items: center;
                gap: 3px;
                font-size: 10px;
                color: ${color};
                opacity: 0.8;
            " title="Dernière mise Ã  jour il y a ${age}">
                <span>${icon}</span>
                <span>${age}</span>
            </span>
        `;
    }

    // Convertir hex en rgb
    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? 
            `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` :
            '59, 130, 246';
    }

    // Injecter le badge dans la page
    injectStatusBadge(containerId = 'market-status-container') {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = this.createStatusBadge();
    }

    // Animation pulse pour le point vert
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

// Fonction helper pour afficher l'état dans le UI
export function initMarketStatus(storage) {
    const marketStatus = new MarketStatus(storage);
    marketStatus.injectPulseAnimation();
    return marketStatus;
}
