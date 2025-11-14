// ========================================
// csvWorker.js - Parse le CSV en arrière-plan
// ========================================

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
    let importedCount = 0;

    lines.slice(1).forEach(line => {
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
        purchase.assetType = purchase.assetType || 'Stock';
        purchase.broker = purchase.broker || 'RV-CT';
        
        importedPurchases.push(purchase);
        importedCount++;
      }
    });
    
    // Succès : Renvoyer les transactions parsées
    self.postMessage({ purchases: importedPurchases, count: importedCount });

  } catch (error) {
    // Erreur : Renvoyer le message d'erreur
    self.postMessage({ error: error.message });
  }
};