import { describe, expect, it } from 'vitest';
import { InvestmentsPage } from '../src/investmentsPage.js';

describe('titre du graphique Investments', () => {
    it('affiche ensemble courtier, type et actif sélectionné', () => {
        const page = Object.create(InvestmentsPage.prototype);
        page.filterManager = { getSelectedTickers: () => new Set(['CSPX']) };
        page.currentBrokerFilter = 'TR';
        page.currentAssetTypeFilter = 'ETF';
        page.brokersList = [{ value: 'TR', label: 'Trade Republic' }];
        page.storage = {
            getPurchases: () => [{ ticker: 'CSPX', name: 'iShares S&P 500' }]
        };
        page.dataManager = { isCryptoTicker: () => false };

        expect(page.getChartTitleConfig()).toEqual({
            mode: 'asset',
            label: 'Trade Republic • ETF • CSPX • iShares S&P 500',
            icon: '📊'
        });

        // Le chemin direct showAssetChart(ticker) doit produire le même titre.
        expect(page.getChartTitleConfig('CSPX').label)
            .toBe('Trade Republic • ETF • CSPX • iShares S&P 500');
    });
});
