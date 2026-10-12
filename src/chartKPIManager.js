// ========================================
// chartKPIManager.js - Gestionnaire des KPIs du graphique
// ========================================
import { resolveTickerPreviousClose } from './MarketUtils.js';

/**
 * Classe responsable de la gestion et de l'affichage des KPIs (statistiques)
 * sous le graphique historique. Sépare cette logique de historicalChart.js
 * pour améliorer la maintenabilité.
 */
export class ChartKPIManager {
    constructor(api, storage, dataManager, marketStatus) {
        // Dépendances nécessaires pour les nouvelles méthodes
        this.api = api;
        this.storage = storage;
        this.dataManager = dataManager;
        this.marketStatus = marketStatus;

        // Cache des éléments DOM pour éviter les recherches répétées
        this.elements = this._cacheElements();
    }

    /**
     * NOUVELLE MÉTHODE : Récupère les données d'un indice pour une période donnée
     * Utilise la même logique que le sparkline pour garantir la cohérence
     * @param {string} ticker - Le ticker de l'indice
     * @param {string} period - La période ('1D', '1W', '1M', etc.)
     * @returns {Promise<Object>} - Objet contenant timestamps, values, labels
     */
    async fetchIndexData(ticker, period = '1D', allowFallback = true) {
        // Pour l'instant, on gère uniquement la période 1D (comme le sparkline)
        // Les autres périodes utiliseront la logique existante de dataManager

        if (period !== '1D') {
            // Déléguer aux méthodes existantes pour les autres périodes
            const days = this._periodToDays(period);
            return await this.dataManager.calculateIndexData(ticker, days);
        }

        // LOGIQUE DU SPARKLINE (copiée depuis dashboardApp.js lignes 715-769)
        // Toujours essayer de récupérer les données d'aujourd'hui en premier.
        // Si elles sont vides (ex: matin avant ouverture), le fallback plus bas s'occupera de charger le dernier jour de trading.
        let displayDay = new Date();

        // Calcul du début de la journée affichée
        displayDay.setHours(0, 0, 0, 0);
        const startTs = Math.floor(displayDay.getTime() / 1000);
        const startTsMs = displayDay.getTime();

        const hist = await this.api.getHistoricalPricesWithRetry(
            ticker,
            startTs,
            Math.floor(Date.now() / 1000),
            '5m'
        );

        // Filtrer les points >= startTsMs
        let timestamps = Object.keys(hist)
            .map(Number)
            .filter(ts => ts >= startTsMs)
            .sort((a, b) => a - b);

        let values = timestamps.map(ts => hist[ts]);

        let truePreviousClose = null;
        let dailyHist = null; // Declare outside try block
        try {
            // Fetch last 7 days of daily data
            const dailyStartTs = startTs - (7 * 24 * 60 * 60);
            dailyHist = this.api.getCachedIndexDaily?.(ticker) || await this.dataManager.getHistoryWithCache(
                ticker,
                dailyStartTs,
                Math.floor(Date.now() / 1000), // Up to NOW to capture today's candle
                '1d'
            );

            // SINGLE SOURCE OF TRUTH — même résolveur que le portefeuille
            // (MarketUtils.resolveTickerPreviousClose), au lieu d'une classification
            // par seuil de 6h. On réutilise dailyHist déjà récupéré (aucun fetch
            // supplémentaire).
            const { closePrice } = await resolveTickerPreviousClose(ticker, {
                storage: this.storage,
                refDate: new Date(),
                historicalDataMap: dailyHist
            });
            truePreviousClose = closePrice;

            if (truePreviousClose) {
                console.log(`[ChartKPIManager ${ticker}] True Previous Close (Date Match):`, truePreviousClose);
            }
        } catch (e) {
            console.warn(`[ChartKPIManager ${ticker}] Failed to fetch true previous close (Daily):`, e);
        }

        // FALLBACK BINANCE : Si Yahoo Finance ne retourne pas de données pour aujourd'hui,
        // utiliser Binance (gratuit, sans auth) pour obtenir les vrais chandeliers 5m
        const isCryptoIndex = ticker.includes('-EUR') || ticker.includes('-USD') || ticker === 'BTC' || ticker === 'ETH';
        if (values.length === 0 && isCryptoIndex) {
            const midnightMs = new Date().setHours(0, 0, 0, 0);
            const nowMs = Date.now();
            console.log(`[ChartKPIManager] Yahoo vide pour ${ticker} → tentative Binance...`);
            try {
                const binancePrices = await this.api.fetchCryptoKlinesFromBinance(ticker, midnightMs, nowMs);
                if (Object.keys(binancePrices).length > 0) {
                    timestamps = Object.keys(binancePrices).map(Number).sort((a, b) => a - b);
                    values = timestamps.map(ts => binancePrices[ts]);
                    console.log(`[ChartKPIManager] ✅ Binance fallback OK pour ${ticker}: ${timestamps.length} points`);
                }
            } catch (err) {
                console.warn(`[ChartKPIManager] Binance fallback échoué pour ${ticker}:`, err.message);
            }
        }

        // Fallback si pas de données pour aujourd'hui → afficher le dernier jour de trading

        if (values.length === 0 && allowFallback) {

            let lastTradingDay = this.dataManager.getLastTradingDay(new Date());
            const todayCheck = new Date();
            if (lastTradingDay.toDateString() === todayCheck.toDateString()) {
                lastTradingDay.setDate(lastTradingDay.getDate() - 1);
                lastTradingDay = this.dataManager.getLastTradingDay(lastTradingDay);
            }
            lastTradingDay.setHours(0, 0, 0, 0);
            const lastStartTs = Math.floor(lastTradingDay.getTime() / 1000);
            const lastEndTs = lastStartTs + (24 * 60 * 60);

            const histLast = await this.api.getHistoricalPricesWithRetry(
                ticker,
                lastStartTs,
                lastEndTs,
                '5m'
            );

            // Recalculer le truePreviousClose pour ce jour de repli (J-1 par rapport au fallback)
            if (dailyHist) {
                const { closePrice: fallbackClose } = await resolveTickerPreviousClose(ticker, {
                    storage: this.storage,
                    refDate: lastTradingDay,
                    historicalDataMap: dailyHist
                });
                if (fallbackClose) {
                    truePreviousClose = fallbackClose;
                    console.log(`[ChartKPIManager ${ticker}] Fallback True Previous Close (D-2):`, truePreviousClose);
                }
            }

            timestamps = Object.keys(histLast)
                .map(Number)
                .sort((a, b) => a - b);
            values = timestamps.map(ts => histLast[ts]);
        }

        console.log(`[ChartKPIManager ${ticker}] Fetched ${values.length} data points`);

        return {
            timestamps,
            values,
            labels: timestamps.map(ts => new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })),
            truePreviousClose // Start using this in dashboardApp.js
        };
    }

    /**
     * NOUVELLE MÉTHODE : Génère le SVG du sparkline
     * @param {Object} data - Données retournées par fetchIndexData
     * @param {number} previousClose - Prix de clôture d'hier
     * @param {string} ticker - Le ticker (pour l'ID du gradient)
     * @param {string} indicatorColor - Couleur de l'indicateur
     * @returns {string} - HTML du sparkline
     */
    generateSparkline(data, previousClose, ticker, indicatorColor) {
        if (!data || !data.values || data.values.length < 2) {
            return '';
        }

        const values = data.values;
        const min = Math.min(...values);
        const max = Math.max(...values);
        const range = max - min || 1;

        const points = values
            .map((v, i) => {
                const x = (i / (values.length - 1)) * 100;
                const y = 88 - ((v - min) / range) * 70;
                return `${x},${y}`;
            })
            .join(' ');

        // Calculer la position Y de la ligne de clôture d'hier
        const closeY = 88 - ((previousClose - min) / range) * 70;

        const gradId = `grad-${ticker.replace(/[^a-z]/gi, '')}`;

        return `
            <div style="position:absolute; inset:0; opacity:0.38; pointer-events:none; overflow:hidden; border-radius:12px;">
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%; height:100%;">
                    <defs>
                        <linearGradient id="${gradId}" x1="0%" y1="100%" x2="0%" y2="0%">
                            <stop offset="0%" stop-color="${indicatorColor}" stop-opacity="0.7"/>
                            <stop offset="60%" stop-color="${indicatorColor}" stop-opacity="0.25"/>
                            <stop offset="100%" stop-color="${indicatorColor}" stop-opacity="0.05"/>
                        </linearGradient>
                    </defs>
                    <polyline fill="none" stroke="${indicatorColor}" stroke-width="1.6" points="${points}"/>
                    <polygon fill="url(#${gradId})" points="${points},100,100,100,0"/>
                    <!-- Ligne de clôture d'hier -->
                    <line x1="0" y1="${closeY}" x2="100" y2="${closeY}" stroke="#9fa6bc" stroke-width="0.8" stroke-dasharray="2,2" opacity="0.6"/>
                </svg>
            </div>`;
    }

    /**
     * NOUVELLE MÉTHODE : Convertit une période en nombre de jours
     * @private
     */
    _periodToDays(period) {
        const periodMap = {
            '1D': 1,
            '1W': 7,
            '1M': 30,
            '3M': 90,
            '1Y': 365,
            'ALL': 'all'
        };
        return periodMap[period] || 1;
    }

    /**
     * Cache tous les éléments DOM nécessaires pour l'affichage des KPIs
     * @private
     */
    _cacheElements() {
        return {
            // Groupe 1 : PERIOD RETURN
            performanceLabel: document.getElementById('performance-label'),
            performancePercent: document.getElementById('performance-percent'),

            // Groupe 2 : Stats journalières
            group2: document.querySelector('.stat-group-2'),
            unitPriceRow: document.getElementById('unit-price-row'),

            // Groupe 3 : START / END / HIGH / LOW
            priceStart: document.getElementById('price-start'),
            priceEnd: document.getElementById('price-end'),
            priceHigh: document.getElementById('price-high'),
            priceLow: document.getElementById('price-low')
        };
    }

    /**
     * Stats-bar number format, shared by every cell: French grouping and
     * decimal comma, € unless it is an index level. Prices shown with 4
     * decimals (unit/index views) keep them only below 1.
     * @private
     */
    _fmt(n, decimals, { isIndexMode = false, signed = false } = {}) {
        if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
        const value = Number(n);
        const digits = decimals > 2 && Math.abs(value) >= 1 ? 2 : decimals;
        const text = value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
        return `${signed && value > 0 ? '+' : ''}${text}${isIndexMode ? '' : ' €'}`;
    }

    _fmtPct(n) {
        if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
        const value = Number(n);
        return `${value > 0 ? '+' : ''}${value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
    }

    /**
     * Méthode principale pour mettre à jour tous les KPIs
     * @param {Object} config - Configuration contenant toutes les données nécessaires
     */
    updateKPIs(config) {
        // Responsive/cache-first rendering may replace the chart DOM. Refresh
        // references so a detached stats block cannot receive the new values
        // while the visible block stays at its initial 0.00 values.
        this.elements = this._cacheElements();
        const {
            isIndexMode,
            isSingleAsset,
            isUnitView,
            currentPeriod,
            perfAbs,
            perfPct,
            isPositive,
            priceStart,
            priceEnd,
            priceHigh,
            priceLow,
            avgPrice,
            decimals
        } = config;

        // Réinitialiser tous les KPIs avant mise à jour
        this._resetAllKPIs();

        // Mise à jour des différents groupes de KPIs
        this._updatePeriodReturn({ isIndexMode, currentPeriod, perfAbs, perfPct, isPositive, decimals });
        this._updateBasicStats({ priceStart, priceEnd, priceHigh, priceLow, decimals, isIndexMode });
        this._updateDailyStats({ isIndexMode, isUnitView, avgPrice, priceEnd, decimals });
    }

    /**
     * Met à jour les statistiques de performance (PERIOD RETURN)
     * @private
     */
    _updatePeriodReturn({ isIndexMode, currentPeriod, perfAbs, perfPct, isPositive, decimals }) {
        const { performanceLabel, performancePercent } = this.elements;
        const absPositive = perfAbs >= 0;
        const pctPositive = perfPct >= 0;

        // Pour le mode index en 1D, on masque ces stats car elles ne sont pas pertinentes
        // AFFICHER TOUJOURS : La logique de masquage pour Index 1D est supprimée
        if (performanceLabel) {
            performanceLabel.textContent = this._fmt(perfAbs, decimals, { isIndexMode, signed: true });
            performanceLabel.className = 'value ' + (absPositive ? 'positive' : 'negative');
        }
        // Own cell ("PERFORMANCE"), same size as every other value.
        if (performancePercent) {
            performancePercent.textContent = this._fmtPct(perfPct);
            performancePercent.className = 'value ' + (pctPositive ? 'positive' : 'negative');
        }
    }

    /**
     * Met à jour les statistiques de base (START / END / HIGH / LOW)
     * @private
     */
    _updateBasicStats({ priceStart, priceEnd, priceHigh, priceLow, decimals, isIndexMode = false }) {
        const { priceStart: priceStartEl, priceEnd: priceEndEl, priceHigh: priceHighEl, priceLow: priceLowEl } = this.elements;

        if (priceStartEl) {
            if (priceStartEl.previousElementSibling) priceStartEl.previousElementSibling.textContent = "DÉBUT";
            priceStartEl.textContent = this._fmt(priceStart, decimals, { isIndexMode });
            priceStartEl.className = 'value';
        }
        if (priceEndEl) {
            if (priceEndEl.previousElementSibling) priceEndEl.previousElementSibling.textContent = "FIN";
            priceEndEl.textContent = this._fmt(priceEnd, decimals, { isIndexMode });
            priceEndEl.className = 'value';
        }
        if (priceHighEl) {
            if (priceHighEl.previousElementSibling) priceHighEl.previousElementSibling.textContent = "HAUT";
            priceHighEl.textContent = this._fmt(priceHigh, decimals, { isIndexMode });
            priceHighEl.className = 'value positive';
        }
        if (priceLowEl) {
            if (priceLowEl.previousElementSibling) priceLowEl.previousElementSibling.textContent = "BAS";
            priceLowEl.textContent = this._fmt(priceLow, decimals, { isIndexMode });
            priceLowEl.className = 'value negative';
        }
    }

    /**
     * Prix unitaire et PRU de la vue actif (groupe 2 de la barre de stats).
     * « Var. jour » et « Clôture hier » ne sont plus affichés : en 1J ils
     * répétaient « Période » et « Début » (dashboard et Investments).
     * @private
     */
    _updateDailyStats({ isIndexMode, isUnitView, avgPrice, priceEnd, decimals }) {
        const { group2 } = this.elements;
        const statUnitPrice = document.getElementById('unit-price-row');
        let statPru = document.getElementById('stat-pru-display');
        if (!statPru && group2) {
            statPru = document.createElement('div');
            statPru.className = 'stat';
            statPru.id = 'stat-pru-display';
            statPru.innerHTML = `<span class="label">PRU</span><span class="value">0.00</span>`;
            group2.appendChild(statPru);
        }
        const showUnit = isUnitView && !isIndexMode;
        if (group2) group2.style.display = showUnit ? 'flex' : 'none';
        if (statUnitPrice) {
            statUnitPrice.style.display = showUnit ? 'flex' : 'none';
            const label = statUnitPrice.querySelector('.label');
            const value = statUnitPrice.querySelector('.value');
            if (label) label.textContent = 'PRIX';
            if (value) value.textContent = showUnit && priceEnd !== null ? this._fmt(priceEnd, decimals) : '—';
        }
        if (statPru) {
            if (showUnit) {
                statPru.style.display = 'flex';
                const value = statPru.querySelector('.value');
                if (value) {
                    value.textContent = this._fmt(avgPrice, 4);
                    value.style.color = '#FF9F43';
                }
            } else {
                statPru.style.setProperty('display', 'none', 'important');
            }
        }
    }

    /**
     * Groupe « ATH » de la barre de stats (#stat-group-ath). Formatage pur :
     * `details` vient de historicalChart._resolveAthReference, qui ne fait que
     * lire les séries au point localisé par dataManager.computeAthReference.
     * null (ligne ATH masquée / indisponible / vue € sans ATH) → groupe caché.
     * @param {Object|null} details
     */
    updateAthStats(details) {
        const group = document.getElementById('stat-group-ath');
        if (!group) return;
        // The stats bar switches to its 4-column layout only while ATH is shown.
        const showGroup = (visible) => {
            group.hidden = !visible;
            group.closest('.chart-stats-bar')?.classList.toggle('has-ath', visible);
        };
        if (!details) { showGroup(false); return; }
        // { loading: true }: all-time history still building — keep the block's
        // place with skeleton values (css/chart-toolbar.css) instead of popping
        // it in once the data lands.
        group.classList.toggle('is-loading', !!details.loading);
        group.setAttribute('aria-busy', String(!!details.loading));
        if (details.loading) {
            ['ath-total-value', 'ath-total-return', 'ath-date', 'ath-gap'].forEach(id => {
                const el = document.getElementById(id);
                if (el) { el.textContent = '—'; el.classList.remove('positive', 'negative'); }
            });
            const pctEl = document.getElementById('ath-total-return-pct');
            if (pctEl) pctEl.textContent = '';
            showGroup(true);
            return;
        }

        const eur = (n) => `${n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
        const signed = (n, text) => `${n >= 0 ? '+' : ''}${text}`;
        const pct = (n) => this._fmtPct(n);
        const setText = (id, text, tone = null) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = text;
            el.classList.toggle('positive', tone === 'positive');
            el.classList.toggle('negative', tone === 'negative');
        };
        const tone = (n) => (n === null ? null : (n >= 0 ? 'positive' : 'negative'));
        const setRow = (id, visible) => { const row = document.getElementById(id); if (row) row.hidden = !visible; };

        const isPrice = details.kind === 'price';
        setRow('ath-value-row', true);
        setText('ath-value-label', isPrice ? 'Prix ATH' : 'Total Value ATH');
        const headline = isPrice ? details.price : details.totalValue;
        setText('ath-total-value', headline !== null ? eur(headline) : '—');

        setRow('ath-return-row', !isPrice);
        if (!isPrice) {
            const r = details.totalReturn;
            setText('ath-total-return', r !== null ? signed(r, eur(r)) : '—', tone(r));
            setText('ath-total-return-pct', details.totalReturnPct !== null ? pct(details.totalReturnPct) : '', tone(details.totalReturnPct));
        }

        let dateText = '—';
        if (details.timestamp !== null) {
            const d = new Date(details.timestamp);
            dateText = details.intraday
                ? `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
                : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
        }
        setText('ath-date', dateText);

        // A monetary ATH is reached within half a cent. On a large portfolio,
        // a €1 difference may round to 0.00% even though it is below the peak.
        const gap = details.fromAthPct;
        const atAth = details.atAth ?? (gap !== null && gap > -0.005);
        const gapDigits = gap !== null && Math.abs(gap) < 0.0005 ? 5 : 3;
        const gapText = gap !== null && gap < 0 && gap > -0.005
            ? `${gap.toLocaleString('fr-FR', { minimumFractionDigits: gapDigits,
                maximumFractionDigits: gapDigits })} %`
            : pct(gap);
        setText('ath-gap', gap === null ? '—' : (atAth ? 'Au plus haut' : gapText), gap === null ? null : (atAth ? 'positive' : 'negative'));

        showGroup(true);
    }

    /**
     * Réinitialise tous les KPIs à leur état par défaut
     * @private
     */
    _resetAllKPIs() {
        // Cette méthode peut être étendue si nécessaire pour réinitialiser
        // complètement tous les éléments avant une mise à jour
    }
}
