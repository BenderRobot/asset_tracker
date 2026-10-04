// @vitest-environment jsdom
//
// BUG FOUND (audit XSS, P1) : AssistantApp.formatMessage() injectait le texte
// (message utilisateur OU réponse Gemini — avec recherche web activée, donc
// capable de citer du contenu externe) dans innerHTML après de simples
// transformations markdown, SANS jamais l'échapper au préalable. Un contenu
// contenant du HTML/JS littéral s'exécutait tel quel dans le DOM du chat.
import { describe, it, expect } from 'vitest';
import { AssistantApp } from '../src/assistantApp.js';

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
    function buildPrompt(overrides = {}) {
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
            byType: [{ type: 'Stock', count: 1, totalValue: 250, weight: 2 }],
            byBroker: [{ broker: 'Broker', assetsCount: 1, totalInvested: 200 }],
            performance: { topPerformers: [{ ticker: 'TEST', gainPct: 25 }], worstPerformers: [], avgGain: 25, winRate: 100 },
            diversification: { diversityScore: 100, effectiveAssets: 1, recommendation: 'Concentré' },
            dividends: { count: 1, total: 12.5 },
            transactions: [{ date: '2026-01-01', type: 'buy', ticker: 'TEST', quantity: 2, price: 100, currency: 'EUR', broker: 'Broker' }],
            watchlist: [{ ticker: 'WATCH', name: 'Watch Asset', targetPrice: 42 }],
            watchlistGroups: [],
            primaryResidence: null,
            ...overrides,
        };
        return AssistantApp.prototype.buildSystemPrompt.call({
            portfolioContext,
            expensesContext: null,
            getActiveConversation: () => ({ messages: [] }),
        });
    }

    it('inclut cash, dividendes, historique et watchlist', () => {
        const prompt = buildPrompt();
        expect(prompt).toContain('Cash disponible: 1200€');
        expect(prompt).toContain('1 versement(s), total enregistré=12.5€');
        expect(prompt).toContain('2026-01-01 | buy | TEST');
        expect(prompt).toContain('WATCH (Watch Asset), objectif=42');
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
});
