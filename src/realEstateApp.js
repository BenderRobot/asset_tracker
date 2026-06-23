import { Storage } from './storage.js';
import { UIComponents } from './ui.js';
import { MortgageCalculator } from './mortgageCalculator.js';

export class RealEstateApp {
    constructor() {
        this.storage = new Storage();
        this.chart = null;
    }

    async init() {
        console.log("RealEstateApp Initialized 🏢");

        // Charger la résidence depuis Firestore (synchronisation multi-appareils)
        await this.storage.loadPrimaryResidenceFromFirestore();

        await this.renderPrimaryResidence();
        await this.loadData();
        this.setupEventListeners();
    }

    async loadData() {
        const allPurchases = this.storage.getPurchases();

        // 1. Filtrer les projets Immo
        const projects = allPurchases.filter(p => p.assetType === 'Real Estate');

        if (projects.length === 0) {
            document.getElementById('projects-container').innerHTML = `
                <div style="grid-column: 1/-1; text-align: center; padding: 40px; color: var(--text-muted);">
                    <i class="fas fa-building" style="font-size: 48px; margin-bottom: 16px; opacity: 0.5;"></i><br>
                    Aucun projet immobilier trouvé.<br>
                    Ajoutez une transaction "Immobilier" pour commencer.
                </div>`;
            this.updateKPIs(0, 0, 0, 0);
            return;
        }

        // 2. Calculer les valeurs pour chaque projet
        const today = new Date();
        let totalInvested = 0;
        let totalCurrent = 0;
        let weightedYieldSum = 0;

        const processedProjects = projects.map(p => {
            const startDate = new Date(p.date);
            const invested = p.price * p.quantity;
            const yieldPct = p.yield || 0;
            const maturityDate = p.maturityDate ? new Date(p.maturityDate) : null;

            // Calcul Intérêts Courus (Simple Interest)
            // Formule: Investi * (Taux/100) * (Jours / 365)
            const daysHeld = Math.max(0, (today - startDate) / (1000 * 60 * 60 * 24));
            const accrued = invested * (yieldPct / 100) * (daysHeld / 365);
            const currentVal = invested + accrued;

            // Calcul Avancement (Durée écoulée / Durée totale)
            let progress = 0;
            let durationDays = 365 * 2; // Default 2 years if no maturity
            if (maturityDate) {
                const totalDuration = Math.max(1, (maturityDate - startDate) / (1000 * 60 * 60 * 24));
                progress = Math.min(100, Math.max(0, (daysHeld / totalDuration) * 100));
                durationDays = totalDuration;
            }

            // Stats globales
            totalInvested += invested;
            totalCurrent += currentVal;
            weightedYieldSum += (yieldPct * invested);

            return {
                ...p,
                invested,
                currentVal,
                accrued,
                yieldPct,
                progress,
                startDate,
                maturityDate,
                durationDays
            };
        });

        const avgYield = totalInvested > 0 ? (weightedYieldSum / totalInvested) : 0;
        const totalAccrued = totalCurrent - totalInvested;

        // 3. Mettre à jour l'UI
        this.updateKPIs(totalInvested, totalCurrent, avgYield, totalAccrued);
        this.renderProjectCards(processedProjects);
        this.renderProjectionChart(processedProjects);
    }

    updateKPIs(invested, current, yieldPct, accrued) {
        document.getElementById('total-invested').textContent = `Investi: ${invested.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`;
        document.getElementById('total-simulated-value').textContent = current.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
        document.getElementById('avg-yield').textContent = `${yieldPct.toFixed(2)}%`;
        document.getElementById('accrued-interest').textContent = `+${accrued.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}`;

        // Coloration gain
        const gainEl = document.getElementById('accrued-interest');
        if (accrued > 0) gainEl.style.color = '#10b981';
    }

    renderProjectCards(projects) {
        const container = document.getElementById('projects-container');
        container.innerHTML = '';

        projects.forEach(p => {
            const maturityStr = p.maturityDate ? p.maturityDate.toLocaleDateString('fr-FR') : 'N/A';
            const card = document.createElement('div');
            card.className = 'project-card';
            card.innerHTML = `
                <div class="project-header">
                    <div class="project-title">${p.name} <span style="font-weight:400; color:var(--text-secondary); font-size:12px;">(${p.ticker || 'Ref?'})</span></div>
                    <div class="project-tag">${p.yieldPct.toFixed(2)}%</div>
                </div>
                
                <div class="project-stats">
                    <div>
                        <div class="stat-label">Investi</div>
                        <div class="stat-val">${p.invested.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="stat-label">Valeur Actuelle</div>
                        <div class="stat-val" style="color:#10b981;">${p.currentVal.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })}</div>
                    </div>
                </div>

                <div class="progress-bar-container" title="Maturité: ${p.progress.toFixed(1)}%">
                    <div class="progress-bar" style="width: ${p.progress}%"></div>
                </div>

                <div class="project-stats" style="margin-top: 8px;">
                     <div>
                        <div class="stat-label">Date Début</div>
                        <div style="font-size:12px; color:var(--text-primary);">${p.startDate.toLocaleDateString('fr-FR')}</div>
                    </div>
                    <div style="text-align:right;">
                        <div class="stat-label">Échéance</div>
                        <div style="font-size:12px; color:var(--text-primary);">${maturityStr}</div>
                    </div>
                </div>
            `;
            container.appendChild(card);
        });
    }

    renderProjectionChart(projects) {
        const ctx = document.getElementById('projection-chart').getContext('2d');

        // Génération des données mensuelles
        // On prend la date min (premier investissement) et la date max (dernière maturité)
        if (projects.length === 0) return;

        const minDate = new Date(Math.min(...projects.map(p => p.startDate)));
        const maxDate = new Date(Math.max(...projects.map(p => p.maturityDate || new Date())));

        // On s'assure d'avoir au moins 1 an de projection
        if (maxDate < new Date()) maxDate.setFullYear(new Date().getFullYear() + 1);

        const labels = [];
        const dataInvested = [];
        const dataValue = [];

        // Itérer mois par mois
        let iterDate = new Date(minDate);
        iterDate.setDate(1); // 1er du mois

        while (iterDate <= maxDate) {
            labels.push(iterDate.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }));

            let sumInvested = 0;
            let sumValue = 0;

            projects.forEach(p => {
                // Si le projet a commencé avant cette date
                if (p.startDate <= iterDate) {
                    // Si le projet n'est pas terminé (ou on compte la valeur finale si terminé après ?)
                    // Pour simplifier : on projette la valeur théorique continue jusqu'à maturité
                    // Si maturité dépassée, on garde la valeur finale (remboursement théorique)

                    const pMaturity = p.maturityDate || new Date(p.startDate.getTime() + (365 * 2 * 24 * 3600 * 1000));

                    let days = 0;
                    if (iterDate > pMaturity) {
                        // Projet terminé : Valeur Max
                        days = (pMaturity - p.startDate) / (1000 * 60 * 60 * 24);
                    } else {
                        // Projet en cours
                        days = (iterDate - p.startDate) / (1000 * 60 * 60 * 24);
                    }

                    // Si on veut visualiser le "Futur", il faut compter les jours futurs

                    const val = p.invested + (p.invested * (p.yieldPct / 100) * (days / 365));

                    sumInvested += p.invested;
                    sumValue += val;
                }
            });

            dataInvested.push(sumInvested);
            dataValue.push(sumValue);

            // Mois suivant
            iterDate.setMonth(iterDate.getMonth() + 1);
        }

        if (this.chart) this.chart.destroy();

        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Investi Initial',
                        data: dataInvested,
                        borderColor: '#94a3b8', // Gris
                        backgroundColor: 'rgba(148, 163, 184, 0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0
                    },
                    {
                        label: 'Valeur Projetée (Cumul Intérêts)',
                        data: dataValue,
                        borderColor: '#10b981', // Vert
                        backgroundColor: 'rgba(16, 185, 129, 0.1)',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index',
                },
                scales: {
                    y: {
                        grid: { color: 'rgba(255, 255, 255, 0.05)' },
                        ticks: { color: '#94a3b8' }
                    },
                    x: {
                        grid: { display: false },
                        ticks: { color: '#94a3b8', maxTicksLimit: 12 }
                    }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    },
                    annotation: {
                        annotations: {
                            line1: {
                                type: 'line',
                                scaleID: 'x',
                                value: (function () {
                                    // Trouver l'index du label qui correspond au mois actuel
                                    const currentLabel = new Date().toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });
                                    const idx = labels.indexOf(currentLabel);
                                    return idx !== -1 ? idx : currentLabel; // Fallback string si non trouvé (peu probable)
                                })(),
                                borderColor: '#F44336',
                                borderWidth: 2,
                                borderDash: [6, 6],
                                label: {
                                    content: 'Aujourd\'hui',
                                    display: true,
                                    position: 'start',
                                    backgroundColor: '#F44336',
                                    color: 'white',
                                    font: { size: 10, weight: 'bold' },
                                    yAdjust: 10
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // ========== NOUVEAU : RÉSIDENCE PRINCIPALE ==========

    async renderPrimaryResidence() {
        const container = document.getElementById('primary-residence-section');
        if (!container) return;

        const residence = this.storage.getPrimaryResidence();

        if (!residence) {
            container.innerHTML = `
                <div style="text-align: center; padding: 60px 20px; background: var(--bg-secondary); border-radius: 12px; border: 2px dashed var(--border-color);">
                    <i class="fas fa-home" style="font-size: 48px; color: var(--text-muted); margin-bottom: 16px;"></i>
                    <h3 style="margin: 0 0 8px 0; color: var(--text-primary);">Aucune résidence principale</h3>
                    <p style="color: var(--text-muted); margin-bottom: 24px;">Ajoutez votre résidence pour suivre votre patrimoine immobilier.</p>
                    <button class="btn-primary" onclick="window.realEstateApp.openPrimaryResidenceModal()">
                        <i class="fas fa-plus"></i> Ajouter ma résidence
                    </button>
                </div>`;
            return;
        }

        const today = new Date();
        const totalDebt = MortgageCalculator.calculateTotalRemainingCapital(residence.credits, today);
        const equity = residence.currentValue - totalDebt;
        const latentGain = residence.currentValue - residence.purchasePrice;
        const weightedRate = MortgageCalculator.calculateWeightedAverageRate(residence.credits);
        const totalMonthly = MortgageCalculator.calculateTotalMonthlyPayment(residence.credits);

        container.innerHTML = `
            <div class="primary-residence-card">
                <div class="card-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
                    <div style="display: flex; align-items: center; gap: 12px;">
                        <span style="font-size: 24px;">🏠</span>
                        <div>
                            <h2 style="margin: 0; font-size: 18px;">${residence.name || 'Ma Résidence Principale'}</h2>
                            <div style="font-size: 12px; color: var(--text-muted); margin-top: 2px;">
                                Acheté le ${new Date(residence.purchaseDate).toLocaleDateString()}
                            </div>
                        </div>
                    </div>
                    <button class="btn-secondary btn-sm" onclick="window.realEstateApp.openPrimaryResidenceModal()" style="padding: 6px 12px; font-size: 12px;">
                        <i class="fas fa-edit"></i> Modifier
                    </button>
                </div>
                
                <div class="residence-dashboard" style="display: grid; grid-template-columns: 1.8fr 1fr; gap: 16px;">
                    
                    <div class="dashboard-left">
                        <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px;">
                             <h3 style="margin: 0; font-size: 14px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">Financement (${residence.credits.length} Crédits)</h3>
                             <span style="font-size: 13px; color: var(--text-muted);">Mensualité: <strong>${this.formatEUR(totalMonthly)}</strong>/mois</span>
                        </div>

                        <div class="credits-container">
                            ${residence.credits.map(credit => this.renderCreditCard(credit, today)).join('')}
                        </div>
                    </div>

                    <div class="dashboard-right" style="display: flex; flex-direction: column; gap: 10px;">
                        
                        <div style="background: var(--bg-secondary); border-radius: 12px; padding: 14px;">
                            <div style="margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--border-color);">
                                <span class="label" style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 4px;">Valeur Actuelle</span>
                                <span class="amount" style="font-size: 24px; font-weight: 700; color: white;">${this.formatEUR(residence.currentValue)}</span>
                            </div>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                                <div>
                                    <span class="label" style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px;">Prix d'achat</span>
                                    <span class="amount" style="font-size: 14px; font-weight: 600;">${this.formatEUR(residence.purchasePrice)}</span>
                                </div>
                                <div>
                                    <span class="label" style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px;">Plus-value</span>
                                    <span class="amount ${latentGain >= 0 ? 'stat-positive' : 'stat-negative'}" style="font-size: 14px; font-weight: 600;">
                                        ${latentGain >= 0 ? '+' : ''}${this.formatEUR(latentGain)}
                                    </span>
                                </div>
                            </div>
                        </div>

                         <div style="background: var(--bg-secondary); border-radius: 12px; padding: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                            <div>
                                <span class="label" style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px;">Capital Restant</span>
                                <span class="amount" style="font-size: 15px; font-weight: 600; color: #ef4444;">${this.formatEUR(totalDebt)}</span>
                            </div>
                             <div>
                                <span class="label" style="display: block; color: var(--text-muted); font-size: 11px; margin-bottom: 2px;">Taux Moyen</span>
                                <span class="amount" style="font-size: 15px; font-weight: 600;">${weightedRate.toFixed(2)}%</span>
                            </div>
                         </div>

                        <div class="equity-banner" style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 18px; border-radius: 12px; text-align: center; color: white; margin-top: 16px;">
                            <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; opacity: 0.8;">Net Equity</div>
                            <div style="font-size: 32px; font-weight: 700; line-height: 1;">${this.formatEUR(equity)}</div>
                            <div style="font-size: 12px; margin-top: 6px; opacity: 0.9; background: rgba(255,255,255,0.2); display: inline-block; padding: 2px 8px; border-radius: 12px;">
                                ${((equity / residence.currentValue) * 100).toFixed(1)}% propriété
                            </div>
                        </div>

                    </div>
                </div>
            </div>
            
            <style>
                @media (max-width: 900px) {
                    .residence-dashboard { grid-template-columns: 1fr !important; }
                    .dashboard-right { order: -1; }
                }
            </style>
        `;
    }

    renderCreditCard(credit, referenceDate = new Date()) {
        const remaining = MortgageCalculator.calculateRemainingCapital(credit, referenceDate);
        const endDate = MortgageCalculator.getEndDate(credit);
        const monthlyPayment = MortgageCalculator.calculateMonthlyPayment(credit);
        const progress = MortgageCalculator.getRepaymentProgress(credit, referenceDate);
        const interestPaid = MortgageCalculator.calculateInterestPaid(credit, referenceDate);

        return `
            <div class="credit-card" style="background: var(--darker-bg); border-radius: 8px; padding: 14px; margin-bottom: 8px; border-left: 4px solid ${credit.rate === 0 ? '#10b981' : '#3b82f6'};">
                <div class="credit-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                    <h4 style="margin: 0;">
                        ${credit.name || 'Crédit'} 
                        <span style="color: ${credit.rate === 0 ? '#10b981' : '#f59e0b'}; font-weight: 700;">(${credit.rate.toFixed(2)}%)</span>
                    </h4>
                    <span class="monthly" style="font-size: 14px; color: var(--text-muted);">${this.formatEUR(monthlyPayment)}/mois</span>
                </div>
                <div class="credit-body">
                    <div class="credit-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
                        <span style="color: var(--text-muted);">Montant initial</span>
                        <span style="font-weight: 600;">${this.formatEUR(credit.initialAmount)}</span>
                    </div>
                    <div class="credit-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
                        <span style="color: var(--text-muted);">Capital restant</span>
                        <span class="remaining stat-negative" style="font-weight: 700;">${this.formatEUR(remaining)}</span>
                    </div>
                    ${credit.rate > 0 ? `
                    <div class="credit-row" style="display: flex; justify-content: space-between; margin-bottom: 8px; font-size: 13px;">
                        <span style="color: var(--text-muted);">Intérêts payés</span>
                        <span style="color: #f59e0b; font-weight: 600;">${this.formatEUR(interestPaid)}</span>
                    </div>
                    ` : ''}
                    <div class="credit-row" style="display: flex; justify-content: space-between; font-size: 13px;">
                        <span style="color: var(--text-muted);">Fin prévue</span>
                        <span>${endDate.toLocaleDateString('fr-FR', { month: '2-digit', year: 'numeric' })}</span>
                    </div>
                </div>
                <div class="credit-progress" style="height: 6px; background: var(--border-color); border-radius: 3px; overflow: hidden; margin-top: 10px;">
                    <div class="progress-bar" style="width: ${progress.toFixed(1)}%; height: 100%; background: linear-gradient(90deg, ${credit.rate === 0 ? '#10b981' : '#3b82f6'}, ${credit.rate === 0 ? '#34d399' : '#60a5fa'}); transition: width 0.3s ease;"></div>
                </div>
                <div style="text-align: right; margin-top: 4px; font-size: 11px; color: var(--text-muted);">
                    ${progress.toFixed(1)}% remboursé
                </div>
            </div>
        `;
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

        const rowId = `credit-row-${Date.now()}`;
        const row = document.createElement('div');
        row.className = 'credit-row-item';
        row.id = rowId;
        row.style.display = 'grid';
        row.style.gridTemplateColumns = '2fr 1.5fr 0.8fr 0.8fr 1.2fr 1.2fr 40px';
        row.style.gap = '10px';
        row.style.alignItems = 'end';
        row.style.background = 'var(--bg-secondary)';
        row.style.padding = '12px';
        row.style.borderRadius = '8px';
        row.style.marginBottom = '12px';

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
            <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Nom</label>
                <input type="text" class="form-input credit-name" value="${name}" placeholder="Nom" required style="width: 100%;">
            </div>
            <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Montant (€)</label>
                <input type="number" class="form-input credit-amount" value="${amount}" placeholder="Montant" step="any" required style="width: 100%;">
            </div>
            <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Taux (%)</label>
                <input type="number" class="form-input credit-rate" value="${rate}" placeholder="%" step="0.01" required style="width: 100%;">
            </div>
            <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Durée (mois)</label>
                <input type="number" class="form-input credit-duration" value="${duration}" placeholder="Mois" required style="width: 100%;">
            </div>
             <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Mensualité (Opt.)</label>
                <input type="number" class="form-input credit-monthly" value="${monthlyPayment}" placeholder="Calculé auto" step="any" style="width: 100%;">
            </div>
            <div style="min-width: 0;">
                <label style="font-size: 11px; color: var(--text-muted); white-space: nowrap;">Début</label>
                <input type="date" class="form-input credit-start" value="${startDateVal}" required style="width: 100%;">
            </div>
            <button type="button" class="btn-icon-danger" onclick="document.getElementById('${rowId}').remove()" title="Supprimer" style="height: 42px; margin-top: auto;">
                <i class="fas fa-trash"></i>
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

        await this.storage.savePrimaryResidence(residence);
        this.closePrimaryResidenceModal();
        this.renderPrimaryResidence();
    }

    formatEUR(amount) {
        return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
    }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
    const app = new RealEstateApp();
    window.realEstateApp = app;
    app.init();
});
