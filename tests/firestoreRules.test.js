// Tests RÉELS des règles Firestore (firestore.rules), exécutés contre le vrai
// moteur de règles via l'émulateur Firestore — pas une relecture manuelle des
// règles. Nécessite Java + firebase-tools (émulateur) : exécuté séparément via
// `npm run test:rules` (voir package.json), qui lance `firebase emulators:exec`
// autour de ce fichier. Exclu du `npm test` par défaut (vitest.config.js) —
// jamais silencieusement ignoré : la CI exécute les deux scripts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import {
    initializeTestEnvironment,
    assertSucceeds,
    assertFails
} from '@firebase/rules-unit-testing';

const PROJECT_ID = 'demo-asset-tracker-rules-test';
let testEnv;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: readFileSync('firestore.rules', 'utf8'),
            host: '127.0.0.1',
            port: 8080
        }
    });
});

afterAll(async () => {
    await testEnv.cleanup();
});

beforeEach(async () => {
    await testEnv.clearFirestore();
});

const ALICE = 'alice-uid';
const BOB = 'bob-uid';
const ADMIN = 'admin-uid';

function asAlice() { return testEnv.authenticatedContext(ALICE).firestore(); }
function asBob() { return testEnv.authenticatedContext(BOB).firestore(); }
function asAdmin() { return testEnv.authenticatedContext(ADMIN).firestore(); }
function asAnon() { return testEnv.unauthenticatedContext().firestore(); }

// Seed sans passer par les règles (contexte admin RTDB-style de la lib de test).
async function seedAdminFlag() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc(`users/${ADMIN}`).set({ isAdmin: true, email: 'admin@test.dev' });
    });
}

describe('PRIVILEGE ESCALATION — users/{userId}.isAdmin', () => {
    beforeEach(seedAdminFlag);

    it('un utilisateur normal ne peut PAS créer son document avec isAdmin=true', async () => {
        await assertFails(
            asAlice().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: true })
        );
    });

    it('un utilisateur normal peut créer son document SANS isAdmin (ou isAdmin=false)', async () => {
        await assertSucceeds(
            asAlice().doc(`users/${ALICE}`).set({ email: 'alice@test.dev' })
        );
        await assertSucceeds(
            asBob().doc(`users/${BOB}`).set({ email: 'bob@test.dev', isAdmin: false })
        );
    });

    it('un utilisateur normal ne peut PAS s\'octroyer isAdmin=true par un update ultérieur', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: false });
        });
        await assertFails(
            asAlice().doc(`users/${ALICE}`).update({ isAdmin: true })
        );
    });

    it('un utilisateur normal reste bloqué même en essayant de RÉÉCRIRE tout le document avec isAdmin=true (set non-merge)', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: false });
        });
        await assertFails(
            asAlice().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: true })
        );
    });

    it('une modification normale de ses propres données (hors isAdmin) reste autorisée', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: false });
        });
        await assertSucceeds(
            asAlice().doc(`users/${ALICE}`).update({ displayName: 'Alice', theme: 'dark' })
        );
    });

    it('un admin réel PEUT accorder le rôle admin à un autre utilisateur', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: false });
        });
        await assertSucceeds(
            asAdmin().doc(`users/${ALICE}`).update({ isAdmin: true })
        );
    });

    it('un utilisateur normal ne peut pas lire des invitationCodes en liste (accès admin refusé)', async () => {
        await assertFails(asAlice().collection('invitationCodes').get());
    });

    it('un admin réel peut lister les invitationCodes', async () => {
        await assertSucceeds(asAdmin().collection('invitationCodes').get());
    });
});

describe('MULTI-TENANT ISOLATION — un utilisateur ne peut jamais toucher les données d\'un autre', () => {
    beforeEach(async () => {
        await seedAdminFlag();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${BOB}`).set({ email: 'bob@test.dev', isAdmin: false });
            await ctx.firestore().doc(`users/${BOB}/purchases/p1`).set({ ticker: 'AAPL', quantity: 10 });
            await ctx.firestore().doc(`users/${BOB}/settings/prefs`).set({ theme: 'dark' });
            await ctx.firestore().doc(`users/${BOB}/bankAccounts/acc1`).set({ iban: 'FR7600000000000000000000', balance: 1000 });
            await ctx.firestore().doc(`users/${BOB}/transactions/tx1`).set({ amount: -42, description: 'Courses' });
        });
    });

    it('Alice ne peut pas lire les achats de Bob', async () => {
        await assertFails(asAlice().doc(`users/${BOB}/purchases/p1`).get());
    });

    it('Alice ne peut pas écrire dans les settings de Bob', async () => {
        await assertFails(asAlice().doc(`users/${BOB}/settings/prefs`).set({ theme: 'hacked' }));
    });

    it('Alice ne peut pas lire le compte bancaire de Bob', async () => {
        await assertFails(asAlice().doc(`users/${BOB}/bankAccounts/acc1`).get());
    });

    it('Alice ne peut pas supprimer une transaction de Bob', async () => {
        await assertFails(asAlice().doc(`users/${BOB}/transactions/tx1`).delete());
    });

    it('un utilisateur non authentifié ne peut rien lire chez Bob', async () => {
        await assertFails(asAnon().doc(`users/${BOB}/purchases/p1`).get());
    });

    it('Bob peut toujours lire ses propres données', async () => {
        await assertSucceeds(asBob().doc(`users/${BOB}/purchases/p1`).get());
    });
});

describe('BANK DATA — le client ne peut plus falsifier des données synchronisées', () => {
    beforeEach(async () => {
        await seedAdminFlag();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await ctx.firestore().doc(`users/${ALICE}`).set({ email: 'alice@test.dev', isAdmin: false });
            await ctx.firestore().doc(`users/${ALICE}/bankAccounts/acc1`).set({ iban: 'FR7600000000000000000000', balance: 1000 });
            await ctx.firestore().doc(`users/${ALICE}/transactions/tx1`).set({ amount: -42, description: 'Courses' });
            await ctx.firestore().doc(`users/${ALICE}/bankConnections/conn1`).set({ aspspName: 'Revolut', accountUids: ['acc1'] });
        });
    });

    it('un utilisateur ne peut pas modifier le solde de son propre compte bancaire', async () => {
        await assertFails(
            asAlice().doc(`users/${ALICE}/bankAccounts/acc1`).update({ balance: 999999 })
        );
    });

    it('un utilisateur ne peut pas créer une fausse transaction sur son propre compte', async () => {
        await assertFails(
            asAlice().doc(`users/${ALICE}/transactions/fake`).set({ amount: 100000, description: 'Fake credit' })
        );
    });

    it('un utilisateur ne peut pas modifier une transaction synchronisée existante', async () => {
        await assertFails(
            asAlice().doc(`users/${ALICE}/transactions/tx1`).update({ amount: 0 })
        );
    });

    it('un utilisateur peut toujours LIRE ses propres données bancaires', async () => {
        await assertSucceeds(asAlice().doc(`users/${ALICE}/bankAccounts/acc1`).get());
        await assertSucceeds(asAlice().doc(`users/${ALICE}/transactions/tx1`).get());
    });

    it('un utilisateur peut toujours SUPPRIMER une connexion bancaire (déconnexion) et ses comptes/transactions', async () => {
        await assertSucceeds(asAlice().doc(`users/${ALICE}/bankConnections/conn1`).delete());
        await assertSucceeds(asAlice().doc(`users/${ALICE}/bankAccounts/acc1`).delete());
        await assertSucceeds(asAlice().doc(`users/${ALICE}/transactions/tx1`).delete());
    });

    it('les écritures admin (proxy des écritures backend légitimes) restent possibles', async () => {
        await assertSucceeds(
            asAdmin().doc(`users/${ALICE}/bankAccounts/acc1`).update({ balance: 1500 })
        );
        await assertSucceeds(
            asAdmin().doc(`users/${ALICE}/transactions/tx2`).set({ amount: -10, description: 'Synced by backend' })
        );
    });

    it('un AUTRE utilisateur ne peut ni lire ni écrire les données bancaires d\'Alice', async () => {
        await assertFails(asBob().doc(`users/${ALICE}/bankAccounts/acc1`).get());
        await assertFails(asBob().doc(`users/${ALICE}/bankAccounts/acc1`).update({ balance: 0 }));
        await assertFails(asBob().doc(`users/${ALICE}/transactions/tx1`).delete());
    });
});
