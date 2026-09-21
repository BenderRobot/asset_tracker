// ========================================
// csvWorker.js - Parse le CSV en arrière-plan
// ========================================

// Copie du canonique config.js:ASSET_TYPES — ce worker classique (new
// Worker(), pas { type: 'module' }) ne peut pas faire d'import ES, d'où la
// duplication plutôt qu'une réutilisation directe.
const ASSET_TYPES = ['Stock', 'ETF', 'Crypto', 'Real Estate', 'Dividend', 'Cash'];

// BUG FOUND (confirmé) : une valeur de colonne "Asset Type" du CSV qui ne
// correspondait pas EXACTEMENT (casse comprise) à l'une des chaînes
// ci-dessus retombait silencieusement sur 'Stock' — y compris pour des
// lignes immobilier/crowdfunding avec un libellé légèrement différent
// ("SCPI", "Crowdfunding", une faute de frappe...). Traitée ensuite comme
// une action normale PARTOUT dans l'app (HistoryCalculator n'a aucune
// logique dédiée à l'immobilier, contrairement à dataManager.calculateHoldings) :
// aucun prix ne se résout jamais pour un "ticker" qui est en fait un nom de
// projet, mais son montant investi est quand même compté intégralement —
// ça faisait baisser le Total Return affiché exactement du montant investi
// de cette ligne, sans aucune erreur ni avertissement visible. Confirmé en
// prod : deux lignes ("Foncière Redland", "Bois Rochefort") retrouvées dans
// la liste des tickers du moteur de graphique, jamais tarifées (23/28 titres
// tarifés au lieu de 28/28).
//
// Fix : normaliser contre la liste canonique (insensible à la casse), avec
// une reconnaissance élargie pour les libellés immobilier/crowdfunding
// courants qui ne matchent pas exactement "Real Estate". Toute valeur
// non-vide qui reste non reconnue est quand même importée (comportement
// existant préservé — jamais de perte silencieuse de transaction), mais
// remontée dans `warnings` pour que l'app puisse prévenir l'utilisateur au
// lieu de fausser silencieusement ses calculs.
function normalizeAssetType(raw) {
    if (!raw) return { value: 'Stock', warning: null };
    const trimmed = raw.trim();
    const exact = ASSET_TYPES.find(t => t.toLowerCase() === trimmed.toLowerCase());
    if (exact) return { value: exact, warning: null };

    const lower = trimmed.toLowerCase();
    if (lower.includes('immo') || lower.includes('scpi') || lower.includes('crowdfunding') || lower.includes('foncier')) {
        return { value: 'Real Estate', warning: null };
    }

    return { value: 'Stock', warning: trimmed };
}

self.onmessage = function(e) {
  const text = e.data;
  if (!text) {
    self.postMessage({ error: 'Texte CSV vide' });
    return;
  }

  try {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) {
      throw new Error('CSV vide ou invalide (moins de 2 lignes)');
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const importedPurchases = [];
    const warnings = [];
    let importedCount = 0;

    lines.slice(1).forEach((line, idx) => {
      const values = line.split(',').map(v => v.trim());
      const purchase = {};

      headers.forEach((h, i) => {
        if (h === 'ticker') purchase.ticker = values[i];
        else if (h === 'name') purchase.name = values[i];
        else if (h === 'price') purchase.price = parseFloat(values[i]);
        else if (h === 'date') purchase.date = values[i];
        else if (h === 'quantity') purchase.quantity = parseFloat(values[i]);
        else if (h === 'currency') purchase.currency = values[i];
        else if (h.includes('asset')) purchase.assetType = values[i];
        else if (h === 'broker') purchase.broker = values[i];
      });

      // Validation de la ligne
      if (purchase.ticker && purchase.name && purchase.price && purchase.date && purchase.quantity) {
        // Assignation des valeurs par défaut (identique à votre code original)
        purchase.currency = purchase.currency || 'EUR';
        const { value: normalizedType, warning } = normalizeAssetType(purchase.assetType);
        purchase.assetType = normalizedType;
        if (warning) {
            warnings.push(`Ligne ${idx + 2} ("${purchase.ticker}") : type d'actif "${warning}" non reconnu, importé en tant que Stock`);
        }
        purchase.broker = purchase.broker || 'RV-CT';

        importedPurchases.push(purchase);
        importedCount++;
      }
    });

    // Succès : Renvoyer les transactions parsées
    self.postMessage({ purchases: importedPurchases, count: importedCount, warnings });

  } catch (error) {
    // Erreur : Renvoyer le message d'erreur
    self.postMessage({ error: error.message });
  }
};