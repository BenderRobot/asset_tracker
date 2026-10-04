import { describe, expect, it } from 'vitest';
import { escapeGeminiHtml, formatSafeGeminiHtml } from '../src/safeGeminiHtml.js';

describe('safeGeminiHtml', () => {
  it('neutralise le HTML et les gestionnaires d’événements fournis par le modèle', () => {
    const html = formatSafeGeminiHtml('<img src=x onerror="alert(1)"><script>alert(2)</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('applique uniquement le Markdown minimal après échappement', () => {
    expect(formatSafeGeminiHtml('**gras**\n`code`')).toBe('<strong>gras</strong><br><code>code</code>');
  });

  it('échappe les cinq caractères HTML sensibles', () => {
    expect(escapeGeminiHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#039;');
  });
});
