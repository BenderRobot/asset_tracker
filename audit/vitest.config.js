import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        setupFiles: ['./tests/setup.js'],
        include: ['audit/chart-generator.repro.test.js']
    }
});
