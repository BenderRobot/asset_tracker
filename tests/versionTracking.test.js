import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { appendRelease, bumpFromMessage, checkRelease, nextVersion } from '../scripts/prepare-release.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('application version tracking', () => {
    it('publishes a coherent semantic build number', () => {
        const release = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));

        expect(release.major).toBeGreaterThanOrEqual(1);
        expect(release.minor).toBeGreaterThanOrEqual(0);
        expect(release.patch).toBeTypeOf('number');
        expect(release.build).toBeTypeOf('number');
        expect(release.build).toBeGreaterThan(0);
        expect(release.version).toBe(`${release.major}.${release.minor}.${release.patch}`);
        expect(release.source).toBe('feature-semver');
    });

    it('prevents Firebase from caching the public version manifest', () => {
        const firebase = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));

        for (const hosting of firebase.hosting) {
            const rule = hosting.headers?.find(header => header.source === '/version.json');
            const cacheControl = rule?.headers?.find(header => header.key.toLowerCase() === 'cache-control');
            expect(cacheControl?.value, `hosting target ${hosting.target}`)
                .toBe('no-cache, no-store, must-revalidate');
            expect(hosting.predeploy).toBe('node scripts/assert-hosting-release.mjs');
            expect(hosting.ignore).toContain('scripts/**');
        }
    });

    it('documents the reconstructed features, published patches and current version', () => {
        const release = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
        const history = readFileSync(join(root, 'RELEASES.md'), 'utf8');
        const releases = [...history.matchAll(/^\| `(\d+\.\d+\.\d+)` /gm)].map(match => match[1]);

        for (let minor = 0; minor <= 17; minor++) expect(releases).toContain(`1.${minor}.0`);
        expect(releases.at(-1)).toBe(release.version);
        expect(releases).toContain('1.17.1');
        expect(checkRelease(release, history)).toBe(true);
    });

    it('prepares the release before tests and verifies the version served after deployment', () => {
        for (const name of ['deploy.ps1', 'deploy-beta.ps1']) {
            const script = readFileSync(join(root, name), 'utf8');
            expect(script).toContain("'scripts/prepare-release.mjs'");
            const preparation = script.indexOf('node @releaseArgs');
            const gate = name === 'deploy.ps1' ? 'Invoke-TestGate "version preparee, code final"' : 'npm test';
            expect(script.indexOf(gate, preparation)).toBeGreaterThan(preparation);
            expect(script).toContain('scripts/prepare-release.mjs --check --committed');
            expect(script).toContain('check-live-version.ps1');
            expect(script).toContain('-Exact');
        }
        const hook = readFileSync(join(root, '.githooks/prepare-commit-msg'), 'utf8');
        expect(hook).toContain('git add version.json RELEASES.md');
        expect(readFileSync(join(root, 'src/sidebar-render.js'), 'utf8')).toContain("fetch('/version.json?t=' + Date.now(), { cache: 'no-store' })");
    });

    it('increments once by commit type and appends releases without duplicates', () => {
        expect(bumpFromMessage('fix: correction')).toBe('patch');
        expect(bumpFromMessage('feat: nouvelle vue')).toBe('minor');
        expect(bumpFromMessage('feat!: changement majeur')).toBe('major');
        expect(nextVersion('1.17.1', 'patch')).toBe('1.17.2');
        expect(nextVersion('1.17.1', 'minor')).toBe('1.18.0');
        const history = '# Historique\n\n| Version | Date | Fonction | Commit |\n|---|---|---|---|\n| `1.17.0` | 2026-10-01 | Ancienne | x |\n';
        const updated = appendRelease(history, '1.17.1', 'fix: test', '2026-10-12');
        expect(updated).toContain('| `1.17.1` | 2026-10-12 | fix: test | — |');
        expect(appendRelease(updated, '1.17.1', 'fix: test')).toBe(updated);
    });

    it('blocks a direct Hosting publication without a prepared release', () => {
        const run = spawnSync(process.execPath, ['scripts/assert-hosting-release.mjs'], {
            cwd: root, encoding: 'utf8', env: { ...process.env, ASSET_TRACKER_RELEASE_ID: '' }
        });
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('Publication Hosting bloquée');
    });
});
