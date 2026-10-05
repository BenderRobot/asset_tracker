import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));

describe('application version tracking', () => {
    it('publishes a coherent semantic build number', () => {
        const release = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));

        expect(release.major).toBe(1);
        expect(release.minor).toBeGreaterThan(0);
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
        }
    });

    it('documents every reconstructed feature release through the current version', () => {
        const release = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
        const history = readFileSync(join(root, 'RELEASES.md'), 'utf8');
        const releases = [...history.matchAll(/^\| `(\d+\.\d+\.\d+)` /gm)].map(match => match[1]);

        expect(releases).toHaveLength(release.minor + 1);
        expect(releases.at(-1)).toBe(release.version);
    });

    it('passes the NextCommit switch explicitly from both deployment scripts', () => {
        for (const name of ['deploy.ps1', 'deploy-beta.ps1']) {
            const script = readFileSync(join(root, name), 'utf8');
            expect(script).toContain("'scripts\\sync-version.ps1') -NextCommit");
            expect(script).not.toContain('@versionArgs');
        }
    });
});
