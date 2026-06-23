async function test() {
  const url = 'https://asset-tracker-gemini.blaurens31.workers.dev';
  
  const title = "IPO de SpaceX - L'entreprise d'Elon Musk détient 1,3 milliard de dollars en Bitcoin";
  const summary = "En tant qu'analyste financier, je note que SpaceX, l'entreprise d'Elon Musk, détient un portefeuille significatif de 1,3 milliard de dollars en Bitcoin. Cette position en crypto-monnaie est révélée alors que l'entreprise envisage une introduction en bourse (IPO). Elle pourrait influencer la perception de sa valorisation et la réaction du marché face à l'exposition d'une entreprise majeure aux actifs numériques.";
  const portfolioContext = ""; // For SpaceX we might not hold it
  
  function cleanText(text) {
      if (typeof text !== 'string') return '';
      return text.replace(/'/g, "\\'").replace(/"/g, '\\"');
  }

  const prompt = `Agis comme un analyste financier chevronné. En te basant sur ce résumé et les détails de ton portefeuille GLOBALE (tous comptes confondus), explique en 1 à 3 phrases l'impact potentiel (opportunité ou risque) de cette nouvelle. Concentre-toi sur la position totale (montant détenu, gain/perte) : ${portfolioContext}\nTitre: "${cleanText(title)}"\nRésumé: "${cleanText(summary)}"`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': 'http://localhost:3000' },
      body: JSON.stringify({ prompt: prompt })
    });
    console.log('Status:', response.status);
    const data = await response.text();
    console.log('Body:', data);
  } catch (err) {
    console.error('Error:', err);
  }
}
test();
