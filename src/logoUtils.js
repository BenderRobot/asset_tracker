// logoUtils.js - Company Logo Fetcher with Smart Display Logic

/**
 * Get company logo info
 * @param {string} ticker - Stock ticker symbol
 * @param {string} name - Company name
 * @returns {Object} { hasLogo: boolean, url: string|null, badgeColor: string }
 */
export function getCompanyLogo(ticker, name) {
    const domain = getDomainFromName(name);
    const hasLogo = domain !== null;

    return {
        hasLogo,
        url: hasLogo ? `https://www.google.com/s2/favicons?domain=${domain}&sz=128` : null,
        badgeColor: generateColor(ticker)
    };
}

/**
 * Extract likely domain from company name
 */
function getDomainFromName(name) {
    let cleanName = name
        .toLowerCase()
        // Remove common ETF index names first
        .replace(/\s+(s&p\s*500|s&p500|nasdaq\s*100|nasdaq100|msci\s+world|msci\s+usa|msci\s+europe|stoxx\s*50|stoxx\s*600|ftse\s*100|cac\s*40|dax|russell\s*2000)/gi, '')
        // Remove ETF-specific keywords
        .replace(/\s+(etf|ucits|acc|dist|index|tracker|fund)/gi, '')
        // Remove legal suffixes
        .replace(/\s+(inc\.?|corp\.?|corporation|ltd\.?|limited|sa|s\.a\.|plc|ag|nv|se)$/i, '')
        .trim();

    // Manual mapping for well-known companies
    const nameToDomain = {
        'apple': 'apple.com',
        'microsoft': 'microsoft.com',
        'alphabet': 'google.com',
        'google': 'google.com',
        'amazon': 'amazon.com',
        'tesla': 'tesla.com',
        'meta platforms': 'meta.com',
        'meta': 'meta.com',
        'nvidia': 'nvidia.com',
        'amd': 'amd.com',
        'netflix': 'netflix.com',
        'disney': 'disney.com',
        'walt disney': 'disney.com',
        'paypal': 'paypal.com',
        'adobe': 'adobe.com',
        'intel': 'intel.com',
        'cisco': 'cisco.com',
        'comcast': 'comcast.com',
        'pepsico': 'pepsico.com',
        'coca-cola': 'coca-cola.com',
        'nike': 'nike.com',
        'mcdonalds': 'mcdonalds.com',
        "mcdonald's": 'mcdonalds.com',
        'visa': 'visa.com',
        'mastercard': 'mastercard.com',
        'johnson & johnson': 'jnj.com',
        'unitedhealth': 'unitedhealthgroup.com',
        'home depot': 'homedepot.com',
        'bank of america': 'bankofamerica.com',
        'walmart': 'walmart.com',
        'chevron': 'chevron.com',
        'exxon mobil': 'exxonmobil.com',
        'exxonmobil': 'exxonmobil.com',
        'jpmorgan chase': 'jpmorganchase.com',
        'eli lilly': 'lilly.com',
        'lilly': 'lilly.com',
        'abbvie': 'abbvie.com',
        'pfizer': 'pfizer.com',
        'thermo fisher scientific': 'thermofisher.com',
        'thermo fisher': 'thermofisher.com',
        'costco': 'costco.com',
        'broadcom': 'broadcom.com',
        'accenture': 'accenture.com',
        'texas instruments': 'ti.com',
        'oracle': 'oracle.com',
        'salesforce': 'salesforce.com',
        'qualcomm': 'qualcomm.com',
        'danaher': 'danaher.com',
        'nextera energy': 'nexteraenergy.com',
        'ups': 'ups.com',
        'united parcel service': 'ups.com',
        'starbucks': 'starbucks.com',
        'at&t': 'att.com',
        'verizon': 'verizon.com',
        'ibm': 'ibm.com',
        'general electric': 'ge.com',
        'boeing': 'boeing.com',
        '3m': '3m.com',
        'caterpillar': 'caterpillar.com',
        'goldman sachs': 'goldmansachs.com',
        'morgan stanley': 'morganstanley.com',
        'american express': 'americanexpress.com',
        'blackrock': 'blackrock.com',
        'citigroup': 'citigroup.com',
        's&p global': 'spglobal.com',
        // European companies
        'lvmh': 'lvmh.com',
        'loreal': 'loreal.com',
        "l'oreal": 'loreal.com',
        'sanofi': 'sanofi.com',
        'airbus': 'airbus.com',
        'totalenergies': 'totalenergies.com',
        'total energies': 'totalenergies.com',
        'bnp paribas': 'bnpparibas.com',
        'bnp paribas easy': 'bnpparibas.com',
        'bnp': 'bnpparibas.com',
        'sap': 'sap.com',
        'siemens': 'siemens.com',
        'volkswagen': 'volkswagen.com',
        'asml': 'asml.com',
        'nestle': 'nestle.com',
        'nestlé': 'nestle.com',
        'roche': 'roche.com',
        'novartis': 'novartis.com',
        'schneider electric': 'se.com',
        'schneider': 'se.com',
        'hermes': 'hermes.com',
        'hermès': 'hermes.com',
        'kering': 'kering.com',
        'danone': 'danone.com',
        'alstom': 'alstom.com',
        'thales': 'thalesgroup.com',
        'orange': 'orange.com',
        'veolia': 'veolia.com',
        'blacksky': 'blacksky.com',
        'take-two': 'take2games.com',
        'take-two interactive': 'take2games.com',
        'arista': 'arista.com',
        'arista networks': 'arista.com',
        'nanoco': 'nanocotechnologies.com',
        'aduro biotech': 'aduro.com',
        'aduro': 'aduro.com',
        'aduro clean technologies': 'adurocleantech.com',
        'applied materials': 'appliedmaterials.com',
        'applied': 'appliedmaterials.com',
        '2crsi': '2crsi.com',
        'amundi': 'amundi.com',
        'ast spacemobile': 'ast-science.com',
        'ast': 'ast-science.com',
        // ETF providers
        'ishares': 'ishares.com',
        'vanguard': 'vanguard.com',
        'amundi msci': 'amundi.com',
        'spdr': 'ssga.com'
    };

    // Check manual mapping
    if (nameToDomain[cleanName]) {
        return nameToDomain[cleanName];
    }

    // For single-word company names, try appending .com
    if (!cleanName.includes(' ') && cleanName.length > 2) {
        return `${cleanName}.com`;
    }

    // For multi-word names, try using first word + .com
    const firstWord = cleanName.split(' ')[0];
    if (firstWord.length > 3) {
        return `${firstWord}.com`;
    }

    return null;
}

/**
 * Generate consistent color from ticker
 */
function generateColor(ticker) {
    let hash = 0;
    for (let i = 0; i < ticker.length; i++) {
        hash = ticker.charCodeAt(i) + ((hash << 5) - hash);
    }

    const hue = Math.abs(hash % 360);
    return `hsl(${hue}, 65%, 50%)`;
}

/**
 * Render logo or ticker badge
 * @param {string} ticker 
 * @param {string} name 
 * @returns {Object} { html: string, hasLogo: boolean }
 */
export function renderCompanyLogo(ticker, name) {
    const logo = getCompanyLogo(ticker, name);

    if (logo.hasLogo) {
        // Return logo HTML
        return {
            html: `
                <div class="company-logo-wrapper" style="width: 32px; height: 32px; border-radius: 6px; overflow: hidden; background: #f5f5f5; display: flex; align-items: center; justify-content: center; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    <img 
                        src="${logo.url}" 
                        alt="${name}"
                        class="company-logo"
                        style="width: 24px; height: 24px; object-fit: contain;"
                        onerror="this.parentElement.innerHTML='<div style=\\'width:32px;height:32px;border-radius:6px;background:${logo.badgeColor};color:white;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;\\'>${ticker}</div>'"
                    />
                </div>
            `,
            hasLogo: true
        };
    } else {
        // Return ticker badge
        return {
            html: `
                <div class="ticker-badge" style="width: 32px; height: 32px; border-radius: 6px; background: ${logo.badgeColor}; color: white; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                    ${ticker}
                </div>
            `,
            hasLogo: false
        };
    }
}
