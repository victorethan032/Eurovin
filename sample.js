'use strict';
// Rapport d'exemple PUBLIC : véhicule entièrement fictif, produit par le vrai code de rapport (report.js + translate.js).
// Aucune donnée réelle, aucun fournisseur appelé, aucun coût. Le texte l'indique clairement à l'écran.
const R = require('./report'), { translateOptions } = require('./translate');

const OPTS = [['C01', 'Klimaautomatik', 'Confort', 45000], ['C02', 'Head-Up Display HUD', 'Confort', 89000], ['C03', 'Komfortzugang', 'Confort', 52000], ['C04', 'Navigationssystem', 'Multimédia', 190000],
  ['C05', 'LED Scheinwerfer', 'Extérieur', 120000], ['C06', 'Metallic Lackierung', 'Extérieur', 99000], ['C07', 'Rückfahrkamera', 'Sécurité', 35000], ['C08', 'Parkassistent', 'Sécurité', 78000],
  ['C09', 'Anhängerkupplung', 'Extérieur', 85000], ['C10', 'Leichtmetallräder', 'Extérieur', 150000], ['C11', 'Sportlenkrad', 'Intérieur', 30000], ['C12', 'Winterpaket', 'Confort', 65000], ['C13', 'Sonderausstattung XYZ-Spezial', 'Autres', null]];
const EXTRA = ['Panoramadach', 'Harman Kardon Soundsystem', 'Luftfederung', 'Nachtsicht', 'Elektrische Heckklappe', 'Sportauspuff'].map((l, i) => ['K' + (i + 1), l, 'Options', 40000 + i * 5000]);
const row = ([code, label, category, priceCents]) => ({ code, label, category, priceCents, lang: 'de' });

let cache = null;
function sampleReport() {
  if (cache) return cache;
  const tr = translateOptions(OPTS.map(row), {}), cat = translateOptions([...OPTS.slice(0, 12), ...EXTRA].map(row), {});
  const report = R.assembleReport({
    plan: 'premium', vin: 'EXEMPLE0000000000', generatedAt: '2026-01-15T10:00:00.000Z',
    decoded: {
      source: 'mock', options: tr.items, catalogue: cat.items,
      vehicle: { make: 'Marque d’exemple', model: 'Modèle fictif Touring', year: 2021, engine: 'Diesel 190 ch', trim: 'Finition Sport', color: 'Gris métallisé', upholstery: 'Cuir noir' },
      tech: { powerHp: 190, powerKw: 140, displacementCc: 1995, fuel: 'Diesel', gearbox: 'Automatique', gears: 8, drive: 'Propulsion', country: 'Allemagne', builtAt: '2021-02' },
    },
    translation: tr,
    recalls: { status: 'ok', source: 'mock', asOf: '2026-01-15', items: [{ ref: 'EX-01', date: '2022-06', title: 'Campagne fictive (exemple)', status: 'Réalisée' }] },
    history: { status: 'ok', source: 'mock', asOf: '2026-01-15', events: [{ date: '2021-03', title: 'Première mise en circulation', place: 'Allemagne' }, { date: '2022-09', title: 'Importation et immatriculation', place: 'France' }], theft: { status: 'none_found' }, lien: { status: 'none_found' }, damage: { status: 'none_found' } },
  });
  report.sources = [{ name: 'Données fictives', role: 'Exemple de démonstration, sans lien avec un véhicule réel', asOf: null }];
  report.notices = ['Ce rapport est un exemple : le véhicule, les options, les prix et l’historique sont inventés.'];
  cache = { reference: 'EXEMPLE', createdAt: report.generatedAt, expiresAt: null, generationMs: null, sample: true, report };
  return cache;
}
module.exports = { sampleReport };
