// @vitest-environment jsdom
//
// BUG FOUND (audit XSS, P1) : AssistantApp.formatMessage() injectait le texte
// (message utilisateur OU réponse Gemini — avec recherche web activée, donc
// capable de citer du contenu externe) dans innerHTML après de simples
// transformations markdown, SANS jamais l'échapper au préalable. Un contenu
// contenant du HTML/JS littéral s'exécutait tel quel dans le DOM du chat.
import { describe, it, expect } from 'vitest';
import { AssistantApp } from '../src/assistantApp.js';

// formatMessage()/escapeHtml() ne dépendent d'aucun autre état d'instance —
// appelées directement sur le prototype, sans construire un AssistantApp
// complet (son constructeur fait de l'init Firebase/DOM hors de propos ici).
function formatMessage(text) {
    return AssistantApp.prototype.formatMessage.call(AssistantApp.prototype, text);
}

describe('AssistantApp.formatMessage — échappement XSS (P1)', () => {
    it('un <script> littéral dans le texte ne devient jamais un vrai élément script', () => {
        const html = formatMessage('<script>alert(1)</script>');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    it('un tag avec gestionnaire d\'événement (payload IMG onerror) est neutralisé', () => {
        const html = formatMessage('<img src=x onerror=alert(1)>');
        expect(html).not.toMatch(/<img/i);
        expect(html).toContain('&lt;img');
    });

    it('le rendu markdown légitime (gras/italique/code/saut de ligne) continue de fonctionner', () => {
        const html = formatMessage('**gras** et *italique* et `code`\nligne suivante');
        expect(html).toContain('<strong>gras</strong>');
        expect(html).toContain('<em>italique</em>');
        expect(html).toContain('<code>code</code>');
        expect(html).toContain('<br>');
    });

    it('un texte contenant à la fois du HTML dangereux et du markdown : le markdown reste rendu, le HTML reste neutralisé', () => {
        const html = formatMessage('**Alerte** <script>alert(1)</script> important');
        expect(html).toContain('<strong>Alerte</strong>');
        expect(html).not.toContain('<script>');
    });
});
