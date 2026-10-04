// Rendu minimal Markdown -> HTML pour les réponses Gemini.
// Le texte du modèle est non fiable : il doit toujours être échappé avant
// d'ajouter les quelques balises de présentation autorisées.
export function escapeGeminiHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function formatSafeGeminiHtml(value) {
  return escapeGeminiHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}
