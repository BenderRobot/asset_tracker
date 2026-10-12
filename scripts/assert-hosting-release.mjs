import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRelease } from './prepare-release.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
    const release = JSON.parse(readFileSync(join(root, 'version.json'), 'utf8'));
    const history = readFileSync(join(root, 'RELEASES.md'), 'utf8');
    checkRelease(release, history);
    const expected = `${release.version}:${release.build}`;
    if (process.env.ASSET_TRACKER_RELEASE_ID !== expected) {
        throw new Error('Publication Hosting bloquée : utiliser deploy.ps1 ou deploy-beta.ps1 pour créer une nouvelle version.');
    }
    const committed = JSON.parse(execFileSync('git', ['show', 'HEAD:version.json'], { cwd: root, encoding: 'utf8' }));
    const count = Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
    if (committed.version !== release.version || committed.build !== release.build || count !== release.build) {
        throw new Error('Publication Hosting bloquée : version.json ne correspond pas au commit préparé.');
    }
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'version.json', 'RELEASES.md'], { cwd: root });
    console.log(`Publication autorisée : v${release.version} (build ${release.build})`);
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
