'use strict';
/**
 * Logique métier pure (sans réseau, sans base) : testable seule.
 * Règles identiques au site : même contrôle de VIN, mêmes prix, même coût en crédits.
 */
const MIN_OPTIONS = 10;          // en dessous : remboursement automatique
const MIN_COMPS = 15;            // comparables minimum pour oser une cotation
const MIN_OPTION_SAMPLE = 30;    // échantillon minimum pour afficher la plus-value d'une option
// Prix par défaut ; modifiables par l'administrateur (siteconfig.applyPrices met ces objets à jour sur place).
const PRICES_TTC_CENTS = { essentiel: 799, premium: 1299 };
const PACKS_HT_CENTS = { 10: 4900, 30: 12900, 100: 37900 };
const CREDIT_COST = Object.freeze({ essentiel: 1, premium: 2 }); // 1 crédit = 1 Essentiel, Premium = 2
const MAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function checkVin(raw) {
  const vin = String(raw || '').trim().toUpperCase();
  if (vin.length !== 17) return { ok: false, reason: 'LENGTH' };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return { ok: false, reason: 'CHARS' };
  if (/^[1-5JKL]/.test(vin)) return { ok: false, reason: 'NON_EU' };
  return { ok: true, vin };
}

// Préfixes WMI (3 premiers caractères) : marque uniquement. Inconnu => null (on n'invente rien).
const WMI = { WBA:'BMW', WBS:'BMW M', WBY:'BMW i', WDB:'Mercedes-Benz', WDC:'Mercedes-Benz', WDD:'Mercedes-Benz', WDF:'Mercedes-Benz', W1K:'Mercedes-Benz', W1N:'Mercedes-Benz', W1V:'Mercedes-Benz',
  WAU:'Audi', WUA:'Audi quattro', TRU:'Audi', WVW:'Volkswagen', WVG:'Volkswagen', WV1:'Volkswagen Utilitaires', WV2:'Volkswagen Utilitaires', WP0:'Porsche', WP1:'Porsche', VF1:'Renault', VF3:'Peugeot', VF7:'Citroën', VF6:'Renault Trucks', VR1:'DS Automobiles', UU1:'Dacia', VNK:'Toyota (Europe)', VSS:'SEAT', VSX:'Opel', W0L:'Opel', W0V:'Opel', WF0:'Ford (Allemagne)', VS6:'Ford (Espagne)', ZFA:'Fiat', ZFF:'Ferrari', ZAR:'Alfa Romeo', ZLA:'Lancia', ZHW:'Lamborghini', ZAM:'Maserati', ZAP:'Piaggio',
  SAJ:'Jaguar', SAL:'Land Rover', SCC:'Lotus', SCF:'Aston Martin', SBM:'McLaren', SAR:'Rover', SAX:'Rover', SCA:'Rolls-Royce', SCB:'Bentley', YV1:'Volvo', YV4:'Volvo', YS3:'Saab', TMB:'Škoda', TMA:'Hyundai (Tchéquie)', TM9:'Škoda', U5Y:'Kia (Slovaquie)', VSK:'Nissan (Espagne)', SJN:'Nissan (Royaume-Uni)', SB1:'Toyota (Royaume-Uni)', SHH:'Honda (Royaume-Uni)', WMW:'MINI', WSM:'Smart', WME:'Smart', VXK:'DS / Opel', YAR:'Toyota (Europe)', ZCF:'Iveco', WMA:'MAN', XTA:'Lada', TRA:'Ikarus' };
const VINFACTS = typeof require === 'function' ? require('./site/vinfacts.js') : { facts: () => ({}) };   // la console de démonstration charge ce fichier dans le navigateur
const brandFromVin = (vin) => { const v = String(vin || '').toUpperCase(); return WMI[v.slice(0, 3)] || null; };

function normalizeOptions(list) {
  const seen = new Map();
  for (const o of Array.isArray(list) ? list : []) {
    const code = String((o && o.code) ?? '').trim();
    if (!code || seen.has(code)) continue;
    const label = String((o && o.label) ?? '').trim() || code;
    const p = o && o.priceCents;
    const row = { code, label, priceCents: Number.isInteger(p) && p >= 0 ? p : null, category: o && o.category ? String(o.category) : null };
    if (o && typeof o.lang === 'string') row.lang = o.lang.slice(0, 5).toLowerCase();                 // langue du libellé fournisseur (traduction)
    if (o && typeof o.labelFr === 'string' && o.labelFr.trim()) row.labelFr = o.labelFr.trim();
    seen.set(code, row);
  }
  return [...seen.values()];
}
const countOptions = (list) => normalizeOptions(list).length;

const fail = (error) => ({ ok: false, error });
function validateCheckoutBody(b) {
  b = b || {};
  const c = b.consent || {};
  if (b.kind === 'report') {
    const v = checkVin(b.vin);
    if (!v.ok) return fail('VIN_INVALID');
    if (typeof b.plan !== 'string' || !has(PRICES_TTC_CENTS, b.plan)) return fail('PLAN_INVALID');
    if (!MAIL.test(String(b.email || '').trim())) return fail('EMAIL_INVALID');
    if (c.cgv !== true) return fail('CGV_REQUIRED');
    if (c.waiver !== true) return fail('WAIVER_REQUIRED');
    return { ok: true, value: { kind: 'report', vin: v.vin, plan: b.plan, email: String(b.email).trim().toLowerCase() } };
  }
  if (b.kind === 'pack') {
    const size = Number(b.packSize);
    if (!has(PACKS_HT_CENTS, String(size))) return fail('PACK_INVALID');
    if (c.cgv !== true) return fail('CGV_REQUIRED');
    return { ok: true, value: { kind: 'pack', packSize: size } };
  }
  return fail('KIND_INVALID');
}

const round10 = (n) => Math.max(0, Math.round(n / 10) * 10);

/**
 * Cotation DÉTERMINISTE. Jamais produite par un LLM.
 * stats (fournies par le fournisseur de données de marché sous licence) :
 *   { n, base:{p25,p50,p75}   // prix de la « base nue » (équipement de série) pour ce modèle/millésime
 *     medianKm, kmSlope       // €/km (négatif)
 *     optionUplifts:{ code:{ amount, n } } }
 * Si les données sont insuffisantes : « non estimable » (jamais de prix par défaut).
 */
function estimateValue(stats, { km = null, presentCodes = [] } = {}) {
  const b = stats && stats.base;
  if (!stats || !b || ![b.p25, b.p50, b.p75].every(Number.isFinite) || !(stats.n >= MIN_COMPS))
    return { status: 'not_estimable', reason: 'COMPARABLES_INSUFFISANTS' };
  if (!(b.p25 <= b.p50 && b.p50 <= b.p75)) return { status: 'not_estimable', reason: 'DONNEES_INCOHERENTES' };
  let kmAdj = 0;
  if (Number.isFinite(km) && km >= 0 && Number.isFinite(stats.medianKm) && Number.isFinite(stats.kmSlope)) {
    kmAdj = (km - stats.medianKm) * stats.kmSlope;
    const cap = b.p50 * 0.3;
    kmAdj = Math.max(-cap, Math.min(cap, kmAdj));
  }
  const ups = stats.optionUplifts || {};
  const breakdown = [];
  let optAdj = 0;
  for (const code of presentCodes) {
    const u = has(ups, code) ? ups[code] : null;
    if (u && Number.isFinite(u.amount) && u.amount > 0 && u.n >= MIN_OPTION_SAMPLE) {
      breakdown.push({ code, amount: Math.round(u.amount) });
      optAdj += u.amount;
    }
  }
  const capO = b.p50 * 0.15;
  if (optAdj > capO) { const f = capO / optAdj; breakdown.forEach((x) => (x.amount = Math.round(x.amount * f))); optAdj = capO; }
  const adj = kmAdj + optAdj;
  return { status: 'ok', low: round10(b.p25 + adj), mid: round10(b.p50 + adj), high: round10(b.p75 + adj), kmAdj: Math.round(kmAdj), optionsAdj: Math.round(optAdj), breakdown, n: stats.n };
}

const fmtEur = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;
function templateExplanation(v) {
  const opt = v.optionsAdj > 0
    ? `Les options d’usine retenues ajoutent environ ${fmtEur(v.optionsAdj)} à cette valeur.`
    : 'Aucune plus-value d’option n’a pu être établie avec assez de données.';
  return `Estimation indicative fondée sur ${v.n} annonces comparables : de ${fmtEur(v.low)} à ${fmtEur(v.high)}, valeur de marché médiane ${fmtEur(v.mid)}. ${opt} Cette estimation n’est ni une expertise ni une garantie de prix.`;
}
const allowedNumbers = (v) => [v.low, v.mid, v.high, v.kmAdj, v.optionsAdj, v.n, ...v.breakdown.map((x) => x.amount)];

/** Garde-fou : un texte rédigé par IA ne doit contenir aucun montant absent du calcul. */
function explanationIsSafe(text, allowed) {
  if (typeof text !== 'string' || text.length < 20 || text.length > 600) return false;
  if (/expert|garanti|certifi|inspection|officiel|conseil d.?achat/i.test(text)) return false;
  const set = new Set(allowed.map((x) => Math.round(Math.abs(x))));
  for (const m of text.matchAll(/\d[\d\s\u00a0\u202f.,]*\d|\d/g)) {
    const v = parseFloat(m[0].replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
    if (Number.isFinite(v) && v >= 100 && !set.has(Math.round(v))) return false;
  }
  return true;
}

module.exports = { MIN_OPTIONS, MIN_COMPS, MIN_OPTION_SAMPLE, PRICES_TTC_CENTS, PACKS_HT_CENTS, CREDIT_COST, MAIL,
  checkVin, brandFromVin, vinFacts: VINFACTS.facts, WMI, normalizeOptions, countOptions, validateCheckoutBody, estimateValue, templateExplanation, allowedNumbers, explanationIsSafe, fmtEur };
