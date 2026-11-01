'use strict';
/**
 * Assemblage PUR du rapport (aucun réseau, aucune base) : testable seul.
 * Règles d'honnêteté :
 *  - jamais de valeur inventée : une rubrique sans source est « indisponible », pas « vide » ;
 *  - jamais « aucun sinistre » : « aucun sinistre trouvé dans les sources consultées » + source + date ;
 *  - le comparatif n'existe que si on dispose d'un catalogue des options de la finition.
 */
const REPORT_VERSION = 2;
const PLAN_FEATURES = Object.freeze({
  essentiel: Object.freeze({ options: true, techSheet: true, recalls: true, provenance: false, comparison: false, valuation: false }),
  premium:   Object.freeze({ options: true, techSheet: true, recalls: true, provenance: true,  comparison: true,  valuation: true  }),
});

const str = (v, max = 200) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max));
const isDate = (s) => typeof s === 'string' && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s);
const fmtDate = (s) => {                                   // 2021-03 -> 03/2021 ; 2021-03-15 -> 15/03/2021
  if (!isDate(s)) return str(s, 20);
  const [y, m, d] = s.split('-');
  return d ? `${d}/${m}/${y}` : m ? `${m}/${y}` : y;
};

/** Fiche technique : n'affiche que les champs réellement fournis. */
const TECH_SECTIONS = [
  ['id',  'Identification', [['make', 'Marque'], ['model', 'Modèle'], ['trim', 'Finition'], ['generation', 'Génération'], ['bodyType', 'Carrosserie'], ['year', 'Année-modèle'], ['color', 'Couleur'], ['upholstery', 'Sellerie']]],
  ['mot', 'Motorisation',   [['engine', 'Motorisation'], ['displacementCc', 'Cylindrée', (v) => `${Number(v).toLocaleString('fr-FR')} cm³`], ['powerHp', 'Puissance', (v, t) => `${v} ch${t.powerKw ? ` · ${t.powerKw} kW` : ''}`], ['fuel', 'Carburant'], ['co2', 'CO₂ (WLTP)', (v) => `${v} g/km`]]],
  ['trs', 'Transmission',   [['gearbox', 'Boîte de vitesses'], ['gears', 'Nombre de rapports'], ['drive', 'Transmission']]],
  ['fab', 'Fabrication',    [['country', 'Pays de fabrication'], ['plant', 'Usine d’assemblage'], ['builtAt', 'Fabrication', fmtDate]]],
  ['dim', 'Dimensions',     [['lengthMm', 'Longueur', (v) => `${v} mm`], ['widthMm', 'Largeur', (v) => `${v} mm`], ['weightKg', 'Poids à vide', (v) => `${v} kg`], ['seats', 'Places'], ['doors', 'Portes']]],
];
function buildTechSheet(vehicle, tech) {
  const src = { ...(vehicle && typeof vehicle === 'object' ? vehicle : {}), ...(tech && typeof tech === 'object' ? tech : {}) };
  const sections = [];
  for (const [id, title, fields] of TECH_SECTIONS) {
    const rows = [];
    for (const [key, label, fmt] of fields) {
      const v = src[key];
      if (v == null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
      rows.push({ k: label, v: str(fmt ? fmt(v, src) : v) });
    }
    if (rows.length) sections.push({ id, title, rows });
  }
  return { sections, fieldCount: sections.reduce((a, s) => a + s.rows.length, 0) };
}

function buildRecalls(r) {
  if (!r || r.status === 'unavailable' || !Array.isArray(r.items)) return { status: 'unavailable', items: [], source: null, asOf: null };
  const items = r.items.map((x) => ({ ref: str(x.ref, 40), date: fmtDate(x.date), title: str(x.title, 300), done: x.done === true || /^(r[ée]alis[ée]e?s?|effectu[ée]e?s?|done|completed|remedied)$/i.test(str(x.status))   /* « À réaliser » ne doit JAMAIS compter comme réalisée */ })).filter((x) => x.title);
  return { status: items.length ? 'found' : 'none_found', items, todo: items.filter((x) => !x.done).length, source: str(r.source, 80) || null, asOf: str(r.asOf, 10) || null };
}

const DAMAGE_KINDS = new Set(['accident', 'flood', 'fire', 'hail', 'theft_damage', 'other']);
function buildProvenance(h) {
  if (!h || h.status === 'unavailable') return { status: 'unavailable', events: [], theft: { status: 'unavailable' }, lien: { status: 'unavailable' }, damage: { status: 'unavailable', items: [] }, source: null, asOf: null };
  const tri = (x) => (x && ['found', 'none_found', 'unavailable'].includes(x.status) ? x : { status: 'unavailable' });
  const damage = tri(h.damage);
  const dItems = damage.status === 'found' && Array.isArray(damage.items)
    ? damage.items.map((d) => ({ date: fmtDate(d.date), kind: DAMAGE_KINDS.has(d.kind) ? d.kind : 'other', text: str(d.text, 300), country: str(d.country, 60) || null })) : [];
  return {
    status: 'ok',
    events: (Array.isArray(h.events) ? h.events : []).map((e) => ({ date: fmtDate(e.date), title: str(e.title, 120), place: str(e.place, 80) || null })).filter((e) => e.title),
    theft: { status: tri(h.theft).status, text: str(h.theft && h.theft.text, 200) || null },
    lien: { status: tri(h.lien).status, text: str(h.lien && h.lien.text, 200) || null },
    damage: { status: damage.status === 'found' && !dItems.length ? 'unavailable' : damage.status, items: dItems },
    source: str(h.source, 80) || null, asOf: str(h.asOf, 10) || null,
  };
}

/** Comparatif : options du catalogue de la finition, présentes (✓) ou non (✗). Équipé à X % pondéré par le prix catalogue. */
function buildComparison(options, catalogue) {
  if (!Array.isArray(catalogue) || catalogue.length < 5) return { status: 'unavailable' };
  const have = new Set(options.map((o) => o.code));
  const present = [], missing = [];
  for (const c of catalogue) {
    if (!c || !c.code) continue;
    const row = { code: String(c.code), label: str(c.label, 200) || String(c.code), priceCents: Number.isInteger(c.priceCents) && c.priceCents >= 0 ? c.priceCents : null, category: c.category ? str(c.category, 60) : null };
    (have.has(row.code) ? present : missing).push(row);
  }
  const sum = (a) => a.reduce((s, o) => s + (o.priceCents || 0), 0);
  const total = sum(present) + sum(missing);
  const pct = total > 0 ? Math.round((sum(present) / total) * 100) : Math.round((present.length / (present.length + missing.length)) * 100);
  return { status: 'ok', equippedPct: pct, weightedByPrice: total > 0, presentCount: present.length, missing, missingCount: missing.length, missingTotalCents: sum(missing) };
}

function optionTotals(options) {
  const priced = options.filter((o) => o.priceCents != null);
  return { totalCents: priced.reduce((s, o) => s + o.priceCents, 0), pricedCount: priced.length, unpricedCount: options.length - priced.length, count: options.length };
}

const SRC_LABEL = { vindata: 'VINdata', jato: 'JATO Dynamics', autovista: 'Autovista', dat: 'DAT', carvertical: 'carVertical', carfax: 'CARFAX Europe', automotivapi: 'AutomotivAPI', vincario: 'Vincario', mock: 'Données de test' };
const srcLabel = (k) => SRC_LABEL[k] || str(k, 60);

/**
 * @param in.plan          'essentiel' | 'premium'
 * @param in.decoded       { vehicle, options (déjà traduites), tech?, catalogue?, source }
 * @param in.translation   résultat de translateOptions (stats, untranslated) — facultatif
 * @param in.recalls       résultat brut adaptateur rappels (ou null)
 * @param in.history       résultat brut adaptateur historique (ou null)
 * @param in.valuation     résultat estimateValue (ou null), in.explanation
 */
function assembleReport(i) {
  const F = PLAN_FEATURES[i.plan];
  if (!F) throw new Error('PLAN_INVALID');
  const d = i.decoded, vehicle = d.vehicle || {};
  const options = d.options;
  const notices = [];
  const out = {
    version: REPORT_VERSION, plan: i.plan, vin: i.vin, generatedAt: i.generatedAt || new Date().toISOString(),
    vehicle: { make: str(vehicle.make, 60) || null, model: str(vehicle.model, 80) || null, trim: str(vehicle.trim, 80) || null, year: vehicle.year || null, engine: str(vehicle.engine, 80) || null, color: str(vehicle.color, 60) || null, upholstery: str(vehicle.upholstery, 60) || null },
    options: { items: options, ...optionTotals(options) },
    techSheet: buildTechSheet(vehicle, d.tech),
    recalls: F.recalls ? buildRecalls(i.recalls) : null,
    provenance: F.provenance ? buildProvenance(i.history) : null,
    comparison: F.comparison ? buildComparison(options, d.catalogue) : null,
    valuation: F.valuation ? (i.valuation || null) : null,
    explanation: F.valuation && i.valuation && i.valuation.status === 'ok' ? (i.explanation || null) : null,
    sources: [],
  };
  if (out.options.unpricedCount) notices.push(`${out.options.unpricedCount} option(s) sans prix catalogue disponible : elles ne sont pas comptées dans la valeur totale.`);
  if (i.translation && i.translation.untranslated && i.translation.untranslated.length) notices.push(`${i.translation.untranslated.length} libellé(s) d’option affiché(s) dans la langue d’origine, faute de traduction fiable.`);
  if (out.recalls && out.recalls.status === 'unavailable') notices.push('Les campagnes de rappel n’ont pas pu être consultées pour ce véhicule.');
  if (out.provenance && out.provenance.status === 'unavailable') notices.push('L’historique du véhicule n’est pas disponible pour ce VIN : cette rubrique n’a pas pu être établie.');
  if (out.provenance && out.provenance.status === 'ok' && out.provenance.damage.status === 'unavailable') notices.push('Les sinistres n’ont pas pu être vérifiés pour ce véhicule (couverture variable selon les pays).');
  if (out.comparison && out.comparison.status === 'unavailable') notices.push('Le comparatif n’est pas disponible : le catalogue d’options de cette finition est incomplet.');
  out.notices = notices;
  const seen = new Set();
  const addSrc = (name, role, asOf) => { if (!name) return; const k = `${name}|${role}`; if (seen.has(k)) return; seen.add(k); out.sources.push({ name: srcLabel(name), role, asOf: asOf || null }); };
  addSrc(d.source, 'Options, prix catalogue et caractéristiques');
  if (out.recalls && out.recalls.source) addSrc(out.recalls.source, 'Campagnes de rappel', out.recalls.asOf);
  if (out.provenance && out.provenance.source) addSrc(out.provenance.source, 'Historique du véhicule', out.provenance.asOf);
  return out;
}

module.exports = { REPORT_VERSION, PLAN_FEATURES, assembleReport, buildTechSheet, buildRecalls, buildProvenance, buildComparison, optionTotals, fmtDate };
