import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versionFile = join(root, 'version.json');
const historyFile = join(root, 'RELEASES.md');

export function parts(version) {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
    if (!match) throw new Error(`Version invalide : ${version}`);
    return match.slice(1).map(Number);
}

export function compareVersions(left, right) {
    const a = parts(left), b = parts(right);
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
    return 0;
}

export function bumpFromMessage(message) {
    const subject = String(message || '').split(/\r?\n/, 1)[0].trim();
    if (/^\w+(?:\([^)]*\))?!:/.test(subject) || /(?:^|\n)BREAKING CHANGE\s*:/im.test(message)) return 'major';
    if (/^(?:feat|feature)(?:\([^)]*\))?\s*:/i.test(subject) || /^new features?\b/i.test(subject)) return 'minor';
    return 'patch';
}

export function nextVersion(version, bump) {
    let [major, minor, patch] = parts(version);
    if (bump === 'major') { major++; minor = 0; patch = 0; }
    else if (bump === 'minor') { minor++; patch = 0; }
    else if (bump === 'patch') patch++;
    else throw new Error(`Incrément inconnu : ${bump}`);
    return `${major}.${minor}.${patch}`;
}

export function historyVersions(history) {
    return [...history.matchAll(/^\| `(\d+\.\d+\.\d+)` \|/gm)].map(match => match[1]);
}

export function appendRelease(history, version, description, date = new Date().toISOString().slice(0, 10)) {
    if (historyVersions(history).includes(version)) return history;
    const lines = history.replace(/\r\n/g, '\n').split('\n');
    let last = -1;
    for (let i = 0; i < lines.length; i++) if (/^\| `\d+\.\d+\.\d+` \|/.test(lines[i])) last = i;
    if (last < 0) throw new Error('Tableau des versions introuvable dans RELEASES.md');
    const clean = String(description).replace(/[|`\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
    lines.splice(last + 1, 0, `| \`${version}\` | ${date} | ${clean} | — |`);
    return lines.join('\n');
}

function git(...args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
function optionalVersion(...args) {
    try { return JSON.parse(git(...args)); } catch { return null; }
}
function validManifest(release) {
    if (!release || release.version !== `${release.major}.${release.minor}.${release.patch}`
        || !Number.isInteger(release.build) || release.build < 1) throw new Error('version.json incohérent');
    parts(release.version);
}

export function checkRelease(release, history) {
    validManifest(release);
    const versions = historyVersions(history);
    if (!versions.length || versions.at(-1) !== release.version) throw new Error('RELEASES.md ne se termine pas par la version publiée');
    if (new Set(versions).size !== versions.length) throw new Error('RELEASES.md contient des versions en double');
    for (let i = 1; i < versions.length; i++) {
        if (compareVersions(versions[i], versions[i - 1]) <= 0) throw new Error('RELEASES.md n’est pas dans l’ordre croissant');
    }
    return true;
}

function argument(name) {
    const index = process.argv.indexOf(name);
    return index < 0 ? null : process.argv[index + 1];
}

export function prepareRelease({ message, bump = bumpFromMessage(message), published = null } = {}) {
    const head = optionalVersion('show', 'HEAD:version.json');
    const staged = optionalVersion('show', ':version.json');
    const working = JSON.parse(readFileSync(versionFile, 'utf8'));
    const headCount = Number(git('rev-list', '--count', 'HEAD'));
    const nextBuild = headCount + 1;
    let history = readFileSync(historyFile, 'utf8');
    for (const release of [head, staged, working, published].filter(Boolean)) validManifest(release);
    if (head && headCount < head.build) throw new Error('Historique Git incomplet : récupérer tous les commits avant de préparer une version.');
    if (published && published.build > headCount) throw new Error('La version en ligne est en avance sur ce clone : synchroniser Git avant de déployer.');

    const existing = historyVersions(history);
    if (published && !existing.includes(published.version)) {
        if (existing.length && compareVersions(published.version, existing.at(-1)) <= 0) {
            throw new Error('Une version en ligne manque dans un historique plus récent : corriger RELEASES.md avant le déploiement.');
        }
        history = appendRelease(history, published.version, `Version déjà publiée en ligne (build ${published.build})`);
    }

    // The deployment script prepares files before tests; the commit hook calls
    // this again. A matching next-build manifest and release row are reusable.
    const pending = working.build === nextBuild && existing.includes(working.version)
        && head && compareVersions(working.version, head.version) > 0;
    const pendingRow = history.split('\n').find(line => line.startsWith(`| \`${working.version}\` |`));
    const prepared = pending && bumpFromMessage(pendingRow?.split('|')[3]?.trim()) === bump
        && (!published || (compareVersions(working.version, published.version) > 0 && working.build > published.build));
    if (pending && !prepared) {
        history = history.split('\n').filter(line => !line.startsWith(`| \`${working.version}\` |`)).join('\n');
    }
    const baseline = [head, staged, ...(pending && !prepared ? [] : [working]), published].filter(Boolean)
        .map(release => release.version).sort(compareVersions).at(-1);
    const version = prepared ? working.version : nextVersion(baseline, bump);
    const [major, minor, patch] = parts(version);
    const release = { version, major, minor, patch, build: nextBuild, source: 'feature-semver' };
    if (!historyVersions(history).includes(version)) history = appendRelease(history, version, message || 'Déploiement');
    checkRelease(release, history);
    writeFileSync(versionFile, JSON.stringify(release, null, 2) + '\n', 'utf8');
    writeFileSync(historyFile, history, 'utf8');
    return release;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv.includes('--check')) {
            const release = JSON.parse(readFileSync(versionFile, 'utf8'));
            checkRelease(release, readFileSync(historyFile, 'utf8'));
            if (process.argv.includes('--committed') && release.build !== Number(git('rev-list', '--count', 'HEAD'))) {
                throw new Error('Le build publié ne correspond pas au commit Git.');
            }
            console.log(`Version cohérente : v${release.version} (build ${release.build})`);
        } else {
            const message = argument('--message') || (argument('--message-file') && readFileSync(argument('--message-file'), 'utf8'));
            if (!message) throw new Error('Un message de commit est requis pour préparer une version.');
            const publishedVersion = argument('--published-version');
            const publishedBuild = argument('--published-build');
            const published = publishedVersion ? { version: publishedVersion,
                major: parts(publishedVersion)[0], minor: parts(publishedVersion)[1], patch: parts(publishedVersion)[2],
                build: Number(publishedBuild) } : null;
            const release = prepareRelease({ message, published });
            console.log(`Version préparée : v${release.version} (build ${release.build})`);
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
