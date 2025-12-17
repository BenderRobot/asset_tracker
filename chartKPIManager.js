// ========================================
// chartKPIManager.js - Gestionnaire des KPIs du graphique
// ========================================

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
            dailyHist = await this.dataManager.getHistoryWithCache(
                ticker,
                dailyStartTs,
                Math.floor(Date.now() / 1000), // Up to NOW to capture today's candle
                '1d'
            );

            const dailyTimestamps = Object.keys(dailyHist).map(Number).sort((a, b) => a - b);

            // Robust Date Matching Strategy (Time-zone safe)
            // Determine if the last daily candle is "Today" (Current Session)
            const todayStartTs = new Date();
            todayStartTs.setHours(0, 0, 0, 0);
            const thresholdTs = todayStartTs.getTime() - (6 * 60 * 60 * 1000); // Allow start as early as 18:00 previous day (Forex)

            if (dailyTimestamps.length > 0) {
                const lastTs = dailyTimestamps[dailyTimestamps.length - 1];

                // If last candle is recent (>= Today 00:00 - 6h), it's the current session -> Take previous
                if (lastTs >= thresholdTs) {
                    if (dailyTimestamps.length >= 2) {
                        truePreviousClose = dailyHist[dailyTimestamps[dailyTimestamps.length - 2]];
                        console.log(`[ChartKPIManager ${ticker}] Last candle identified as TODAY (ts=${new Date(lastTs).toLocaleString()}). Using D-1.`);
                    }
                } else {
                    // Last candle is older (Yesterday or before) -> It IS the previous close
                    truePreviousClose = dailyHist[lastTs];
                    console.log(`[ChartKPIManager ${ticker}] Last candle identified as OLD/PREVIOUS (ts=${new Date(lastTs).toLocaleString()}). Using it.`);
                }
            }

            if (truePreviousClose) {
                console.log(`[ChartKPIManager ${ticker}] True Previous Close (Date Match):`, truePreviousClose);
            }
        } catch (e) {
            console.warn(`[ChartKPIManager ${ticker}] Failed to fetch true previous close (Daily):`, e);
        }

        // Fallback si pas de données pour aujourd'hui
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
                const fallbackDateStart = lastStartTs;
                // Trouver la bougie journalière juste avant ce jour de fallback
                const sortedDailyTs = Object.keys(dailyHist).map(Number).sort((a, b) => a - b);
                let bestPrevTs = null;
                for (let ts of sortedDailyTs) {
                    if (ts < fallbackDateStart) {
                        bestPrevTs = ts;
                    } else {
                        break;
                    }
                }
                if (bestPrevTs) {
                    truePreviousClose = dailyHist[bestPrevTs];
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
            statDayVar: document.getElementById('stat-day-var'),
            dayVarLabel: document.getElementById('day-var-label'),
            dayVarPercent: document.getElementById('day-var-percent'),
            statYesterdayClose: document.getElementById('stat-yesterday-close'),
            yesterdayCloseValue: document.getElementById('yesterday-close-value'),

            // Groupe 3 : START / END / HIGH / LOW
            priceStart: document.getElementById('price-start'),
            priceEnd: document.getElementById('price-end'),
            priceHigh: document.getElementById('price-high'),
            priceLow: document.getElementById('price-low')
        };
    }

    /**
     * Méthode principale pour mettre à jour tous les KPIs
     * @param {Object} config - Configuration contenant toutes les données nécessaires
     */
    updateKPIs(config) {
        const {
            isIndexMode,
            isSingleAsset,
            isUnitView,
            currentPeriod,
            perfAbs,
            perfPct,
            isPositive,
            vsYesterdayAbs,
            vsYesterdayPct,
            useTodayVar,
            referenceClose,
            finalYesterdayClose,
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
        this._updateBasicStats({ priceStart, priceEnd, priceHigh, priceLow, decimals });
        this._updateDailyStats({
            isIndexMode,
            isSingleAsset,
            isUnitView,
            currentPeriod,
            vsYesterdayAbs,
            vsYesterdayPct,
            useTodayVar,
            referenceClose,
            finalYesterdayClose,
            avgPrice,
            priceEnd,
            decimals
        });
    }

    /**
     * Met à jour les statistiques de performance (PERIOD RETURN)
     * @private
     */
    _updatePeriodReturn({ isIndexMode, currentPeriod, perfAbs, perfPct, isPositive, decimals }) {
        const { performanceLabel, performancePercent } = this.elements;

        // Pour le mode index en 1D, on masque ces stats car elles ne sont pas pertinentes
        // AFFICHER TOUJOURS : La logique de masquage pour Index 1D est supprimée
        if (performanceLabel) {
            const currencySymbol = isIndexMode ? '' : '€';
            performanceLabel.textContent = `${perfAbs > 0 ? '+' : ''}${perfAbs.toFixed(decimals)} ${currencySymbol}`;
            performanceLabel.className = 'value ' + (isPositive ? 'positive' : 'negative');
        }
        if (performancePercent) {
            performancePercent.textContent = `(${perfPct > 0 ? '+' : ''}${perfPct.toFixed(2)}%)`;
            performancePercent.className = 'pct ' + (isPositive ? 'positive' : 'negative');
        }
    }

    /**
     * Met à jour les statistiques de base (START / END / HIGH / LOW)
     * @private
     */
    _updateBasicStats({ priceStart, priceEnd, priceHigh, priceLow, decimals }) {
        const { priceStart: priceStartEl, priceEnd: priceEndEl, priceHigh: priceHighEl, priceLow: priceLowEl } = this.elements;

        if (priceStartEl) {
            if (priceStartEl.previousElementSibling) priceStartEl.previousElementSibling.textContent = "DÉBUT";
            priceStartEl.textContent = `${priceStart.toFixed(decimals)}`;
            priceStartEl.className = 'value';
        }
        if (priceEndEl) {
            if (priceEndEl.previousElementSibling) priceEndEl.previousElementSibling.textContent = "FIN";
            priceEndEl.textContent = `${priceEnd.toFixed(decimals)}`;
            priceEndEl.className = 'value';
        }
        if (priceHighEl) {
            if (priceHighEl.previousElementSibling) priceHighEl.previousElementSibling.textContent = "HAUT";
            priceHighEl.textContent = `${priceHigh.toFixed(decimals)}`;
            priceHighEl.className = 'value positive';
        }
        if (priceLowEl) {
            if (priceLowEl.previousElementSibling) priceLowEl.previousElementSibling.textContent = "BAS";
            priceLowEl.textContent = `${priceLow.toFixed(decimals)}`;
            priceLowEl.className = 'value negative';
        }
    }

    /**
     * Met à jour les statistiques journalières (VAR. JOUR / CLÔTURE HIER / PRIX UNITAIRE / PRU)
     * @private
     */
    _updateDailyStats({
        isIndexMode,
        isSingleAsset,
        isUnitView,
        currentPeriod,
        vsYesterdayAbs,
        vsYesterdayPct,
        useTodayVar,
        referenceClose,
        finalYesterdayClose,
        avgPrice,
        priceEnd,
        decimals
    }) {
        const { group2, statDayVar, dayVarLabel, dayVarPercent, statYesterdayClose, yesterdayCloseValue } = this.elements;

        // Créer ou récupérer les éléments statUnitPrice et statPru
        let statUnitPrice = document.getElementById('unit-price-row'); // Utiliser l'élément statique
        let statPru = document.getElementById('stat-pru-display');

        /*
        if (!statUnitPrice && group2) {
             // DÉSACTIVÉ : L'élément est maintenant statique dans dashboard.html
        }
        */
        if (!statPru && group2) {
            statPru = document.createElement('div');
            statPru.className = 'stat';
            statPru.id = 'stat-pru-display';
            statPru.innerHTML = `<span class="label">PRU</span><span class="value">0.00</span>`;
            group2.appendChild(statPru);
        }

        // Mode Index ou Vue Unitaire
        if (isIndexMode || isUnitView) {
            if (group2) group2.style.display = 'flex';
            if (statDayVar) statDayVar.style.display = 'none';
            if (statYesterdayClose) statYesterdayClose.style.display = 'none';

            // Masquer statUnitPrice en mode Index pour éviter la duplication
            if (statUnitPrice) {
                statUnitPrice.style.display = isIndexMode ? 'none' : 'flex';
                const label = statUnitPrice.querySelector('.label');
                const value = statUnitPrice.querySelector('.value');
                if (label) label.textContent = isIndexMode ? 'PRIX ACTUEL' : 'PRIX UNT';
                if (value) value.textContent = priceEnd !== null ? `${priceEnd.toFixed(decimals)}` : '-';
            }

            if (statPru) {
                if (!isIndexMode && isUnitView) {
                    statPru.style.display = 'flex';
                    const value = statPru.querySelector('.value');
                    if (value) {
                        value.textContent = `${avgPrice.toFixed(4)} €`;
                        value.style.color = '#FF9F43';
                    }
                } else {
                    statPru.style.setProperty('display', 'none', 'important');
                }
            }

            // Logique d'affichage des stats journalières de l'indice
            if (isIndexMode && currentPeriod === 1 && referenceClose) {
                if (statUnitPrice) statUnitPrice.style.display = 'none';
                if (statPru) statPru.style.setProperty('display', 'none', 'important');

                let dayClass = 'neutral';
                if (vsYesterdayAbs > 0.001) dayClass = 'positive';
                else if (vsYesterdayAbs < -0.001) dayClass = 'negative';

                if (statDayVar && statYesterdayClose && dayVarLabel && dayVarPercent && yesterdayCloseValue) {
                    dayVarLabel.innerHTML = `${vsYesterdayAbs > 0 ? '+' : ''}${vsYesterdayAbs.toFixed(decimals)}`;
                    dayVarPercent.innerHTML = `(${vsYesterdayPct > 0 ? '+' : ''}${vsYesterdayPct.toFixed(2)}%)`;
                    dayVarLabel.className = `value ${dayClass}`;
                    dayVarPercent.className = `pct ${dayClass}`;

                    const dayVarLabelEl = statDayVar.querySelector('.label');
                    if (dayVarLabelEl) dayVarLabelEl.textContent = 'VAR. JOUR';
                    statDayVar.style.display = 'flex';

                    yesterdayCloseValue.textContent = `${referenceClose.toFixed(decimals)}`;
                    const yesterdayCloseLabelEl = statYesterdayClose.querySelector('.label');
                    if (yesterdayCloseLabelEl) yesterdayCloseLabelEl.textContent = 'CLÔTURE HIER';
                    statYesterdayClose.style.display = 'flex';
                }
            }
        } else {
            // Mode Portfolio Global

            // Masquer ET vider les stats spécifiques aux indices
            if (statDayVar) {
                statDayVar.style.display = 'none';
                if (dayVarLabel) dayVarLabel.innerHTML = '';
                if (dayVarPercent) dayVarPercent.innerHTML = '';
            }
            if (statYesterdayClose) {
                statYesterdayClose.style.display = 'none';
                if (yesterdayCloseValue) yesterdayCloseValue.textContent = '';
            }
            if (statUnitPrice) {
                statUnitPrice.style.display = 'none';
                // Force empty content to prevent ghosting
                const label = statUnitPrice.querySelector('.label');
                const value = statUnitPrice.querySelector('.value');
                if (label) label.textContent = '';
                if (value) value.textContent = '';
                statUnitPrice.innerHTML = ''; // NUCLEAR OPTION: Vider complètement
            }
            if (statPru) {
                statPru.style.setProperty('display', 'none', 'important');
                const pruValue = statPru.querySelector('.value');
                if (pruValue) pruValue.textContent = '';
            }

            // On n'affiche les stats journalières que si période = 1
            if (currentPeriod !== 1) {
                if (group2) group2.style.display = 'none';
            } else {
                if (group2) group2.style.display = 'flex';

                if (statUnitPrice) statUnitPrice.style.display = 'none';
                if (statPru) statPru.style.setProperty('display', 'none', 'important');

                if (useTodayVar && statDayVar) {
                    let dayClass = 'neutral';

                    // Utiliser directement les valeurs du graphique (vsYesterdayAbs/Pct) pour cohérence avec la carte VAR TODAY
                    const displayVar = vsYesterdayAbs;
                    const displayPct = vsYesterdayPct;

                    if (displayVar > 0.001) dayClass = 'positive';
                    else if (displayVar < -0.001) dayClass = 'negative';

                    if (dayVarLabel && dayVarPercent) {
                        dayVarLabel.innerHTML = `${displayVar > 0 ? '+' : ''}${displayVar.toFixed(decimals)} €`;
                        dayVarPercent.innerHTML = `(${displayPct > 0 ? '+' : ''}${displayPct.toFixed(2)}%)`;
                        dayVarLabel.className = `value ${dayClass}`;
                        dayVarPercent.className = `pct ${dayClass}`;
                        statDayVar.style.display = 'flex';
                    }
                }
                if (referenceClose && statYesterdayClose) {
                    const labelEl = statYesterdayClose.querySelector('.label');

                    if (yesterdayCloseValue && labelEl) {
                        yesterdayCloseValue.textContent = `${referenceClose.toFixed(decimals)} €`;
                        labelEl.textContent = finalYesterdayClose ? 'CLÔTURE HIER' : 'OUVERTURE';
                        statYesterdayClose.style.display = 'flex';
                    }
                }
            }
        }
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
