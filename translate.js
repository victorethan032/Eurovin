'use strict';
/**
 * Traduction des libellés d'options en français, SANS rien inventer :
 *  1. libellé déjà en français fourni par le fournisseur (lang: 'fr' ou labelFr)
 *  2. traduction validée par vous (table option_labels, par marque + code, ou code seul)
 *  3. correspondance exacte avec le glossaire ci-dessous
 *  4. sinon le libellé d'origine est conservé et signalé (« libellé d'origine »), puis proposé à la traduction dans le back-office.
 * Aucune traduction automatique approximative n'est affichée comme si elle était officielle.
 */
const norm = (s) => String(s == null ? '' : s).replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const RAW = {
  // anglais
  'panoramic sunroof': 'Toit ouvrant panoramique', 'panoramic roof': 'Toit panoramique', 'sunroof': 'Toit ouvrant', 'glass sunroof': 'Toit ouvrant en verre',
  'heated seats': 'Sièges chauffants', 'heated front seats': 'Sièges avant chauffants', 'heated rear seats': 'Sièges arrière chauffants', 'heated steering wheel': 'Volant chauffant',
  'ventilated seats': 'Sièges ventilés', 'sport seats': 'Sièges sport', 'comfort seats': 'Sièges confort', 'leather upholstery': 'Sellerie cuir', 'leather seats': 'Sièges cuir',
  'electric seats': 'Sièges électriques', 'memory seats': 'Sièges à mémoire', 'massage seats': 'Sièges massants',
  'navigation system': 'Système de navigation', 'navigation': 'Navigation', 'navigation professional': 'Navigation Professional', 'head up display': 'Affichage tête haute',
  'adaptive cruise control': 'Régulateur de vitesse adaptatif', 'cruise control': 'Régulateur de vitesse', 'lane departure warning': 'Alerte de franchissement de ligne',
  'lane keeping assist': 'Maintien dans la voie', 'blind spot detection': 'Détection d’angle mort', 'blind spot monitor': 'Surveillance d’angle mort',
  'park distance control': 'Aide au stationnement', 'parking sensors': 'Capteurs de stationnement', 'parking assistant': 'Assistant de stationnement', 'parking assist': 'Assistant de stationnement',
  'rear view camera': 'Caméra de recul', 'reversing camera': 'Caméra de recul', '360 degree camera': 'Caméra à 360°', 'surround view camera': 'Caméra à 360°',
  'keyless entry': 'Accès sans clé', 'keyless go': 'Démarrage sans clé', 'comfort access': 'Accès confort',
  'led headlights': 'Phares à LED', 'led headlamps': 'Phares à LED', 'matrix led headlights': 'Phares matriciels à LED', 'xenon headlights': 'Phares au xénon', 'laser headlights': 'Phares laser',
  'metallic paint': 'Peinture métallisée', 'pearlescent paint': 'Peinture nacrée', 'alarm system': 'Alarme antivol', 'anti theft alarm': 'Alarme antivol',
  'tow bar': 'Attelage', 'trailer hitch': 'Attelage', 'towbar': 'Attelage', 'swiveling tow bar': 'Attelage rotatif', 'electric tailgate': 'Hayon électrique', 'power tailgate': 'Hayon électrique',
  'air suspension': 'Suspension pneumatique', 'adaptive suspension': 'Suspension adaptative', 'sport suspension': 'Suspension sport', 'sport exhaust': 'Échappement sport', 'sports exhaust': 'Échappement sport',
  'wireless charging': 'Recharge sans fil du smartphone', 'apple carplay': 'Apple CarPlay', 'android auto': 'Android Auto', 'digital cockpit': 'Cockpit numérique',
  'four zone automatic air conditioning': 'Climatisation automatique 4 zones', '4 zone automatic air conditioning': 'Climatisation automatique 4 zones', 'automatic air conditioning': 'Climatisation automatique',
  'dual zone air conditioning': 'Climatisation bizone', 'air conditioning': 'Climatisation', 'harman kardon surround sound system': 'Système audio Harman Kardon Surround',
  'bowers wilkins sound system': 'Système audio Bowers & Wilkins', 'bang olufsen sound system': 'Système audio Bang & Olufsen', 'hi fi sound system': 'Système audio hi-fi',
  'storage package': 'Pack Rangement', 'comfort package': 'Pack Confort', 'winter package': 'Pack Hiver', 'sport package': 'Pack Sport', 'driver assistance package': 'Pack aides à la conduite',
  'driving assistant professional': 'Assistant de conduite Professional', 'privacy glass': 'Vitres arrière surteintées', 'tinted windows': 'Vitres surteintées', 'run flat tyres': 'Pneus à roulage à plat',
  'alloy wheels': 'Jantes alliage', 'sport steering wheel': 'Volant sport', 'multifunction steering wheel': 'Volant multifonction', 'sport brakes': 'Freins sport', 'ceramic brakes': 'Freins céramique',
  'night vision': 'Vision nocturne', 'traffic sign recognition': 'Reconnaissance des panneaux', 'emergency brake assist': 'Freinage d’urgence automatique', 'roof rails': 'Barres de toit',
  // allemand
  'panoramadach': 'Toit panoramique', 'schiebedach': 'Toit ouvrant', 'glasschiebedach': 'Toit ouvrant en verre', 'sitzheizung': 'Sièges chauffants', 'sitzheizung vorn': 'Sièges avant chauffants',
  'sitzheizung hinten': 'Sièges arrière chauffants', 'lenkradheizung': 'Volant chauffant', 'sportsitze': 'Sièges sport', 'ledersitze': 'Sièges cuir', 'lederausstattung': 'Sellerie cuir',
  'navigationssystem': 'Système de navigation', 'head up display hud': 'Affichage tête haute', 'abstandsregeltempomat': 'Régulateur de vitesse adaptatif', 'tempomat': 'Régulateur de vitesse',
  'spurverlassenswarnung': 'Alerte de franchissement de ligne', 'totwinkelassistent': 'Détection d’angle mort', 'parkassistent': 'Assistant de stationnement', 'einparkhilfe': 'Aide au stationnement',
  'rückfahrkamera': 'Caméra de recul', 'ruckfahrkamera': 'Caméra de recul', 'komfortzugang': 'Accès confort', 'led scheinwerfer': 'Phares à LED', 'metallic lackierung': 'Peinture métallisée',
  'metallic lack': 'Peinture métallisée', 'diebstahlwarnanlage': 'Alarme antivol', 'anhangerkupplung': 'Attelage', 'anhangerkupplung schwenkbar': 'Attelage rotatif',
  'elektrische heckklappe': 'Hayon électrique', 'luftfederung': 'Suspension pneumatique', 'sportauspuff': 'Échappement sport', 'klimaautomatik': 'Climatisation automatique',
  'klimaautomatik 4 zonen': 'Climatisation automatique 4 zones', 'sportlenkrad': 'Volant sport', 'leichtmetallrader': 'Jantes alliage', 'sonnenschutzverglasung': 'Vitres arrière surteintées',
  'ablagenpaket': 'Pack Rangement', 'komfortpaket': 'Pack Confort', 'winterpaket': 'Pack Hiver', 'sportpaket': 'Pack Sport', 'nachtsicht': 'Vision nocturne', 'dachreling': 'Barres de toit',
};
const GLOSSARY = new Map(Object.entries(RAW).map(([k, v]) => [norm(k), v]));

/**
 * options : [{code,label,priceCents?,category?,lang?,labelFr?}] ; curated : Map('MARQUE|CODE' ou '*|CODE' → libellé FR)
 * Renvoie { items, untranslated:[{brand,code,label}], stats }.
 */
function translateOptions(options, { brand = '', curated = new Map() } = {}) {
  const b = String(brand || '').toUpperCase();
  const stats = { provider: 0, curated: 0, glossary: 0, original: 0 };
  const untranslated = [];
  const items = (Array.isArray(options) ? options : []).map((o) => {
    const src = String(o.label || o.code);
    let fr = null, status = 'original';
    if (typeof o.labelFr === 'string' && o.labelFr.trim()) { fr = o.labelFr.trim(); status = 'provider'; }
    else if (o.lang === 'fr') { fr = src; status = 'provider'; }
    if (!fr) { const c = curated.get(`${b}|${o.code}`) || curated.get(`*|${o.code}`); if (c) { fr = c; status = 'curated'; } }
    if (!fr) { const g = GLOSSARY.get(norm(src)); if (g) { fr = g; status = 'glossary'; } }
    stats[status]++;
    if (status === 'original') untranslated.push({ brand: b, code: String(o.code), label: src });
    return { ...o, label: fr || src, labelSrc: src, labelStatus: status };
  });
  return { items, untranslated, stats };
}

module.exports = { translateOptions, norm, GLOSSARY_SIZE: GLOSSARY.size };
