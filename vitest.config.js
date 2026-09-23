import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        setupFiles: ['./tests/setup.js'],
        include: ['tests/**/*.test.js'],
        // firestoreRules.test.js needs the Firestore emulator running (Java +
        // firebase-tools) — excluded from the default `npm test` run, executed
        // separately via `npm run test:rules` (wraps it in `firebase
        // emulators:exec`). Never silently skipped: CI runs both scripts.
        exclude: ['node_modules/**', 'tests/firestoreRules.test.js']
    }
});
