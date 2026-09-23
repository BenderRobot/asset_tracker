// GARDE-FOU ARCHITECTURAL (audit SSOT) — ce test ne vérifie pas un
// comportement, il vérifie une PROPRIÉTÉ STRUCTURELLE du code source : les
// fichiers de VUE listés ci-dessous ne doivent plus jamais réintroduire une
// des formules qui ont chacune, historiquement, produit un écart entre la KPI
// "Var Today" et la colonne "DAY P&L" du tableau (ou un écart de "Total
// Return"/"Total Value") :
//
//   - `totalValue - totalValue / dTwr` (ratio TWR appliqué au total du
//     portefeuille pour fabriquer Var Today — le bug initial du rapport)
//   - une variable nommée `dTwr` tout court, réapparaissant dans un de ces
//     fichiers (c'est le nom exact qu'ont porté les deux occurrences du bug)
//   - `currentPrice - previousClose` / `previousClose - currentPrice` (Day
//     P&L recalculé localement au lieu d'être lu sur le PortfolioSnapshot)
//   - `totalCurrentEUR - totalInvestedEUR` (Total Return recalculé localement)
//   - `(xTwr - 1) * 100` (la conversion ratio TWR -> pourcentage affiché comme
//     si c'était Var Today)
//
// Principe (voir prompt d'audit, section 13) : UI = selectors + formatting,
// Engine (dataManager.js) = calculations. Un scan par ligne, comparé au code
// UNIQUEMENT (les commentaires — tout ce qui suit un `//` sur la ligne — sont
// ignorés exprès : ce fichier documente abondamment CES MÊMES bugs dans ses
// commentaires, qui ne doivent jamais faire échouer ce garde-fou).
//
// Ce n'est pas un vérificateur exhaustif de tout calcul financier possible
// (un AST complet serait nécessaire pour ça) — c'est un filet de sécurité
// ciblé sur la FORME EXACTE des régressions déjà observées deux fois dans ce
// fichier. Toute nouvelle régression suivant EXACTEMENT une de ces formes est
// interceptée avant merge ; un calcul financier totalement nouveau et
// inédit ne l'est pas — la revue de code reste nécessaire pour ça.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../src');

// Ces 5 fichiers sont les VUES identifiées par l'audit comme ayant, par le
// passé, orchestré ou recalculé une métrique financière canonique au lieu de
// se contenter de lire le PortfolioSnapshot produit par dataManager.js.
const GUARDED_FILES = [
    'historicalChart.js',
    'investmentsPage.js',
    'dashboardApp.js',
    'chartKPIManager.js',
    'app.js'
];

const FORBIDDEN_PATTERNS = [
    {
        name: 'ratio TWR appliqué à totalValue pour fabriquer une KPI (le bug initial du rapport)',
        regex: /totalValue\s*-\s*totalValue\s*\/\s*\w*[Tt]wr\w*/
    },
    {
        name: 'variable nommée "dTwr" (nom exact des deux occurrences historiques du bug)',
        regex: /\bdTwr\b/
    },
    {
        name: 'Day P&L recalculé localement (currentPrice - previousClose)',
        regex: /currentPrice\s*-\s*previousClose|previousClose\s*-\s*currentPrice/
    },
    {
        name: 'Total Return recalculé localement (totalCurrentEUR - totalInvestedEUR)',
        regex: /totalCurrentEUR\s*-\s*totalInvestedEUR|totalInvestedEUR\s*-\s*totalCurrentEUR/
    },
    {
        name: 'conversion ratio TWR -> pourcentage affichée comme une KPI ((xTwr - 1) * 100)',
        regex: /\(\s*\w*[Tt]wr\w*\s*-\s*1\s*\)\s*\*\s*100/
    }
];

// Retire tout ce qui suit un `//` sur chaque ligne — heuristique volontairement
// simple (pas de parsing de chaînes/template literals), suffisante ici car
// aucun des fichiers gardés ne contient de `//` à l'intérieur d'une chaîne sur
// la même ligne qu'un des motifs interdits ci-dessus.
function stripLineComments(source) {
    return source.split('\n').map(line => {
        const idx = line.indexOf('//');
        return idx === -1 ? line : line.slice(0, idx);
    });
}

describe('Garde-fou architectural — aucun calcul financier canonique dans les vues (SSOT)', () => {
    for (const file of GUARDED_FILES) {
        it(`${file} ne contient aucune des formules interdites (hors commentaires)`, () => {
            const fullPath = path.join(SRC, file);
            const source = readFileSync(fullPath, 'utf8');
            const codeLines = stripLineComments(source);

            const violations = [];
            codeLines.forEach((line, i) => {
                for (const { name, regex } of FORBIDDEN_PATTERNS) {
                    if (regex.test(line)) {
                        violations.push(`  ligne ${i + 1}: ${name}\n    > ${line.trim()}`);
                    }
                }
            });

            expect(violations, `${file} contient un calcul financier interdit dans une vue :\n${violations.join('\n')}`).toEqual([]);
        });
    }
});
