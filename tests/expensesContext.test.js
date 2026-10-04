// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';

let buildExpensesContext;
let formatExpensesContextAsText;

beforeAll(async () => {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const transactionDocs = [
    { id: 'salary', data: () => ({ accountId: 'checking', bookingDate: `${month}-02`, amount: 3000, direction: 'CRDT', description: 'Salaire' }) },
    { id: 'food', data: () => ({ accountId: 'checking', bookingDate: `${month}-03`, amount: -450, direction: 'DBIT', description: 'Carrefour' }) },
  ];
  const accountDocs = [
    { id: 'checking', data: () => ({ cashAccountType: 'CACC' }) },
  ];
  const db = {
    collection: vi.fn((path) => ({
      get: async () => path.endsWith('/transactions')
        ? { empty: false, docs: transactionDocs }
        : { empty: false, docs: accountDocs },
    })),
    doc: vi.fn(() => ({ get: async () => ({ data: () => ({}) }) })),
  };
  const auth = { currentUser: null, onAuthStateChanged: vi.fn(() => () => {}) };
  vi.stubGlobal('firebase', {
    apps: [],
    initializeApp: vi.fn(),
    app: vi.fn(),
    auth: vi.fn(() => auth),
    firestore: vi.fn(() => db),
  });

  ({ buildExpensesContext, formatExpensesContextAsText } = await import('../src/expensesContext.js'));
});

describe('expensesContext — données récentes', () => {
  it('utilise le mois courant comme période partielle lorsqu’aucun mois complet n’existe', async () => {
    const context = await buildExpensesContext('user-1');
    expect(context.usesPartialCurrentMonth).toBe(true);
    expect(context.monthsAnalyzed).toBe(1);
    expect(context.avgMonthlyIncome).toBe(3000);
    expect(context.avgMonthlyExpenses).toBe(450);
    expect(context.avgMonthlyCashflow).toBe(2550);
  });

  it('annonce explicitement que la période est partielle dans le prompt', async () => {
    const text = formatExpensesContextAsText(await buildExpensesContext('user-1'));
    expect(text).toContain('mois courant partiel');
    expect(text).toContain('Revenus moyens réels: 3000.00€/mois');
    expect(text).toContain('Dépenses moyennes réelles: 450.00€/mois');
  });
});
