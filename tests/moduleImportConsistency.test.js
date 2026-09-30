import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join, relative } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const srcRoot = join(root, 'src');

function javascriptFiles(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return javascriptFiles(path);
        return extname(entry.name) === '.js' ? [path] : [];
    });
}

describe('ES module identity and cache policy', () => {
    it('uses canonical unversioned URLs for every JavaScript resource', () => {
        const versionedResources = [];
        const htmlFiles = readdirSync(root)
            .filter(name => extname(name) === '.html')
            .map(name => join(root, name));
        const versionedJavascriptUrl = /['"`]([^'"`]+\.js\?v=\d+)['"`]/g;

        for (const file of [...javascriptFiles(srcRoot), ...htmlFiles]) {
            const source = readFileSync(file, 'utf8');
            for (const match of source.matchAll(versionedJavascriptUrl)) {
                versionedResources.push(`${relative(root, file)} -> ${match[1]}`);
            }
        }

        expect(versionedResources).toEqual([]);
    });

    it('serves JavaScript without browser caching on every Hosting target', () => {
        const firebase = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));

        for (const hosting of firebase.hosting) {
            const javascriptRule = hosting.headers?.find(rule => rule.source === '**/*.js');
            const cacheControl = javascriptRule?.headers?.find(header => header.key.toLowerCase() === 'cache-control')?.value;

            expect(cacheControl, `hosting target ${hosting.target}`).toBe('no-cache, no-store, must-revalidate');
        }
    });
});
