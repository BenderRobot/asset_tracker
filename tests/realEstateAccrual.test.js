import { describe, it, expect } from 'vitest';
import { DataManager } from '../src/dataManager.js';
import { createFakeStorage, createFakeApi, purchase } from './helpers.js';

describe('Real Estate accrual', () => {
    const dm = new DataManager(createFakeStorage(), createFakeApi());
    const project = purchase({
        ticker: 'IMMO-1', assetType: 'Real Estate', price: 1000, quantity: 1,
        date: '2025-01-01', maturityDate: '2026-01-01', yield: 10
    });

    it('accrues simple interest day by day before maturity', () => {
        const { accrued, matured } = dm.calculateRealEstateAccrual(project, new Date('2025-07-02'));
        expect(accrued).toBeCloseTo(1000 * 0.10 * (182 / 365), 6);
        expect(matured).toBe(false);
    });

    it('stops accruing exactly on the maturity day', () => {
        const atMaturity = dm.calculateRealEstateAccrual(project, new Date('2026-01-01'));
        const afterMaturity = dm.calculateRealEstateAccrual(project, new Date('2027-06-15'));

        expect(atMaturity.accrued).toBeCloseTo(100, 6);
        expect(atMaturity.matured).toBe(true);
        expect(afterMaturity.accrued).toBe(atMaturity.accrued);
        expect(afterMaturity.currentValue).toBeCloseTo(1100, 6);
        expect(afterMaturity.daysHeld).toBe(365);
    });

    it('keeps accruing when no (or an invalid) maturity date is set', () => {
        const asOf = new Date('2027-01-01');
        const noMaturity = dm.calculateRealEstateAccrual({ ...project, maturityDate: null }, asOf);
        const invalid = dm.calculateRealEstateAccrual({ ...project, maturityDate: 'not-a-date' }, asOf);

        expect(noMaturity.accrued).toBeCloseTo(1000 * 0.10 * (730 / 365), 6);
        expect(invalid.accrued).toBe(noMaturity.accrued);
        expect(noMaturity.matured).toBe(false);
    });
});
