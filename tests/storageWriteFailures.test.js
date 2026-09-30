// Audit (partie 4, P1) : les écritures Firestore échouaient en silence. Une
// suppression refusée retirait la ligne localement, l'erreur partait en
// console, puis la ligne « réapparaissait » sans explication. Ces tests
// exécutent les VRAIES méthodes de Storage contre un Firestore simulé qui
// peut refuser une écriture : l'erreur doit remonter à l'appelant et l'état
// local doit revenir à l'identique.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const firestore = vi.hoisted(() => ({ failWith: null, writes: [] }));

vi.mock('../src/firebaseConfig.js', () => {
    const write = (op, path) => async () => {
        firestore.writes.push({ op, path });
        if (firestore.failWith) throw firestore.failWith;
    };
    const doc = (path) => ({
        update: write('update', path),
        delete: write('delete', path),
        set: write('set', path),
        collection: (name) => collection(`${path}/${name}`),
    });
    const collection = (path) => ({
        doc: (id) => doc(`${path}/${id}`),
        add: async () => { await write('add', path)(); return { id: 'new-id' }; },
    });
    return {
        auth: { currentUser: { uid: 'u1' }, onAuthStateChanged: () => () => {} },
        db: {
            collection,
            batch: () => {
                const ops = [];
                return {
                    delete: (ref) => ops.push(ref),
                    commit: async () => {
                        firestore.writes.push({ op: 'batch', count: ops.length });
                        if (firestore.failWith) throw firestore.failWith;
                    },
                };
            },
        },
    };
});

const { Storage } = await import('../src/storage.js');

const events = [];
globalThis.window = { dispatchEvent: (e) => events.push(e.type) };

function permissionDenied() {
    return Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
}

function makeStorage(purchases) {
    const storage = Object.create(Storage.prototype);
    storage.purchases = purchases.map(p => ({ ...p }));
    storage.watchlist = [];
    storage.watchlistGroups = [];
    storage.rebuildIndex();
    return storage;
}

const A = { ticker: 'AAPL', name: 'Apple', price: 100, quantity: 1, date: '2026-01-02', broker: 'RV-CT', firestoreId: 'fa' };
const B = { ticker: 'MSFT', name: 'Microsoft', price: 300, quantity: 2, date: '2026-01-03', broker: 'RV-CT', firestoreId: 'fb' };

beforeEach(() => {
    firestore.failWith = null;
    firestore.writes.length = 0;
    events.length = 0;
    localStorage.clear();
});

describe('Storage — une écriture Firestore refusée n\'est jamais silencieuse', () => {
    it('removePurchase : rejette, et la transaction est remise localement', async () => {
        const storage = makeStorage([A, B]);
        firestore.failWith = permissionDenied();

        const pending = storage.removePurchase(storage.getRowKey(A));
        // Suppression optimiste immédiate (avant la réponse réseau)
        expect(storage.purchases.map(p => p.ticker)).toEqual(['MSFT']);

        await expect(pending).rejects.toMatchObject({ code: 'permission-denied' });
        expect(storage.purchases.map(p => p.ticker).sort()).toEqual(['AAPL', 'MSFT']);
        expect(storage.getPurchaseByKey(storage.getRowKey(A))).toMatchObject({ firestoreId: 'fa' });
        expect(JSON.parse(localStorage.getItem('purchases'))).toHaveLength(2);
        expect(events).toContain('purchases-updated');
    });

    it('removePurchase : succès → résout true, la ligne reste supprimée', async () => {
        const storage = makeStorage([A, B]);
        await expect(storage.removePurchase(storage.getRowKey(A))).resolves.toBe(true);
        expect(storage.purchases.map(p => p.ticker)).toEqual(['MSFT']);
        expect(firestore.writes).toEqual([{ op: 'delete', path: 'users/u1/purchases/fa' }]);
    });

    it('updatePurchase : rejette, et la version d\'origine est restaurée', async () => {
        const storage = makeStorage([A]);
        firestore.failWith = permissionDenied();

        await expect(storage.updatePurchase(storage.getRowKey(A), { price: 999 })).rejects.toThrow();
        expect(storage.purchases).toHaveLength(1);
        expect(storage.purchases[0].price).toBe(100);
        expect(storage.purchases[0].updatedAt).toBeUndefined();
    });

    it('removePurchases (lot) : rejette, et toutes les lignes sont remises', async () => {
        const storage = makeStorage([A, B]);
        firestore.failWith = permissionDenied();

        const keys = new Set([storage.getRowKey(A), storage.getRowKey(B)]);
        await expect(storage.removePurchases(keys)).rejects.toThrow();
        expect(storage.purchases.map(p => p.ticker).sort()).toEqual(['AAPL', 'MSFT']);
    });

    it('rollback idempotent : si onSnapshot a déjà remis la ligne, pas de doublon', async () => {
        const storage = makeStorage([A, B]);
        firestore.failWith = permissionDenied();

        const pending = storage.removePurchase(storage.getRowKey(A));
        // L'onSnapshot revient à l'état serveur avant que la promesse ne rejette
        storage.purchases = [{ ...A }, { ...B }];
        storage.rebuildIndex();

        await expect(pending).rejects.toThrow();
        expect(storage.purchases.filter(p => p.firestoreId === 'fa')).toHaveLength(1);
    });

    it('removeFromWatchlist : rejette, et le titre reste suivi', async () => {
        const storage = makeStorage([]);
        storage.watchlist = [{ ticker: 'NVDA', name: 'Nvidia' }];
        firestore.failWith = permissionDenied();

        await expect(storage.removeFromWatchlist('nvda')).rejects.toThrow();
        expect(storage.isInWatchlist('NVDA')).toBe(true);
        expect(events).toContain('watchlist-updated');
    });

    it('deleteWatchlistGroup : rejette, et le groupe est restauré', async () => {
        const storage = makeStorage([]);
        storage.watchlistGroups = [{ id: 'g1', name: 'Tech', tickers: ['AAPL'] }];
        firestore.failWith = permissionDenied();

        await expect(storage.deleteWatchlistGroup('g1')).rejects.toThrow();
        expect(storage.watchlistGroups).toEqual([{ id: 'g1', name: 'Tech', tickers: ['AAPL'] }]);
    });

    it('addTickerToGroup : rejette, et le groupe revient à son contenu initial', async () => {
        const storage = makeStorage([]);
        storage.watchlistGroups = [{ id: 'g1', name: 'Tech', tickers: ['AAPL'] }];
        firestore.failWith = permissionDenied();

        await expect(storage.addTickerToGroup('g1', 'MSFT')).rejects.toThrow();
        expect(storage.watchlistGroups[0].tickers).toEqual(['AAPL']);
    });

    it('savePrimaryResidence : rejette, et la valeur locale précédente est restaurée', async () => {
        const storage = makeStorage([]);
        const before = { id: 'r1', name: 'Maison', currentValue: 300000 };
        localStorage.setItem('assetTracker_primaryResidence', JSON.stringify(before));
        firestore.failWith = permissionDenied();

        await expect(storage.savePrimaryResidence({ id: 'r1', name: 'Maison', currentValue: 1 })).rejects.toThrow();
        expect(storage.getPrimaryResidence()).toEqual(before);
    });
});
