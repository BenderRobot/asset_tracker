// GARDE-FOU (bug "tooltip affiché 2 fois") : le graphique historique n'a qu'un
// seul moteur de tooltip, le tooltip HTML (`external`). Le tooltip natif de
// Chart.js doit rester désactivé en permanence — il était réactivé après un
// clic ou un zoom, et se dessinait alors par-dessus le tooltip HTML.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(__dirname, '../src/historicalChart.js'), 'utf8');
const code = source.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '')).join('\n');

describe('historical chart tooltip', () => {
    it('never re-enables the native Chart.js tooltip', () => {
        expect(code).not.toMatch(/tooltip\.enabled\s*=\s*true/);
        expect(code).toMatch(/tooltip:\s*\{\s*enabled:\s*false/);
    });
});
