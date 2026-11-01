'use strict';
// Tests unitaires : assemblage du rapport, traduction, comparatif, PDF, fournisseurs optionnels.
const assert = require('assert'); let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
process.env.ALLOW_MOCK = '1'; process.env.NODE_ENV = 'test';
const R = require('./report'), lib = require('./lib'), { translateOptions, norm } = require('./translate'), prov = require('./providers'), { Doc } = require('./pdf'), { buildReportPdf } = require('./reportpdf');
const opt = (i, p = 1000) => ({ code: 'O' + i, label: 'Option ' + i, priceCents: p, category: 'Cat' });
const options = Array.from({ length: 12 }, (_, i) => opt(i));

(async () => {
  // --- marque depuis le VIN ---
  ok(lib.brandFromVin('WP0ZZZ99ZTS392124') === 'Porsche' && lib.brandFromVin('ZFF76ZFA5J0123456') === 'Ferrari' && lib.brandFromVin('QQQ12345678901234') === null, 'WMI');
  // --- traduction ---
  ok(norm('Rückfahrkamera') === 'ruckfahrkamera' && norm('Straße') === 'strasse', 'normalisation (ü, ß)');
  const t = translateOptions([{ code: 'A', label: 'Klimaautomatik' }, { code: 'B', label: 'Truc inconnu' }, { code: 'C', label: 'Whatever', labelFr: 'Libellé du fournisseur' }, { code: 'D', label: 'Zzz' }], { brand: 'bmw', curated: new Map([['BMW|D', 'Validé à la main']]) });
  ok(t.items[0].label === 'Climatisation automatique' && t.items[0].labelStatus === 'glossary', 'glossaire');
  ok(t.items[1].labelStatus === 'original' && t.untranslated.length === 1, 'inconnu signalé, jamais inventé');
  ok(t.items[2].label === 'Libellé du fournisseur' && t.items[2].labelStatus === 'provider', 'libellé FR du fournisseur prioritaire');
  ok(t.items[3].label === 'Validé à la main' && t.items[3].labelStatus === 'curated', 'libellé validé à la main');
  // --- normalizeOptions conserve la langue ---
  ok(lib.normalizeOptions([{ code: 'X', label: 'a', lang: 'DE', labelFr: ' fr ' }])[0].lang === 'de', 'langue conservée');
  // --- comparatif ---
  ok(R.buildComparison(options, null).status === 'unavailable' && R.buildComparison(options, options.slice(0, 3)).status === 'unavailable', 'comparatif indisponible sans catalogue suffisant');
  const cat = [...options.slice(0, 6), ...Array.from({ length: 6 }, (_, i) => opt(100 + i, 3000))];
  const c = R.buildComparison(options.slice(0, 6), cat); ok(c.status === 'ok' && c.presentCount === 6 && c.missingCount === 6 && c.equippedPct === 25, 'comparatif pondéré par le prix (6000 / 24000)');
  // --- fiche technique : rien d'inventé ---
  const ts = R.buildTechSheet({ make: 'BMW' }, { powerHp: 190, powerKw: 140 }); ok(ts.fieldCount === 2 && ts.sections.length === 2, 'champs absents omis');
  ok(R.buildTechSheet({}, null).sections.length === 0, 'fiche vide si aucune donnée');
  // --- rappels / provenance : états honnêtes ---
  ok(R.buildRecalls(null).status === 'unavailable' && R.buildRecalls({ status: 'ok', items: [] }).status === 'none_found', 'rappels : indisponible ≠ aucun');
  const rc = R.buildRecalls({ status: 'ok', items: [{ ref: 'A', date: '2022-06', title: 'T1', status: 'Réalisée' }, { ref: 'B', date: '2024-03', title: 'T2', status: 'À réaliser' }] }); ok(rc.todo === 1 && rc.items[0].date === '06/2022', 'rappels à réaliser comptés');
  ok(R.buildProvenance(null).status === 'unavailable' && R.buildProvenance(null).damage.status === 'unavailable', 'provenance indisponible');
  const pv = R.buildProvenance({ status: 'ok', events: [], theft: { status: 'none_found' }, lien: { status: 'bizarre' }, damage: { status: 'found', items: [] } });
  ok(pv.lien.status === 'unavailable' && pv.damage.status === 'unavailable', 'statut inconnu ou « trouvé » sans détail => indisponible, jamais « aucun »');
  // --- assemblage selon la formule ---
  const dec = { vehicle: { make: 'BMW' }, options, source: 'jato' };
  const E = R.assembleReport({ plan: 'essentiel', vin: 'WBA8E9C50GK123456', decoded: dec, history: { status: 'ok', events: [] }, recalls: null });
  ok(E.provenance === null && E.comparison === null && E.recalls.status === 'unavailable' && E.notices.some((n) => /rappel/.test(n)), 'Essentiel : pas de provenance ni comparatif, rappels signalés indisponibles');
  const P = R.assembleReport({ plan: 'premium', vin: 'WBA8E9C50GK123456', decoded: dec, history: null, recalls: null });
  ok(P.provenance.status === 'unavailable' && P.comparison.status === 'unavailable' && P.notices.length >= 3, 'Premium sans sources : tout signalé indisponible');
  ok(P.sources.length === 1 && P.sources[0].name === 'JATO Dynamics', 'sources citées');
  assert.throws(() => R.assembleReport({ plan: 'gold', vin: 'x', decoded: dec }), /PLAN_INVALID/); pass++;
  ok(R.assembleReport({ plan: 'premium', vin: 'V', decoded: dec, valuation: { status: 'not_estimable' } }).explanation === null, 'pas de texte de cotation si non estimable');
  // --- injection de texte de fournisseur ---
  const X = R.assembleReport({ plan: 'premium', vin: 'V', decoded: dec, recalls: { status: 'ok', items: [{ title: 'x\u0000y<script>' }] } });
  ok(!X.recalls.items[0].title.includes('\u0000'), 'caractères de contrôle retirés'); // l'échappement HTML est fait à l'affichage (esc)
  // --- fournisseurs optionnels : jamais bloquants ---
  const h = await prov.getHistory('WBA8E9C50GK123456'); ok(h === null, 'sans HISTORY_ORDER => null (rubrique indisponible)');
  process.env.HISTORY_ORDER = 'carvertical,mock'; const h2 = await prov.getHistory('WBA8E9C50GK123456'); ok(h2 && h2.status === 'ok', 'adaptateur non implémenté => essai suivant');
  process.env.RECALL_ORDER = 'automotivapi'; ok((await prov.getRecalls('WBA8E9C50GK123456')) === null, 'rappels : adaptateur non écrit => null, sans exception');
  // --- décodage : passe-plat tech/catalogue ---
  process.env.PROVIDER_ORDER = 'mock'; const d = await prov.decodeVin('WBA8E9C50GK123456'); ok(d.tech && d.catalogue.length === 25 && d.options[0].lang === 'de', 'décodage : fiche et catalogue conservés');
  // --- PDF ---
  const doc = await Doc.create('t'); ok(doc.clean('1 234 €  CO₂ ✓') === '1 234 €  CO2 ?', 'caractères non encodables remplacés, jamais de plantage');
  const rep = R.assembleReport({ plan: 'premium', vin: 'WBA8E9C50GK123456', decoded: { ...dec, options: translateOptions(options).items, catalogue: cat }, recalls: null, history: null });
  const pdf = await buildReportPdf({ reference: 'RP-1', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), report: rep }, {}); ok(pdf.slice(0, 5).toString() === '%PDF-', 'PDF rapport');
  await assert.rejects(() => buildReportPdf({ report: null }, {}), /ANCIEN/); pass++;
  const big = R.assembleReport({ plan: 'premium', vin: 'WBA8E9C50GK123456', decoded: { ...dec, options: Array.from({ length: 400 }, (_, i) => ({ ...opt(i), label: 'Très long libellé '.repeat(12) })) }, recalls: null, history: null });
  ok((await buildReportPdf({ reference: 'RP-2', createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), report: big }, {})).length > 10000, '400 options aux libellés très longs : pagination sans erreur');
  console.log(`rapport : ${pass} vérifications OK`);
})().catch((e) => { console.error('ÉCHEC', pass, e); process.exit(1); });
