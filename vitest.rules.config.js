import { defineConfig } from 'vitest/config';

// Config séparée pour tests/firestoreRules.test.js — nécessite l'émulateur
// Firestore actif (voir `npm run test:rules`, qui l'enveloppe dans
// `firebase emulators:exec`). N'utilise pas tests/setup.js (stub Firebase v8
// compat) : ce fichier parle au VRAI SDK Firestore (modulaire) contre
// l'émulateur, pas au code applicatif.
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/firestoreRules.test.js'],
        testTimeout: 20000
    }
});
