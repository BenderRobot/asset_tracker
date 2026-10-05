// @vitest-environment jsdom
//
// BUG FOUND (audit XSS, P1) : AssistantApp.formatMessage() injectait le texte
// (message utilisateur OU réponse Gemini — avec recherche web activée, donc
// capable de citer du contenu externe) dans innerHTML après de simples
// transformations markdown, SANS jamais l'échapper au préalable. Un contenu
// contenant du HTML/JS littéral s'exécutait tel quel dans le DOM du chat.
import { describe, it, expect } from 'vitest';
import { AssistantApp, messageNeedsFreshMarketData } from '../src/assistantApp.js';

// formatMessage()/escapeHtml() ne dépendent d'aucun autre état d'instance —
// appelées directement sur le prototype, sans construire un AssistantApp
// complet (son constructeur fait de l'init Firebase/DOM hors de propos ici).
function formatMessage(text) {
    return AssistantApp.prototype.formatMessage.call(AssistantApp.prototype, text);
}

describe('AssistantApp.formatMessage — échappement XSS (P1)', () => {
    it('un <script> littéral dans le texte ne devient jamais un vrai élément script', () => {
        const html = formatMessage('<script>alert(1)</script>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('un tag avec gestionnaire d\'événement (payload IMG onerror) est neutralisé', () => {
        const html = formatMessage('<img src=x onerror=alert(1)>');
        expect(html).not.toMatch(/<img/i);
        expect(html).toContain('&lt;img');
    });

    it('le rendu markdown légitime (gras/italique/code/saut de ligne) continue de fonctionner', () => {
        const html = formatMessage('**gras** et *italique* et `code`\nligne suivante');
        expect(html).toContain('<strong>gras</strong>');
        expect(html).toContain('<em>italique</em>');
        expect(html).toContain('<code>code</code>');
        expect(html).toContain('<br>');
    });

    it('un texte contenant à la fois du HTML dangereux et du markdown : le markdown reste rendu, le HTML reste neutralisé', () => {
        const html = formatMessage('**Alerte** <script>alert(1)</script> important');
        expect(html).toContain('<strong>Alerte</strong>');
        expect(html).not.toContain('<script>');
    });
});

describe('AssistantApp.buildSystemPrompt — contrat de données Gemini', () => {
    function buildPrompt(overrides = {}, expensesContext = null) {
        const portfolioContext = {
            summary: {
                totalValue: 12500,
                totalInvested: 10000,
                totalGain: 2500,
                gainPercentage: 25,
                dayChange: 50,
                dayChangePercentage: 0.4,
                cash: 1200,
                assetsCount: 1,
                status: 'valid',
                sourceStale: false,
                staleInstruments: [],
            },
            holdings: [{
                ticker: 'TEST', name: 'Test Asset', quantity: 2, avgPrice: 100,
                currentValue: 250, gainEUR: 50, gainPct: 25, weight: 2,
                brokers: 'Broker', firstPurchase: '2026-01-01', lastPurchase: '2026-02-01'
            }],
            allocation: { status: 'available', basis: 'current_market_value_including_cash', total: 1450, unavailable: [] },
            byType: [
                { type: 'Stock', label: 'Actions', count: 1, totalValue: 250, weight: 17.2 },
                { type: 'Cash', label: 'Cash', count: null, totalValue: 1200, weight: 82.8 }
            ],
            byBroker: [{ broker: 'Broker', assetsCount: 1, totalInvested: 200 }],
            performance: { topPerformers: [{ ticker: 'TEST', gainPct: 25 }], worstPerformers: [], avgGain: 25, winRate: 100 },
            diversification: {
                status: 'available', scope: 'positions_excluding_cash', diversityScore: 100,
                herfindahl: 1, effectiveAssets: 1, totalAssets: 1, recommendation: 'Concentré'
            },
            risk: {
                status: 'available', reason: null, periodDays: 365, observations: 252,
                volatility: 12.34, maxDrawdown: -8.5, annualizedReturn: 9.1,
                sharpeRatio: 0.74, riskLevel: 'Modéré', includesDividends: true,
                cashIncluded: true, excludedRealEstate: 1, failedInstruments: [],
                recommendation: 'Risque calculé sur l’historique.',
                assets: [{ ticker: 'TEST', volatility: 15.2, maxDrawdown: -10, observations: 250 }]
            },
            dividends: { count: 1, total: 12.5 },
            transactions: [{ date: '2026-01-01', type: 'buy', ticker: 'TEST', quantity: 2, price: 100, currency: 'EUR', broker: 'Broker' }],
            watchlist: [{ ticker: 'WATCH', name: 'Watch Asset', targetPrice: 42 }],
            watchlistGroups: [],
            primaryResidence: null,
            ...overrides,
        };
        return AssistantApp.prototype.buildSystemPrompt.call({
            portfolioContext,
            expensesContext,
            getActiveConversation: () => ({ messages: [] }),
        });
    }

    it('inclut cash, dividendes, historique et watchlist', () => {
        const prompt = buildPrompt();
        expect(prompt).toContain('Cash disponible: 1200€');
        expect(prompt).toContain('1 versement(s), total enregistré=12.5€');
        expect(prompt).toContain('2026-01-01 | buy | TEST');
        expect(prompt).toContain('WATCH (Watch Asset), objectif=42');
        expect(prompt).toContain('ALLOCATION ACTUELLE PAR TYPE (CASH INCLUS)');
        expect(prompt).toContain('Cash: poche de liquidités, 1200€ (82.8%)');
        expect(prompt).toContain('poids valeur actuelle cash inclus=2%');
        expect(prompt).toContain('Périmètre du score: positions uniquement, hors cash');
    });

    it('transmet la performance intraday de chaque position sans la confondre avec le gain total', () => {
        const prompt = buildPrompt({
            holdings: [{
                ticker: 'SU.PA', name: 'Schneider Electric', quantity: 5,
                avgPrice: 239.85, currentPrice: 275.2, previousClose: 302.42,
                currentValue: 1376, dayChange: -136.1, dayPct: -9,
                dayDataStatus: 'available', gainEUR: 176.75, gainPct: 14.74,
                weight: 11, brokers: 'BB-PEA', firstPurchase: '2025-01-01', lastPurchase: '2025-01-01'
            }]
        });

        expect(prompt).toContain('cours actuel=275.2€');
        expect(prompt).toContain('clôture de référence=302.42€');
        expect(prompt).toContain('performance intraday=-136.1€ (-9%)');
        expect(prompt).toContain('gain total depuis achat=176.75€ (14.74%)');
        expect(prompt).toContain('=== PERFORMANCE INTRADAY PAR ACTIF ===');
    });

    it('ne transforme jamais une cotation absente en zéro', () => {
        const prompt = buildPrompt({
            holdings: [{
                ticker: 'TEST', name: 'Test Asset', quantity: 2, avgPrice: null,
                currentValue: null, gainEUR: null, gainPct: null, weight: null,
                brokers: 'Broker', firstPurchase: '2026-01-01', lastPurchase: '2026-02-01'
            }]
        });
        expect(prompt).toContain('PRU=indisponible');
        expect(prompt).toContain('valeur=indisponible');
        expect(prompt).not.toContain('PRU=0€');
    });

    it('décrit un total de dividendes multidevise incomplet sans inventer un total EUR', () => {
        const prompt = buildPrompt({
            dividends: {
                count: 2,
                totalEUR: null,
                knownTotalEUR: 25,
                unavailableCount: 1,
                conversionStatus: 'partial',
                byCurrency: [
                    { currency: 'EUR', amount: 25, count: 1, invalidCount: 0 },
                    { currency: 'USD', amount: 100, count: 1, invalidCount: 0 }
                ]
            }
        });

        expect(prompt).toContain('Total reçu en EUR (conversion historique): indisponible');
        expect(prompt).toContain('Montant EUR connu seulement: 25€');
        expect(prompt).toContain('100 USD');
        expect(prompt).toContain('ne pas présenter le montant EUR connu comme le total');
    });

    it('ne transforme pas en zéro un investi par courtier dont la conversion historique manque', () => {
        const prompt = buildPrompt({
            byBroker: [{
                broker: 'Broker USD',
                assetsCount: 2,
                totalInvested: null,
                knownTotalInvested: 100,
                fxUnavailable: true,
                unavailableAssets: ['AAPL']
            }]
        });

        expect(prompt).toContain('investi total=indisponible');
        expect(prompt).toContain('sous-total EUR connu=100€');
        expect(prompt).toContain('conversion historique manquante pour AAPL');
        expect(prompt).toContain('Ne pas présenter le sous-total connu comme le total');
        expect(prompt).not.toContain('0€ investi');
    });

    it('transmet la vue complète par courtier, les transactions EUR et les positions clôturées', () => {
        const prompt = buildPrompt({
            byBroker: [{
                broker: 'Broker A', status: 'complete', assetsCount: 1,
                invested: 100, knownInvested: 100, currentValue: 150,
                knownCurrentValue: 150, unrealizedPnl: 50, cash: 20,
                knownCash: 20, totalValue: 170, knownTotalValue: 170,
                weight: 100, unavailable: []
            }],
            transactions: [{
                date: '2026-01-01', action: 'sell', ticker: 'TEST', quantity: -2,
                unitPrice: 120, currency: 'USD', nativeAmount: 240,
                historicalFxRate: 0.9, amountEUR: 216,
                conversionStatus: 'complete', broker: 'Broker A'
            }],
            closedPositions: [{
                ticker: 'OLD', name: 'Ancienne ligne', status: 'complete',
                brokers: ['Broker A'], firstPurchase: '2024-01-01', lastSale: '2025-01-01',
                costBasisEUR: 100, proceedsEUR: 140, realizedPnlEUR: 40,
                realizedPnlPct: 40, knownCostBasisEUR: 100, knownProceedsEUR: 140
            }]
        });

        expect(prompt).toContain('valeur actuelle=150€');
        expect(prompt).toContain('plus-value latente=50€');
        expect(prompt).toContain('valeur totale cash inclus=170€');
        expect(prompt).toContain('contre-valeur historique=216€');
        expect(prompt).toContain('Le produit d’une vente n’est pas une plus-value'.replaceAll('’', "'"));
        expect(prompt).toContain('résultat réalisé avant frais/fiscalité=40€');
    });

    it('calcule le patrimoine enregistré sans recompter le cash courtier ni la dette immobilière', () => {
        const prompt = buildPrompt({
            summary: {
                totalValue: 1000, totalInvested: 800, totalGain: 200,
                gainPercentage: 25, dayChange: 0, dayChangePercentage: 0,
                cash: 200, assetsCount: 1, status: 'valid', sourceStale: false,
                staleInstruments: []
            },
            primaryResidence: {
                name: 'Maison', equity: 100000, totalDebt: 50000,
                debtStatus: 'complete', credits: []
            }
        }, {
            generatedAt: Date.now(), bankAccounts: [
                { name: 'Compte courant', currency: 'EUR', balance: 500 }
            ], totalBankBalanceEUR: 500, fixedCharges: [], fixedIncome: [],
            categoryBreakdown: [], nonEuroTransactions: [], usesPartialCurrentMonth: false
        });

        expect(prompt).toContain('Patrimoine net total enregistré: 101500€');
        expect(prompt).toContain('Cash chez les courtiers: 200€');
        expect(prompt).toContain('Dette immobilière déjà déduite de cette équité: 50000€');
        expect(prompt).toContain('n’est ajouté qu’une fois');
    });

    it('transmet les vraies métriques historiques de risque et leur méthode à Gemini', () => {
        const prompt = buildPrompt();

        expect(prompt).toContain('=== RISQUE HISTORIQUE ===');
        expect(prompt).toContain('Volatilité annualisée: 12.34%');
        expect(prompt).toContain('Drawdown maximal: -8.50%');
        expect(prompt).toContain('Ratio de Sharpe (taux sans risque 0%): 0.74');
        expect(prompt).toContain('dividendes inclus; cash inclus comme poche sans risque; immobilier exclu=1 actif(s)');
        expect(prompt).toContain('TEST: volatilité annualisée=15.20%');
    });

    it('explique pourquoi le risque est indisponible sans convertir les métriques absentes en zéro', () => {
        const prompt = buildPrompt({
            risk: {
                status: 'unavailable', reason: 'INSUFFICIENT_OBSERVATIONS',
                periodDays: 365, observations: 4, minimumObservations: 20,
                volatility: null, maxDrawdown: null, annualizedReturn: null,
                sharpeRatio: null, riskLevel: 'Indisponible', includesDividends: true,
                cashIncluded: true, excludedRealEstate: 0, failedInstruments: [],
                recommendation: 'Historique insuffisant.', assets: []
            }
        });

        expect(prompt).toContain('Motif d’indisponibilité: INSUFFICIENT_OBSERVATIONS'.replace('’', "'"));
        expect(prompt).toContain('Rendements observés: 4 (minimum requis: 20)');
        expect(prompt).toContain('Volatilité annualisée: indisponible');
        expect(prompt).not.toContain('Volatilité annualisée: 0.00%');
    });

    it('transmet à Gemini la dette immobilière restante et les mensualités actuelles', () => {
        const prompt = buildPrompt({
            primaryResidence: {
                name: 'Maison', purchasePrice: 200000, currentValue: 250000,
                purchaseDate: '2020-01-01', debtAsOf: '2025-01-01', creditsCount: 1,
                totalDebt: 60000, equity: 190000, totalMonthlyPayment: 1000,
                weightedRate: 0, debtStatus: 'complete',
                credits: [{
                    name: 'PTZ', status: 'active', initialAmount: 120000,
                    remainingCapital: 60000, rate: 0, monthlyPayment: 1000,
                    currentMonthlyPayment: 1000, startDate: '2020-01-01', endDate: '2030-01-01'
                }]
            }
        });

        expect(prompt).toContain('Capital restant dû au 2025-01-01: 60000€');
        expect(prompt).toContain('Équité nette: 190000€');
        expect(prompt).toContain('Mensualités actuelles: 1000€/mois');
        expect(prompt).toContain('capital initial=120000€, capital restant=60000€');
    });
});

describe('AssistantApp intraday refresh routing', () => {
    it('force un rafraîchissement pour les demandes du jour en français ou avec today', () => {
        expect(messageNeedsFreshMarketData('Pourquoi Schneider est en perte de 9% today ?')).toBe(true);
        expect(messageNeedsFreshMarketData("Pourquoi Schneider baisse aujourd'hui ?")).toBe(true);
        expect(messageNeedsFreshMarketData('Analyse ma diversification long terme')).toBe(false);
    });
});
