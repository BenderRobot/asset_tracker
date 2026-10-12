import { Storage } from './storage.js';
import { MortgageCalculator } from './mortgageCalculator.js';
import { DataManager } from './dataManager.js';
import { showWriteError } from './toast.js';

const DAY_MS = 1000 * 60 * 60 * 24;
const DEFAULT_PROJECT_DAYS = 365 * 2; // Durée supposée d'un projet sans échéance

// Couleurs des crédits (cycle) : bleu, vert, ambre, violet
const CREDIT_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6'];

const CHART_GRID = 'rgba(255, 255, 255, 0.05)';
const CHART_TICK = '#94a3b8';

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function formatMonthYear(date) {
    return date.toLocaleDateString('fr-FR', { month: '2-digit', year: 'numeric' });
}

// "18 ans 2 mois", "7 mois", "2 ans"
function formatDuration(totalMonths) {
    const months = Math.max(0, Math.round(totalMonths));
    const years = Math.floor(months / 12);
    const rest = months % 12;
    const parts = [];
    if (years > 0) parts.push(`${years} an${years > 1 ? 's' : ''}`);
    if (rest > 0 || years === 0) parts.push(`${rest} mois`);
    return parts.join(' ');
}

function formatPct(value, decimals = 1) {
    return `${value.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} %`;
}

export class RealEstateApp {
    constructor() {
        this.storage = new Storage();
        // Pas besoin d'api ici : seule calculateRealEstateAccrual (pure, sans I/O) est utilisée.
        this.dataManager = new DataManager(this.storage, null);
        this.chart = null;
        this.debtChart = null;
        // Scénario de remboursement anticipé / renégociation (simulation uniquement, non sauvegardé)
        this.debtScenario = { creditIndex: null, rate: '', extraMonthly: '', lumpSum: '', lumpMonth: '', mode: 'duration' };
    }

    async init() {
        console.log("RealEstateApp Initialized 🏢");

        // Charger la résidence depuis Firestore (synchronisation multi-appareils)
        await this.storage.loadPrimaryResidenceFromFirestore();

        await this.renderPrimaryResidence();
        await this.loadData();
        this.setupEventListeners();
    }

    // ========== CROWDFUNDING ==========

    async loadData() {
        const allPurchases = this.storage.getPurchases();

        // 1. Filtrer les projets Immo
        const projects = allPurchases.filter(p => p.assetType === 'Real Estate');

        if (projects.length === 0) {
            document.getElementById('projects-container').innerHTML = `
                <div class="re-empty">
                    <i class="ph ph-buildings" aria-hidden="true"></i>
                    <div>Aucun projet immobilier trouvé.</div>
                    <div>Ajoutez une transaction "Immobilier" pour commencer.</div>
                </div>`;
            document.getElementById('projects-count').textContent = '';
            this.renderCrowdfundingKPIs(null);
            document.getElementById('projection-section').style.display = 'none';
            return;
        }

        // 2. Calculer les valeurs pour chaque projet
        const today = new Date();

        const processedProjects = projects.map(p => {
            const startDate = new Date(p.date);
            const yieldPct = toNumber(p.yield);
            const maturityDate = p.maturityDate ? new Date(p.maturityDate) : null;

            // Calcul Intérêts Courus (Simple Interest) — SINGLE SOURCE OF TRUTH
            const { invested, accrued, currentValue: currentVal, daysHeld } = this.dataManager.calculateRealEstateAccrual(p, today);

            // Avancement (durée écoulée / durée totale)
            const durationDays = maturityDate
                ? Math.max(1, (maturityDate - startDate) / DAY_MS)
                : DEFAULT_PROJECT_DAYS;
            const progress = maturityDate
                ? Math.min(100, Math.max(0, (daysHeld / durationDays) * 100))
                : 0;

            // Intérêts attendus sur toute la durée (même formule simple que l'accrual)
            const expectedInterest = invested * (yieldPct / 100) * (durationDays / 365);
            const maturityValue = invested + expectedInterest;

            let status = 'active';
            if (startDate > today) status = 'upcoming';
            else if (maturityDate && maturityDate < today) status = 'matured';

            const daysToMaturity = maturityDate ? (maturityDate - today) / DAY_MS : null;

            return {
                ...p,
                invested,
                currentVal,
                accrued,
                yieldPct,
                progress,
                startDate,
                maturityDate,
                durationDays,
                expectedInterest,
                maturityValue,
                status,
                daysToMaturity
            };
        });

        // Échéances les plus proches d'abord, projets sans échéance à la fin
        processedProjects.sort((a, b) => (a.maturityDate || Infinity) - (b.maturityDate || Infinity));

        const totalInvested = processedProjects.reduce((s, p) => s + p.invested, 0);
        const totalCurrent = processedProjects.reduce((s, p) => s + p.currentVal, 0);
        const totalMaturity = processedProjects.reduce((s, p) => s + p.maturityValue, 0);
        const weightedYieldSum = processedProjects.reduce((s, p) => s + p.yieldPct * p.invested, 0);
        const avgYield = totalInvested > 0 ? (weightedYieldSum / totalInvested) : 0;
        const nextMaturity = processedProjects.find(p => p.maturityDate && p.maturityDate >= today) || null;
        const maturedCount = processedProjects.filter(p => p.status === 'matured').length;

        // 3. Mettre à jour l'UI
        this.renderCrowdfundingKPIs({
            totalInvested,
            totalCurrent,
            totalAccrued: totalCurrent - totalInvested,
            totalMaturity,
            avgYield,
            nextMaturity,
            maturedCount
        });
        document.getElementById('projects-count').textContent =
            `${processedProjects.length} projet${processedProjects.length > 1 ? 's' : ''}`;
        this.renderProjectCards(processedProjects);
        this.renderProjectionChart(processedProjects);
    }

    renderCrowdfundingKPIs(stats) {
        const container = document.getElementById('crowdfunding-kpis');
        if (!container) return;
        const s = stats || {
            totalInvested: 0, totalCurrent: 0, totalAccrued: 0, totalMaturity: 0,
            avgYield: 0, nextMaturity: null, maturedCount: 0
        };

        const accruedPct = s.totalInvested > 0 ? (s.totalAccrued / s.totalInvested) * 100 : 0;
        const expectedInterest = s.totalMaturity - s.totalInvested;
        const annualIncome = s.totalInvested * (s.avgYield / 100);
        const gainClass = s.totalAccrued > 0 ? 'is-positive' : (s.totalAccrued < 0 ? 'is-negative' : '');
        const gainSign = s.totalAccrued > 0 ? '+' : '';

        const nextMaturityMeta = s.nextMaturity
            ? `Prochaine échéance : <strong>${s.nextMaturity.maturityDate.toLocaleDateString('fr-FR')}</strong>`
            : 'Aucune échéance à venir';

        container.innerHTML = `
            <div class="re-kpi re-kpi--accent">
                <div class="re-kpi-label">Valeur actuelle</div>
                <div class="re-kpi-value">${this.formatEUR(s.totalCurrent, 2)}</div>
                <div class="re-kpi-meta">Investi : <strong>${this.formatEUR(s.totalInvested, 2)}</strong></div>
            </div>
            <div class="re-kpi">
                <div class="re-kpi-label">Intérêts courus</div>
                <div class="re-kpi-value ${gainClass}">${gainSign}${this.formatEUR(s.totalAccrued, 2)}</div>
                <div class="re-kpi-meta">${gainSign}${formatPct(accruedPct)} depuis l'investissement</div>
            </div>
            <div class="re-kpi">
                <div class="re-kpi-label">Rendement moyen</div>
                <div class="re-kpi-value">${formatPct(s.avgYield, 2)}</div>
                <div class="re-kpi-meta">Pondéré · ≈ ${this.formatEUR(annualIncome)}/an</div>
            </div>
            <div class="re-kpi">
                <div class="re-kpi-label">Valeur à l'échéance</div>
                <div class="re-kpi-value">${this.formatEUR(s.totalMaturity, 2)}</div>
                <div class="re-kpi-meta">+${this.formatEUR(expectedInterest, 2)} d'intérêts · ${nextMaturityMeta}</div>
            </div>
            ${s.maturedCount > 0 ? `
            <div class="re-alert">
                <i class="ph ph-warning" aria-hidden="true"></i>
                ${s.maturedCount} projet${s.maturedCount > 1 ? 's ont' : ' a'} dépassé l'échéance : vérifiez le remboursement auprès de la plateforme.
            </div>` : ''}
        `;
    }

    renderProjectCards(projects) {
        const container = document.getElementById('projects-container');
        container.innerHTML = '';

        projects.forEach(p => {
            const maturityStr = p.maturityDate ? p.maturityDate.toLocaleDateString('fr-FR') : 'N/A';

            let statusBadge = '';
            let timeLeft = '';
            if (p.status === 'matured') {
                statusBadge = '<span class="re-badge re-badge--warning">Échu</span>';
                timeLeft = 'Remboursement attendu';
            } else if (p.status === 'upcoming') {
                statusBadge = '<span class="re-badge re-badge--muted">À venir</span>';
                timeLeft = `Démarre le ${p.startDate.toLocaleDateString('fr-FR')}`;
            } else if (p.daysToMaturity !== null) {
                timeLeft = `Échéance dans ${formatDuration(p.daysToMaturity / 30.44)}`;
            } else {
                timeLeft = 'Échéance non renseignée';
            }

            const card = document.createElement('div');
            card.className = `project-card${p.status === 'matured' ? ' is-matured' : ''}`;
            card.innerHTML = `
                <div class="project-header">
                    <div class="project-title-block">
                        <div class="project-title">${escapeHtml(p.name)}</div>
                        <div class="project-subtitle">${escapeHtml(p.ticker || 'Réf. ?')}</div>
                    </div>
                    <div class="project-tags">
                        ${statusBadge}
                        <div class="project-tag">${formatPct(p.yieldPct, 2)}</div>
                    </div>
                </div>

                <div class="project-stats">
                    <div>
                        <div class="stat-label">Investi</div>
                        <div class="stat-val">${this.formatEUR(p.invested, 2)}</div>
                    </div>
                    <div class="is-right">
                        <div class="stat-label">Valeur actuelle</div>
                        <div class="stat-val is-positive">${this.formatEUR(p.currentVal, 2)}</div>
                    </div>
                    <div>
                        <div class="stat-label">Intérêts courus</div>
                        <div class="stat-val is-positive">+${this.formatEUR(p.accrued, 2)}</div>
                    </div>
                    <div class="is-right">
                        <div class="stat-label">À l'échéance</div>
                        <div class="stat-val">${this.formatEUR(p.maturityValue, 2)}</div>
                    </div>
                </div>

                <div class="re-progress" title="Avancement : ${p.progress.toFixed(1)} %">
                    <div class="re-progress-bar" style="width: ${p.progress}%"></div>
                </div>
                <div class="re-progress-meta">
                    <span>${p.progress.toFixed(0)} % de la durée</span>
                    <span>${timeLeft}</span>
                </div>

                <div class="project-dates">
                    <div>
                        <div class="stat-label">Début</div>
                        <div>${p.startDate.toLocaleDateString('fr-FR')}</div>
                    </div>
                    <div class="is-right">
                        <div class="stat-label">Échéance</div>
                        <div>${maturityStr}</div>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    renderProjectionChart(projects) {
        const canvas = document.getElementById('projection-chart');
        if (!canvas || projects.length === 0) return;
        document.getElementById('projection-section').style.display = '';

        const today = new Date();
        const maturityOf = p => p.maturityDate || new Date(p.startDate.getTime() + DEFAULT_PROJECT_DAYS * DAY_MS);

        const minDate = new Date(Math.min(...projects.map(p => p.startDate)));
        const maxDate = new Date(Math.max(...projects.map(maturityOf)));
        // Au moins 1 an de projection après aujourd'hui si tout est échu
        if (maxDate < today) maxDate.setTime(today.getTime() + 365 * DAY_MS);

        // Points : chaque mois + dates clés (débuts, échéances, aujourd'hui)
        // pour que les marches et les plateaux tombent pile au bon jour.
        const timestamps = new Set();
        const iter = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
        while (iter <= maxDate) {
            if (iter >= minDate) timestamps.add(iter.getTime());
            iter.setMonth(iter.getMonth() + 1);
        }
        projects.forEach(p => {
            timestamps.add(p.startDate.getTime());
            timestamps.add(maturityOf(p).getTime());
        });
        if (today >= minDate && today <= maxDate) timestamps.add(today.getTime());

        const dataInvested = [];
        const dataValue = [];
        [...timestamps].sort((a, b) => a - b).forEach(t => {
            let sumInvested = 0;
            let sumValue = 0;
            projects.forEach(p => {
                if (p.startDate.getTime() > t) return;
                // Après l'échéance : valeur figée (remboursement théorique)
                const end = Math.min(t, maturityOf(p).getTime());
                const days = (end - p.startDate.getTime()) / DAY_MS;
                sumInvested += p.invested;
                sumValue += p.invested + p.invested * (p.yieldPct / 100) * (days / 365);
            });
            dataInvested.push({ x: t, y: sumInvested });
            dataValue.push({ x: t, y: sumValue });
        });

        if (this.chart) this.chart.destroy();

        this.chart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Capital investi',
                        data: dataInvested,
                        borderColor: '#94a3b8',
                        backgroundColor: 'rgba(148, 163, 184, 0.08)',
                        borderWidth: 2,
                        borderDash: [4, 4],
                        fill: true,
                        stepped: true,
                        pointRadius: 0
                    },
                    {
                        label: 'Valeur projetée (capital + intérêts)',
                        data: dataValue,
                        borderColor: '#10b981',
                        backgroundColor: 'rgba(16, 185, 129, 0.12)',
                        borderWidth: 2,
                        fill: '-1',
                        cubicInterpolationMode: 'monotone',
                        pointRadius: 0
                    }
                ]
            },
            options: this.timeChartOptions({
                minDate, maxDate, today,
                yTicks: v => this.formatEUR(v),
                tooltipLabel: ctx => `${ctx.dataset.label} : ${this.formatEUR(ctx.parsed.y, 2)}`
            })
        });
    }

    // Options communes des graphiques temporels de la page
    timeChartOptions({ minDate, maxDate, today, yTicks, tooltipLabel, stacked = false, beginAtZero = false }) {
        const showToday = today >= minDate && today <= maxDate;
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            scales: {
                x: {
                    type: 'time',
                    min: minDate.getTime(),
                    max: maxDate.getTime(),
                    grid: { display: false },
                    ticks: {
                        color: CHART_TICK,
                        maxTicksLimit: 8,
                        maxRotation: 0,
                        callback: v => new Date(v).toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' })
                    }
                },
                y: {
                    stacked,
                    beginAtZero,
                    grid: { color: CHART_GRID },
                    ticks: { color: CHART_TICK, callback: yTicks }
                }
            },
            plugins: {
                legend: {
                    labels: { color: CHART_TICK, usePointStyle: true, pointStyle: 'line', boxWidth: 24 }
                },
                tooltip: {
                    callbacks: {
                        title: items => new Date(items[0].parsed.x).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }),
                        label: tooltipLabel
                    }
                },
                annotation: {
                    annotations: showToday ? {
                        today: {
                            type: 'line',
                            scaleID: 'x',
                            value: today.getTime(),
                            borderColor: 'rgba(239, 68, 68, 0.8)',
                            borderWidth: 1.5,
                            borderDash: [6, 6],
                            label: {
                                content: 'Aujourd\'hui',
                                display: true,
                                position: 'start',
                                backgroundColor: 'rgba(239, 68, 68, 0.9)',
                                color: 'white',
                                font: { size: 10, weight: 'bold' },
                                borderRadius: 4
                            }
                        }
                    } : {}
                }
            }
        };
    }

    // ========== RÉSIDENCE PRINCIPALE ==========

    normalizeCredit(credit) {
        return {
            ...credit,
            initialAmount: toNumber(credit.initialAmount),
            rate: toNumber(credit.rate),
            duration: toNumber(credit.duration ?? credit.durationMonths)
        };
    }

    analyzeCredit(credit, referenceDate) {
        const start = new Date(credit.startDate);
        const endDate = MortgageCalculator.getEndDate(credit);
        const remaining = MortgageCalculator.calculateRemainingCapital(credit, referenceDate);
        const monthlyPayment = MortgageCalculator.calculateMonthlyPayment(credit);
        const progress = credit.initialAmount > 0
            ? MortgageCalculator.getRepaymentProgress(credit, referenceDate)
            : 0;
        const interestPaid = MortgageCalculator.calculateInterestPaid(credit, referenceDate);
        const totalInterest = MortgageCalculator.calculateTotalCost(credit);

        let status = 'active';
        if (referenceDate < start) status = 'upcoming';
        else if (referenceDate >= endDate) status = 'repaid';

        const monthsLeft = status === 'repaid' ? 0 : MortgageCalculator.getMonthsDiff(referenceDate, endDate);

        return {
            credit,
            start,
            endDate,
            remaining,
            monthlyPayment,
            progress,
            interestPaid,
            totalInterest,
            interestRemaining: Math.max(0, totalInterest - interestPaid),
            status,
            monthsLeft
        };
    }

    async renderPrimaryResidence() {
        const container = document.getElementById('primary-residence-section');
        if (!container) return;

        const residence = this.storage.getPrimaryResidence();

        if (!residence) {
            if (this.debtChart) { this.debtChart.destroy(); this.debtChart = null; }
            container.innerHTML = `
                <div class="re-empty re-empty--boxed">
                    <i class="ph ph-house" aria-hidden="true"></i>
                    <h3>Aucune résidence principale</h3>
                    <p>Ajoutez votre résidence pour suivre votre patrimoine immobilier.</p>
                    <button class="btn-primary" onclick="window.realEstateApp.openPrimaryResidenceModal()">
                        <i class="ph ph-plus"></i> Ajouter ma résidence
                    </button>
                </div>`;
            return;
        }

        const today = new Date();
        const currentValue = toNumber(residence.currentValue);
        const purchasePrice = toNumber(residence.purchasePrice);
        const credits = (residence.credits || []).map(c => this.normalizeCredit(c));
        const details = credits.map(c => this.analyzeCredit(c, today));

        const totalDebt = details.reduce((s, d) => s + d.remaining, 0);
        const totalInitial = details.reduce((s, d) => s + d.credit.initialAmount, 0);
        const equity = currentValue - totalDebt;
        const ownershipPct = currentValue > 0 ? Math.max(0, (equity / currentValue) * 100) : 0;
        const ltvPct = currentValue > 0 ? (totalDebt / currentValue) * 100 : 0;
        const latentGain = currentValue - purchasePrice;
        const latentGainPct = purchasePrice > 0 ? (latentGain / purchasePrice) * 100 : 0;
        // Taux pondéré par le capital RESTANT (coût actuel réel de la dette)
        const weightedRate = totalDebt > 0
            ? details.reduce((s, d) => s + d.remaining * d.credit.rate, 0) / totalDebt
            : 0;
        // Mensualité réellement payée aujourd'hui : un PTZ différé ne compte pas encore
        const currentMonthly = details
            .filter(d => d.status === 'active')
            .reduce((s, d) => s + d.monthlyPayment, 0);
        const upcoming = details
            .filter(d => d.status === 'upcoming')
            .sort((a, b) => a.start - b.start);
        const capitalPaid = totalInitial - totalDebt;
        const interestPaid = details.reduce((s, d) => s + d.interestPaid, 0);
        const interestRemaining = details.reduce((s, d) => s + d.interestRemaining, 0);
        const debtFreeDate = details.length
            ? new Date(Math.max(...details.map(d => d.endDate)))
            : null;

        let monthlyMeta = 'Aucun crédit en cours';
        if (upcoming.length) {
            const next = upcoming[0];
            monthlyMeta = `+${this.formatEUR(next.monthlyPayment)}/mois dès ${formatMonthYear(next.start)} (${escapeHtml(next.credit.name || 'Crédit')})`;
        } else if (debtFreeDate && totalDebt > 0) {
            monthlyMeta = `Jusqu'en ${formatMonthYear(debtFreeDate)}`;
        }

        const creditCount = details.length;
        const gainClass = latentGain >= 0 ? 'is-positive' : 'is-negative';
        const gainSign = latentGain >= 0 ? '+' : '';

        container.innerHTML = `
            <div class="residence-header">
                <div>
                    <div class="residence-name">${escapeHtml(residence.name || 'Ma Résidence Principale')}</div>
                    <div class="residence-sub">
                        Acheté le ${new Date(residence.purchaseDate).toLocaleDateString('fr-FR')}
                        · détenu depuis ${formatDuration(MortgageCalculator.getMonthsDiff(residence.purchaseDate, today))}
                    </div>
                </div>
                <button class="btn-secondary btn-sm" onclick="window.realEstateApp.openPrimaryResidenceModal()">
                    <i class="ph ph-pencil-simple"></i> Modifier
                </button>
            </div>

            <div class="re-kpi-grid">
                <div class="re-kpi">
                    <div class="re-kpi-label">Valeur estimée</div>
                    <div class="re-kpi-value">${this.formatEUR(currentValue)}</div>
                    <div class="re-kpi-meta">
                        Achat ${this.formatEUR(purchasePrice)} ·
                        <span class="${gainClass}">${gainSign}${this.formatEUR(latentGain)} (${gainSign}${formatPct(latentGainPct)})</span>
                    </div>
                </div>
                <div class="re-kpi">
                    <div class="re-kpi-label">Capital restant dû</div>
                    <div class="re-kpi-value is-negative">${this.formatEUR(totalDebt)}</div>
                    <div class="re-kpi-meta">LTV ${formatPct(ltvPct)} · taux moyen ${formatPct(weightedRate, 2)}</div>
                </div>
                <div class="re-kpi re-kpi--accent">
                    <div class="re-kpi-label">Valeur nette</div>
                    <div class="re-kpi-value">${this.formatEUR(equity)}</div>
                    <div class="re-ownership">
                        <div class="re-ownership-bar"><span style="width: ${Math.min(100, ownershipPct)}%"></span></div>
                        <span>${formatPct(ownershipPct)} détenu</span>
                    </div>
                </div>
                <div class="re-kpi">
                    <div class="re-kpi-label">Mensualité actuelle</div>
                    <div class="re-kpi-value">${this.formatEUR(currentMonthly)}<small>/mois</small></div>
                    <div class="re-kpi-meta">${monthlyMeta}</div>
                </div>
            </div>

            <div class="residence-dashboard">
                <div class="re-subtitle residence-dashboard-title">
                    <span>Financement · ${creditCount} crédit${creditCount > 1 ? 's' : ''}</span>
                </div>
                <div class="residence-main">
                    <div class="credits-container">
                        ${details.map((d, i) => this.renderCreditCard(d, CREDIT_COLORS[i % CREDIT_COLORS.length])).join('') || '<div class="re-empty">Aucun crédit renseigné.</div>'}
                    </div>
                    ${this.renderUpcomingPayments(details, today)}
                </div>

                <div class="residence-side">
                    <div class="re-panel">
                        <div class="re-subtitle"><span>Bilan du financement</span></div>
                        <div class="re-list">
                            <div><span>Capital emprunté</span><strong>${this.formatEUR(totalInitial)}</strong></div>
                            <div><span>Capital remboursé</span><strong class="is-positive">${this.formatEUR(capitalPaid)}</strong></div>
                            <div><span>Intérêts payés</span><strong class="is-warning">${this.formatEUR(interestPaid)}</strong></div>
                            <div><span>Intérêts restant à payer</span><strong>${this.formatEUR(interestRemaining)}</strong></div>
                            <div><span>Coût total des intérêts</span><strong>${this.formatEUR(interestPaid + interestRemaining)}</strong></div>
                            ${debtFreeDate ? `<div><span>Libre de dettes</span><strong>${formatMonthYear(debtFreeDate)}</strong></div>` : ''}
                        </div>
                    </div>

                    ${details.length ? `
                    <div class="re-panel re-panel--grow">
                        <div class="re-subtitle">
                            <span>Évolution de la dette</span>
                            <button type="button" id="debt-scenario-reset" class="re-link-btn" hidden
                                onclick="window.realEstateApp.resetDebtScenario()">
                                <i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i> Réinitialiser
                            </button>
                        </div>
                        ${this.renderScenarioControls(details)}
                        <div id="debt-scenario-result" class="re-scenario-result"></div>
                        <div class="re-chart-small"><canvas id="debt-chart"></canvas></div>
                        <div class="re-chart-note">Valeur nette calculée à valeur du bien constante.</div>
                    </div>` : ''}
                </div>
            </div>
        `;

        // Conservés pour le modal du tableau d'amortissement complet
        this.residenceDetails = details;
        this.residenceToday = today;

        this.renderDebtChart(details, currentValue, today);
    }

    renderCreditCard(d, color) {
        const { credit } = d;
        const statusBadge = {
            upcoming: `<span class="re-badge re-badge--muted">Différé · début ${formatMonthYear(d.start)}</span>`,
            repaid: '<span class="re-badge re-badge--success">Remboursé</span>',
            active: ''
        }[d.status];

        const timeLeft = d.status === 'repaid'
            ? 'Terminé'
            : `${formatMonthYear(d.endDate)} · reste ${formatDuration(d.monthsLeft)}`;

        return `
            <div class="credit-card" style="--credit-color: ${color};">
                <div class="credit-header">
                    <div class="credit-title">
                        <span class="credit-name">${escapeHtml(credit.name || 'Crédit')}</span>
                        <span class="credit-rate">${formatPct(credit.rate, 2)}</span>
                        ${statusBadge}
                    </div>
                    <div class="credit-monthly">
                        ${this.formatEUR(d.monthlyPayment)}<small>/mois</small>
                    </div>
                </div>
                <div class="credit-metrics">
                    <div>
                        <span>Montant initial</span>
                        <strong>${this.formatEUR(credit.initialAmount)}</strong>
                    </div>
                    <div>
                        <span>Capital restant</span>
                        <strong class="is-negative">${this.formatEUR(d.remaining)}</strong>
                    </div>
                    <div>
                        <span>${credit.rate > 0 ? 'Intérêts payés / total' : 'Intérêts'}</span>
                        <strong class="${credit.rate > 0 ? 'is-warning' : ''}">
                            ${credit.rate > 0 ? `${this.formatEUR(d.interestPaid)} <small>/ ${this.formatEUR(d.totalInterest)}</small>` : 'Aucun (0 %)'}
                        </strong>
                    </div>
                    <div>
                        <span>Fin prévue</span>
                        <strong>${timeLeft}</strong>
                    </div>
                </div>
                <div class="re-progress">
                    <div class="re-progress-bar" style="width: ${Math.min(100, Math.max(0, d.progress)).toFixed(1)}%"></div>
                </div>
                <div class="re-progress-meta">
                    <span>${this.formatEUR(credit.initialAmount - d.remaining)} remboursés</span>
                    <span>${formatPct(Math.max(0, d.progress))}</span>
                </div>
            </div>
        `;
    }

    // Prochaines échéances (tous crédits confondus, regroupées par mois)
    getUpcomingPayments(details, today, count = 3) {
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const byMonth = new Map();

        details.forEach(d => {
            if (d.status === 'repaid' || d.credit.duration <= 0) return;
            MortgageCalculator.generateAmortizationSchedule(d.credit)
                .filter(e => e.date >= todayStart)
                .slice(0, count)
                .forEach(e => {
                    const key = e.date.getFullYear() * 12 + e.date.getMonth();
                    const row = byMonth.get(key) || { key, date: e.date, payment: 0, interest: 0, capital: 0, entries: new Map() };
                    row.payment += e.monthlyPayment;
                    row.interest += e.interestPayment;
                    row.capital += e.capitalPayment;
                    row.entries.set(d, e);
                    if (e.date < row.date) row.date = e.date;
                    byMonth.set(key, row);
                });
        });

        return [...byMonth.values()]
            .sort((a, b) => a.key - b.key)
            .slice(0, count)
            .map(row => ({
                ...row,
                // Capital restant dû total après l'échéance (crédits sans échéance ce mois-ci : CRD à date)
                remaining: details.reduce((s, d) => s + (row.entries.has(d)
                    ? row.entries.get(d).remainingCapital
                    : MortgageCalculator.calculateRemainingCapital(d.credit, row.date)), 0)
            }));
    }

    renderUpcomingPayments(details, today) {
        const rows = this.getUpcomingPayments(details, today);
        if (!rows.length) return '';

        return `
            <div class="re-panel re-schedule" role="button" tabindex="0"
                title="Voir le tableau d'amortissement complet"
                onclick="window.realEstateApp.openAmortizationModal()"
                onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); window.realEstateApp.openAmortizationModal(); }">
                <div class="re-subtitle">
                    <span>Prochaines échéances <span class="re-schedule-more">Tout voir <i class="ph ph-arrow-right" aria-hidden="true"></i></span></span>
                    <span class="re-schedule-legend">
                        <i class="is-interest"></i>Intérêts <i class="is-capital"></i>Capital
                    </span>
                </div>
                <table class="re-schedule-table">
                    <thead>
                        <tr>
                            <th>Échéance</th>
                            <th class="num">Mensualité</th>
                            <th class="num">Intérêts</th>
                            <th class="num">Capital</th>
                            <th class="num">Restant dû</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((r, i) => {
                            const interestShare = r.payment > 0 ? (r.interest / r.payment) * 100 : 0;
                            return `
                            <tr class="${i === 0 ? 'is-next' : ''}">
                                <td>
                                    <div class="re-schedule-date">
                                        ${r.date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                                        ${i === 0 ? '<span class="re-badge re-badge--info">Prochaine</span>' : ''}
                                    </div>
                                    <div class="re-split" title="Intérêts ${formatPct(interestShare)} · Capital ${formatPct(100 - interestShare)}">
                                        <span class="is-interest" style="width: ${interestShare.toFixed(1)}%"></span>
                                        <span class="is-capital" style="width: ${(100 - interestShare).toFixed(1)}%"></span>
                                    </div>
                                </td>
                                <td class="num"><strong>${this.formatEUR(r.payment, 2)}</strong></td>
                                <td class="num is-warning">${this.formatEUR(r.interest, 2)}</td>
                                <td class="num is-positive">${this.formatEUR(r.capital, 2)}</td>
                                <td class="num muted">${this.formatEUR(r.remaining)}</td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        `;
    }

    // ========== TABLEAU D'AMORTISSEMENT COMPLET ==========

    // Échéancier mensuel cumulé des crédits donnés (un crédit seul = son propre échéancier)
    buildAmortizationSchedule(details) {
        const schedules = details.map(d => {
            const byMonth = new Map();
            MortgageCalculator.generateAmortizationSchedule(d.credit).forEach(e => {
                byMonth.set(e.date.getFullYear() * 12 + e.date.getMonth(), e);
            });
            return { d, byMonth };
        });

        const keys = [...new Set(schedules.flatMap(s => [...s.byMonth.keys()]))].sort((a, b) => a - b);

        return keys.map(key => {
            const row = { key, date: null, payment: 0, interest: 0, capital: 0, remaining: 0 };
            schedules.forEach(({ d, byMonth }) => {
                const e = byMonth.get(key);
                if (e) {
                    row.payment += e.monthlyPayment;
                    row.interest += e.interestPayment;
                    row.capital += e.capitalPayment;
                    row.remaining += e.remainingCapital;
                    if (!row.date || e.date < row.date) row.date = e.date;
                }
            });
            // Crédits sans échéance ce mois-ci (différé pas commencé / déjà soldé)
            schedules.forEach(({ d, byMonth }) => {
                if (!byMonth.has(key)) row.remaining += MortgageCalculator.calculateRemainingCapital(d.credit, row.date);
            });
            return row;
        });
    }

    openAmortizationModal(scope = 'all') {
        const modal = document.getElementById('amortization-modal');
        if (!modal || !this.residenceDetails?.length) return;

        this.amortizationScope = scope;
        this.renderAmortizationModal();

        modal.style.display = 'flex';
        void modal.offsetWidth;
        modal.classList.add('show');

        if (!this.amortizationKeyHandler) {
            this.amortizationKeyHandler = e => { if (e.key === 'Escape') this.closeAmortizationModal(); };
        }
        document.addEventListener('keydown', this.amortizationKeyHandler);

        this.scrollAmortizationToCurrentYear();
    }

    closeAmortizationModal() {
        const modal = document.getElementById('amortization-modal');
        if (!modal) return;
        modal.classList.remove('show');
        document.removeEventListener('keydown', this.amortizationKeyHandler);
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }

    setAmortizationScope(scope) {
        this.amortizationScope = scope;
        this.renderAmortizationModal();
        this.scrollAmortizationToCurrentYear();
    }

    // Amène l'année de la prochaine échéance en haut de la zone scrollable (sous l'en-tête collant)
    scrollAmortizationToCurrentYear() {
        const wrap = document.getElementById('amortization-table-wrap');
        const year = wrap?.querySelector('.re-am-year.is-open');
        if (!wrap) return;
        if (!year) { wrap.scrollTop = 0; return; }
        const headHeight = wrap.querySelector('thead')?.offsetHeight || 0;
        wrap.scrollTop += year.getBoundingClientRect().top - wrap.getBoundingClientRect().top - headHeight;
    }

    renderAmortizationModal() {
        const details = this.residenceDetails;
        const today = this.residenceToday || new Date();
        const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
        const scope = this.amortizationScope;
        const selected = scope === 'all' ? details : [details[Number(scope)]].filter(Boolean);

        // Onglets : vue globale + un par crédit
        const tabs = document.getElementById('amortization-tabs');
        tabs.innerHTML = (details.length > 1 ? [{ key: 'all', label: 'Tous les crédits', color: null }] : [])
            .concat(details.map((d, i) => ({
                key: String(i),
                label: d.credit.name || `Crédit ${i + 1}`,
                color: CREDIT_COLORS[i % CREDIT_COLORS.length]
            })))
            .map(t => `
                <button type="button" class="re-am-tab ${String(scope) === t.key || (details.length === 1) ? 'is-active' : ''}"
                    onclick="window.realEstateApp.setAmortizationScope('${t.key}')">
                    ${t.color ? `<i style="background: ${t.color}"></i>` : ''}${escapeHtml(t.label)}
                </button>`).join('');

        const rows = this.buildAmortizationSchedule(selected);
        const nextIndex = rows.findIndex(r => r.date >= todayStart);
        const paidRows = nextIndex === -1 ? rows : rows.slice(0, nextIndex);
        const sum = (list, field) => list.reduce((s, r) => s + r[field], 0);

        document.getElementById('amortization-summary').innerHTML = `
            <div><span>Total des échéances</span><strong>${this.formatEUR(sum(rows, 'payment'))}</strong></div>
            <div><span>Dont intérêts</span><strong class="is-warning">${this.formatEUR(sum(rows, 'interest'))}</strong></div>
            <div><span>Déjà réglé</span><strong class="is-positive">${this.formatEUR(sum(paidRows, 'payment'))}</strong>
                <small>${paidRows.length} / ${rows.length} échéances</small></div>
            <div><span>Dernière échéance</span><strong>${rows.length ? formatMonthYear(rows[rows.length - 1].date) : '—'}</strong></div>
        `;

        // Regroupement par année, l'année de la prochaine échéance est dépliée
        const years = new Map();
        rows.forEach((r, i) => {
            const y = r.date.getFullYear();
            if (!years.has(y)) years.set(y, []);
            years.get(y).push({ ...r, index: i });
        });
        const openYear = nextIndex === -1 ? null : rows[nextIndex].date.getFullYear();
        const fmt = v => this.formatEUR(v, 2);

        document.getElementById('amortization-table').innerHTML = `
            <thead>
                <tr>
                    <th>Échéance</th>
                    <th class="num">Mensualité</th>
                    <th class="num">Intérêts</th>
                    <th class="num">Capital</th>
                    <th class="num">Restant dû</th>
                </tr>
            </thead>
            ${[...years.entries()].map(([year, list]) => {
                const allPaid = list.every(r => r.index < nextIndex || nextIndex === -1);
                return `
                <tbody class="re-am-year ${year === openYear ? 'is-open' : ''}">
                    <tr class="re-am-year-row" onclick="this.parentElement.classList.toggle('is-open')">
                        <td><i class="ph ph-caret-right" aria-hidden="true"></i> ${year}
                            ${allPaid ? '<span class="re-badge re-badge--success">Réglé</span>' : ''}</td>
                        <td class="num">${this.formatEUR(sum(list, 'payment'))}</td>
                        <td class="num is-warning">${this.formatEUR(sum(list, 'interest'))}</td>
                        <td class="num is-positive">${this.formatEUR(sum(list, 'capital'))}</td>
                        <td class="num muted">${this.formatEUR(list[list.length - 1].remaining)}</td>
                    </tr>
                    ${list.map(r => `
                    <tr class="re-am-row ${r.index < nextIndex || nextIndex === -1 ? 'is-paid' : ''} ${r.index === nextIndex ? 'is-next' : ''}">
                        <td>
                            <span class="re-am-num">${r.index + 1}</span>
                            ${r.date.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                            ${r.index === nextIndex ? '<span class="re-badge re-badge--info">Prochaine</span>' : ''}
                        </td>
                        <td class="num"><strong>${fmt(r.payment)}</strong></td>
                        <td class="num is-warning">${fmt(r.interest)}</td>
                        <td class="num is-positive">${fmt(r.capital)}</td>
                        <td class="num muted">${this.formatEUR(r.remaining)}</td>
                    </tr>`).join('')}
                </tbody>`;
            }).join('')}
        `;
    }

    // ========== SIMULATEUR DE SCÉNARIOS ==========

    renderScenarioControls(details) {
        const s = this.debtScenario;
        // Par défaut : premier crédit encore en cours avec intérêts (là où un scénario a un effet)
        if (s.creditIndex === null || !details[s.creditIndex]) {
            const idx = details.findIndex(d => d.status !== 'repaid' && d.credit.rate > 0);
            s.creditIndex = idx === -1 ? Math.max(0, details.findIndex(d => d.status !== 'repaid')) : idx;
        }
        if (!s.lumpMonth) {
            const next = new Date();
            next.setMonth(next.getMonth() + 1, 1);
            s.lumpMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`;
        }
        const credit = details[s.creditIndex].credit;
        const onInput = 'oninput="window.realEstateApp.onScenarioInput(this)"';

        return `
            <div class="re-scenario" id="debt-scenario">
                <label class="re-field">
                    <span>Crédit</span>
                    <select name="creditIndex" onchange="window.realEstateApp.onScenarioInput(this)">
                        ${details.map((d, i) => `<option value="${i}" ${i === s.creditIndex ? 'selected' : ''} ${d.status === 'repaid' ? 'disabled' : ''}>${escapeHtml(d.credit.name || `Crédit ${i + 1}`)}</option>`).join('')}
                    </select>
                </label>
                <label class="re-field">
                    <span>Nouveau taux</span>
                    <div class="re-input-unit">
                        <input type="number" name="rate" min="0" max="20" step="0.05" inputmode="decimal"
                            placeholder="${credit.rate}" value="${escapeHtml(s.rate)}" ${onInput}><em>%</em>
                    </div>
                </label>
                <label class="re-field">
                    <span>Versement en plus</span>
                    <div class="re-input-unit">
                        <input type="number" name="extraMonthly" min="0" step="10" inputmode="decimal"
                            placeholder="0" value="${escapeHtml(s.extraMonthly)}" ${onInput}><em>€/mois</em>
                    </div>
                </label>
                <label class="re-field">
                    <span>Remb. anticipé</span>
                    <div class="re-input-unit">
                        <input type="number" name="lumpSum" min="0" step="1000" inputmode="decimal"
                            placeholder="0" value="${escapeHtml(s.lumpSum)}" ${onInput}><em>€</em>
                    </div>
                </label>
                <label class="re-field">
                    <span>En</span>
                    <input type="month" name="lumpMonth" value="${escapeHtml(s.lumpMonth)}" ${onInput}>
                </label>
                <div class="re-field">
                    <span>Après le remboursement</span>
                    <div class="re-segmented" role="radiogroup">
                        <button type="button" class="${s.mode === 'duration' ? 'is-active' : ''}" aria-pressed="${s.mode === 'duration'}"
                            onclick="window.realEstateApp.setScenarioMode('duration')">Durée ↓</button>
                        <button type="button" class="${s.mode === 'payment' ? 'is-active' : ''}" aria-pressed="${s.mode === 'payment'}"
                            onclick="window.realEstateApp.setScenarioMode('payment')">Mensualité ↓</button>
                    </div>
                </div>
            </div>
        `;
    }

    onScenarioInput(input) {
        const s = this.debtScenario;
        if (input.name === 'creditIndex') {
            s.creditIndex = Number(input.value);
            // Le placeholder du taux suit le crédit sélectionné
            const rateInput = document.querySelector('#debt-scenario input[name="rate"]');
            const credit = this.residenceDetails?.[s.creditIndex]?.credit;
            if (rateInput && credit) rateInput.placeholder = credit.rate;
        } else {
            s[input.name] = input.value;
        }
        this.updateDebtScenario();
    }

    setScenarioMode(mode) {
        this.debtScenario.mode = mode;
        document.querySelectorAll('#debt-scenario .re-segmented button').forEach((b, i) => {
            const active = (i === 0) === (mode === 'duration');
            b.classList.toggle('is-active', active);
            b.setAttribute('aria-pressed', active);
        });
        this.updateDebtScenario();
    }

    resetDebtScenario() {
        Object.assign(this.debtScenario, { rate: '', extraMonthly: '', lumpSum: '' });
        document.querySelectorAll('#debt-scenario input[type="number"]').forEach(i => { i.value = ''; });
        this.updateDebtScenario();
    }

    // Paramètres de simulation (null si aucun levier n'est renseigné)
    getScenarioParams(credit, today) {
        const s = this.debtScenario;
        const rate = s.rate === '' ? null : toNumber(s.rate, null);
        const extraMonthly = Math.max(0, toNumber(s.extraMonthly));
        const lumpSum = Math.max(0, toNumber(s.lumpSum));
        const hasRate = rate !== null && rate >= 0 && Math.abs(rate - credit.rate) > 1e-9;
        if (!hasRate && !extraMonthly && !lumpSum) return null;

        // Le mois en cours est considéré réglé (cohérent avec calculateRemainingCapital)
        const fromKey = MortgageCalculator.monthKey(today) + 1;
        const [y, m] = (s.lumpMonth || '').split('-').map(Number);
        const lumpKey = y && m ? Math.max(fromKey, y * 12 + (m - 1)) : fromKey;

        return { fromKey, rate: hasRate ? rate : null, extraMonthly, lumpSum, lumpKey, mode: s.mode };
    }

    // Recalcule le scénario, met à jour le résumé et la courbe sans re-rendre la page (garde le focus)
    updateDebtScenario() {
        const details = this.residenceDetails;
        const today = this.residenceToday || new Date();
        const resultEl = document.getElementById('debt-scenario-result');
        const resetBtn = document.getElementById('debt-scenario-reset');
        if (!details?.length || !resultEl) return;

        const d = details[this.debtScenario.creditIndex];
        const params = d ? this.getScenarioParams(d.credit, today) : null;
        if (resetBtn) resetBtn.hidden = !params;

        let scenarioSim = null;
        if (!params) {
            resultEl.innerHTML = '<span class="re-scenario-hint"><i class="ph ph-lightbulb" aria-hidden="true"></i> Modifiez un paramètre pour comparer un scénario à votre plan actuel.</span>';
        } else {
            const base = MortgageCalculator.simulateScenario(d.credit);
            scenarioSim = MortgageCalculator.simulateScenario(d.credit, params);

            const saved = base.totalInterest - scenarioSim.totalInterest;
            const monthsSaved = base.endKey - scenarioSim.endKey;
            const keyToDate = key => new Date(Math.floor(key / 12), key % 12, 1);
            // IRA : plafond légal = min(6 mois d'intérêts sur la somme remboursée, 3 % du capital remboursé). Pas d'IRA sur un PTZ.
            const ira = scenarioSim.lumpApplied * Math.min(0.03, d.credit.rate / 100 / 2);
            const basePayment = MortgageCalculator.calculateMonthlyPayment(d.credit);
            const paymentDelta = scenarioSim.payment - basePayment;

            const chips = [
                `<div><span>${saved >= 0 ? 'Intérêts économisés' : "Surcoût d'intérêts"}</span><strong class="${saved >= 0 ? 'is-positive' : 'is-negative'}">${this.formatEUR(Math.abs(saved))}</strong></div>`,
                `<div><span>Fin du crédit</span><strong>${formatMonthYear(keyToDate(scenarioSim.endKey))}</strong>
                    <small>${monthsSaved > 0 ? `${formatDuration(monthsSaved)} plus tôt` : monthsSaved < 0 ? `${formatDuration(-monthsSaved)} plus tard` : 'inchangée'}</small></div>`,
                `<div><span>Mensualité</span><strong>${this.formatEUR(scenarioSim.payment + params.extraMonthly)}</strong>
                    <small>${Math.abs(paymentDelta + params.extraMonthly) < 0.5 ? 'inchangée' : `${paymentDelta + params.extraMonthly > 0 ? '+' : '−'}${this.formatEUR(Math.abs(paymentDelta + params.extraMonthly))}/mois`}</small></div>`
            ];
            if (ira > 0) {
                chips.push(`<div><span>IRA max. · gain net</span><strong class="is-warning">${this.formatEUR(ira)}</strong>
                    <small>net ${this.formatEUR(saved - ira)}</small></div>`);
            }
            resultEl.innerHTML = chips.join('');
        }

        this.setDebtChartScenario(d, scenarioSim);
    }

    // Ajoute / met à jour / retire la courbe « Scénario » (dette totale) sur le graphique
    setDebtChartScenario(d, simulation) {
        const chart = this.debtChart;
        if (!chart) return;
        const datasets = chart.data.datasets;
        const idx = datasets.findIndex(ds => ds.id === 'scenario');

        if (!simulation) {
            if (idx !== -1) datasets.splice(idx, 1);
            datasets.forEach(ds => { if (ds.stack === 'debt') ds.backgroundColor = ds.baseBackground; });
            chart.update('none');
            return;
        }

        const details = this.residenceDetails;
        const data = this.debtChartTimestamps.map(t => {
            const key = MortgageCalculator.monthKey(t);
            const total = details.reduce((s, other) => s + (other === d
                ? MortgageCalculator.balanceAt(simulation, d.credit, key)
                : MortgageCalculator.calculateRemainingCapital(other.credit, new Date(t))), 0);
            return { x: t, y: total };
        });

        const dataset = {
            id: 'scenario',
            label: 'Scénario',
            data,
            borderColor: '#f59e0b',
            borderWidth: 2.5,
            fill: false,
            stack: 'scenario',
            pointRadius: 0,
            tension: 0.2
        };
        if (idx === -1) datasets.push(dataset); else datasets[idx] = dataset;
        // Plan actuel atténué pour faire ressortir le scénario
        datasets.forEach(ds => { if (ds.stack === 'debt') ds.backgroundColor = `${ds.borderColor}14`; });
        chart.update('none');
    }

    renderDebtChart(details, currentValue, today) {
        if (this.debtChart) { this.debtChart.destroy(); this.debtChart = null; }
        const canvas = document.getElementById('debt-chart');
        if (!canvas || details.length === 0) return;

        const minDate = new Date(Math.min(...details.map(d => d.start)));
        const maxDate = new Date(Math.max(...details.map(d => d.endDate)));

        // Un point par trimestre + aujourd'hui
        const timestamps = [];
        const iter = new Date(minDate);
        while (iter <= maxDate) {
            timestamps.push(iter.getTime());
            iter.setMonth(iter.getMonth() + 3);
        }
        timestamps.push(maxDate.getTime());
        if (today > minDate && today < maxDate) timestamps.push(today.getTime());
        timestamps.sort((a, b) => a - b);
        this.debtChartTimestamps = timestamps;

        const datasets = details.map((d, i) => {
            const color = CREDIT_COLORS[i % CREDIT_COLORS.length];
            return {
                label: d.credit.name || `Crédit ${i + 1}`,
                data: timestamps.map(t => ({ x: t, y: MortgageCalculator.calculateRemainingCapital(d.credit, new Date(t)) })),
                borderColor: color,
                backgroundColor: `${color}33`,
                baseBackground: `${color}33`,
                borderWidth: 1.5,
                fill: i === 0 ? 'origin' : '-1',
                stack: 'debt',
                pointRadius: 0,
                tension: 0.2
            };
        });

        datasets.push({
            label: 'Valeur nette',
            data: timestamps.map(t => ({
                x: t,
                y: currentValue - details.reduce((s, d) => s + MortgageCalculator.calculateRemainingCapital(d.credit, new Date(t)), 0)
            })),
            borderColor: '#e2e8f0',
            borderWidth: 2,
            borderDash: [4, 4],
            fill: false,
            stack: 'equity',
            pointRadius: 0,
            tension: 0.2
        });

        this.debtChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets },
            options: this.timeChartOptions({
                minDate, maxDate, today,
                stacked: true,
                beginAtZero: true,
                yTicks: v => `${Math.round(v / 1000)} k€`,
                tooltipLabel: ctx => `${ctx.dataset.label} : ${this.formatEUR(ctx.parsed.y)}`
            })
        });

        this.updateDebtScenario();
    }

    setupEventListeners() {
        window.addEventListener('residence-updated', () => {
            this.renderPrimaryResidence();
        });
    }

    openPrimaryResidenceModal() {
        const modal = document.getElementById('primary-residence-modal');
        const form = document.getElementById('primary-residence-form');
        const creditsContainer = document.getElementById('credits-list-container');

        if (!modal || !form || !creditsContainer) return;

        form.reset();
        creditsContainer.innerHTML = '';

        const residence = this.storage.getPrimaryResidence();

        if (residence) {
            document.getElementById('residence-name').value = residence.name || '';
            document.getElementById('residence-price').value = residence.purchasePrice || '';
            document.getElementById('residence-value').value = residence.currentValue || '';
            document.getElementById('residence-date').value = new Date(residence.purchaseDate).toISOString().split('T')[0];

            if (residence.credits && residence.credits.length > 0) {
                residence.credits.forEach(credit => this.addCreditRow(credit));
            } else {
                this.addCreditRow();
            }
        } else {
            document.getElementById('residence-date').value = new Date().toISOString().split('T')[0];
            this.addCreditRow();
        }

        modal.style.display = 'flex';
        void modal.offsetWidth;
        modal.classList.add('show');
    }

    closePrimaryResidenceModal() {
        const modal = document.getElementById('primary-residence-modal');
        if (modal) {
            modal.classList.remove('show');
            setTimeout(() => {
                modal.style.display = 'none';
            }, 300);
        }
    }

    addCreditRow(creditData = null) {
        const container = document.getElementById('credits-list-container');
        if (!container) return;

        // Compteur en plus du timestamp : plusieurs lignes ajoutées dans la même
        // milliseconde (ouverture de la modale) auraient sinon le même id.
        this._creditRowSeq = (this._creditRowSeq || 0) + 1;
        const rowId = `credit-row-${Date.now()}-${this._creditRowSeq}`;
        const row = document.createElement('div');
        row.className = 'credit-row-item';
        row.id = rowId;

        const name = creditData?.name || 'Crédit Principale';
        const amount = creditData?.initialAmount || '';
        const rate = creditData?.rate !== undefined ? creditData.rate : 3.5;
        const duration = creditData?.duration || creditData?.durationMonths || 300;
        const monthlyPayment = creditData?.monthlyPayment || '';

        let startDateVal = new Date().toISOString().split('T')[0];
        if (creditData?.startDate) {
            startDateVal = new Date(creditData.startDate).toISOString().split('T')[0];
        } else {
            const residenceDate = document.getElementById('residence-date').value;
            if (residenceDate) startDateVal = residenceDate;
        }

        row.innerHTML = `
            <div class="credit-field credit-field--name">
                <label>Nom</label>
                <input type="text" class="form-input credit-name" value="${escapeHtml(name)}" placeholder="Nom" required>
            </div>
            <div class="credit-field">
                <label>Montant (€)</label>
                <input type="number" class="form-input credit-amount" value="${escapeHtml(amount)}" placeholder="Montant" step="any" required>
            </div>
            <div class="credit-field">
                <label>Taux (%)</label>
                <input type="number" class="form-input credit-rate" value="${escapeHtml(rate)}" placeholder="%" step="0.01" required>
            </div>
            <div class="credit-field">
                <label>Durée (mois)</label>
                <input type="number" class="form-input credit-duration" value="${escapeHtml(duration)}" placeholder="Mois" required>
            </div>
            <div class="credit-field">
                <label>Mensualité (Opt.)</label>
                <input type="number" class="form-input credit-monthly" value="${escapeHtml(monthlyPayment)}" placeholder="Calculé auto" step="any">
            </div>
            <div class="credit-field">
                <label>Début</label>
                <input type="date" class="form-input credit-start" value="${startDateVal}" required>
            </div>
            <button type="button" class="btn-icon-danger" onclick="document.getElementById('${rowId}').remove()" title="Supprimer">
                <i class="ph ph-trash"></i>
            </button>
        `;

        container.appendChild(row);
    }

    async savePrimaryResidence() {
        const name = document.getElementById('residence-name').value;
        const purchasePrice = parseFloat(document.getElementById('residence-price').value);
        const currentValue = parseFloat(document.getElementById('residence-value').value);
        const purchaseDateStr = document.getElementById('residence-date').value;

        if (!name || isNaN(purchasePrice) || isNaN(currentValue) || !purchaseDateStr) {
            alert('Veuillez remplir correctement les informations principales.');
            return;
        }

        const credits = [];
        const creditRows = document.querySelectorAll('.credit-row-item');

        creditRows.forEach(row => {
            const cName = row.querySelector('.credit-name').value;
            const cAmount = parseFloat(row.querySelector('.credit-amount').value);
            const cRate = parseFloat(row.querySelector('.credit-rate').value);
            const cDuration = parseInt(row.querySelector('.credit-duration').value);
            const cMonthly = row.querySelector('.credit-monthly').value;
            const cStartStr = row.querySelector('.credit-start').value;

            if (cName && !isNaN(cAmount) && !isNaN(cRate) && !isNaN(cDuration) && cStartStr) {
                credits.push({
                    name: cName,
                    initialAmount: cAmount,
                    rate: cRate,
                    duration: cDuration,
                    monthlyPayment: cMonthly ? parseFloat(cMonthly) : null,
                    startDate: new Date(cStartStr).toISOString()
                });
            }
        });

        const existing = this.storage.getPrimaryResidence();
        const residenceId = existing?.id || `res_primary_${Date.now()}`;

        const residence = {
            id: residenceId,
            name: name,
            purchasePrice: purchasePrice,
            currentValue: currentValue,
            purchaseDate: new Date(purchaseDateStr).toISOString(),
            credits: credits,
            lastUpdated: new Date().toISOString()
        };

        try {
            await this.storage.savePrimaryResidence(residence);
        } catch (error) {
            // La modale reste ouverte : la saisie n'est pas perdue
            showWriteError('enregistrement de la résidence principale', error);
            return;
        }
        this.closePrimaryResidenceModal();
        this.renderPrimaryResidence();
    }

    formatEUR(amount, decimals = 0) {
        return new Intl.NumberFormat('fr-FR', {
            style: 'currency', currency: 'EUR',
            minimumFractionDigits: decimals, maximumFractionDigits: decimals
        }).format(amount);
    }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
    const app = new RealEstateApp();
    window.realEstateApp = app;
    app.init();
});
