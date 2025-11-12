// ========================================
// utils.js - Fonctions utilitaires multi-devises
// ========================================

export function formatCurrency(value, currency = 'EUR') {
  if (value === null || value === undefined || isNaN(value)) {
    return '<span class="unavailable">-</span>';
  }
  
  const absValue = Math.abs(parseFloat(value)).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const sign = value < 0 ? '-' : '';
  
  // EUR : format franÃ§ais (montant + symbole)
  if (currency === 'EUR') {
    return `<strong>${sign}${absValue} €</strong>`;
  }
  
  // USD : format amÃ©ricain (symbole + montant)
  if (currency === 'USD') {
    return `<strong>${sign}$${absValue}</strong>`;
  }
  
  // Autres devises : par dÃ©faut comme EUR
  return `<strong>${sign}${absValue} ${currency}</strong>`;
}

export function formatPercent(value) {
  if (value === null || isNaN(value)) return '-';
  const sign = value < 0 ? '-' : '';
  return `<strong>${sign}${Math.abs(parseFloat(value)).toFixed(2)} %</strong>`;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Formatage simple sans HTML (pour les cards)
export function formatCurrencySimple(value, currency = 'EUR') {
  if (value === null || value === undefined || isNaN(value)) return '-';
  
  const absValue = Math.abs(parseFloat(value)).toLocaleString('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const sign = value < 0 ? '-' : '';
  
  if (currency === 'EUR') {
    return `${sign}${absValue} €`;
  }
  
  if (currency === 'USD') {
    return `${sign}$${absValue}`;
  }
  
  return `${sign}${absValue} ${currency}`;
}

// Badge de devise avec couleur
export function getCurrencyBadge(currency) {
  if (currency === 'USD') {
    return '<span class="currency-badge currency-usd">USD</span>';
  }
  return '<span class="currency-badge currency-eur">EUR</span>';
}

// Formatage quantitÃ©
function formatQty(qty) {
  return qty >= 1000 ? qty.toFixed(0) : qty.toFixed(2);
}

// Formatage prix
function formatPrice(price) {
  return price >= 1000 ? price.toFixed(0) + '€' : price.toFixed(2) + '€';
}

// Formatage gain
function formatGain(gain) {
  const abs = Math.abs(gain);
  return gain >= 0 
    ? `+${formatPrice(abs)}` 
    : `-${formatPrice(abs)}`;
}
// Formatage date en JJ/MM/AA
export function formatDate(dateString) {
  if (!dateString) return '-';
  
  // dateString est au format YYYY-MM-DD
  const parts = dateString.split('-');
  if (parts.length !== 3) return dateString;
  
  const year = parts[0].slice(-2); // Prendre les 2 derniers chiffres
  const month = parts[1];
  const day = parts[2];
  
  return `${day}/${month}/${year}`;
}

// Formatage quantité intelligent (supprime les zéros inutiles)
export function formatQuantity(qty) {
  if (qty === null || qty === undefined || isNaN(qty)) return '-';
  
  const num = parseFloat(qty);
  
  // Si c'est un nombre entier ou très proche d'un entier
  if (Math.abs(num - Math.round(num)) < 0.0001) {
    return Math.round(num).toString();
  }
  
  // Sinon, formatter avec le nombre de décimales nécessaires
  // Supprimer les zéros à la fin
  return num.toFixed(6).replace(/\.?0+$/, '');
}
