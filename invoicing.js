'use strict';
/**
 * Règles de facturation PURES (sans réseau ni base) : testables seules.
 * Une facture conserve une COPIE de l'identité du vendeur et de l'acheteur au jour de l'émission : changer son profil plus tard ne modifie jamais une facture émise.
 */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const EU = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const str = (v, n = 200) => (v == null ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n));

let sellerOverride = {};                                   // profil de l'exploitant saisi dans la console admin (prioritaire sur les variables d'environnement)
const SELLER_KEYS = ['name', 'legalForm', 'capital', 'siren', 'rcs', 'address', 'vat', 'email'];
function setSellerOverride(o) { sellerOverride = o && typeof o === 'object' ? { ...o } : {}; }
function sellerFromEnv(env = process.env) {
  const base = {
    name: env.SELLER_NAME, legalForm: env.SELLER_LEGAL_FORM, capital: env.SELLER_CAPITAL, siren: env.SELLER_SIREN, rcs: env.SELLER_RCS,
    address: env.SELLER_ADDRESS, vat: env.SELLER_VAT, email: env.SELLER_EMAIL, franchise: env.SELLER_VAT_FRANCHISE === '1',
  };
  if (env !== process.env) return base;
  for (const k of SELLER_KEYS) if (sellerOverride[k] != null && String(sellerOverride[k]).trim() !== '') base[k] = String(sellerOverride[k]).trim();
  if (typeof sellerOverride.franchise === 'boolean') base.franchise = sellerOverride.franchise;
  return base;
}
/** SIREN : 9 chiffres, clé de Luhn. */
function validSiren(raw) {
  const d = String(raw || '').replace(/\s/g, ''); if (!/^\d{9}$/.test(d)) return false;
  let sum = 0; for (let i = 0; i < 9; i++) { let n = +d[8 - i]; if (i % 2) { n *= 2; if (n > 9) n -= 9; } sum += n; } return sum % 10 === 0;
}
/** Mentions du vendeur indispensables à l'émission : renvoie la liste de celles qui manquent. */
function sellerMissing(s) {
  const miss = [];
  if (!str(s.name)) miss.push('SELLER_NAME');
  if (!str(s.legalForm)) miss.push('SELLER_LEGAL_FORM');
  if (!str(s.siren)) miss.push('SELLER_SIREN');
  if (!str(s.address)) miss.push('SELLER_ADDRESS');
  if (!str(s.rcs)) miss.push('SELLER_RCS');
  if (!s.franchise && !str(s.vat)) miss.push('SELLER_VAT');
  return miss;
}

/** Taux de TVA appliqué, déduit des montants réellement facturés par Stripe Tax (jamais saisi à la main). */
function vatRate(htCents, taxCents) { return htCents > 0 ? Math.round((taxCents / htCents) * 1000) / 10 : 0; }

const MENTION = {
  reverse_charge: 'Autoliquidation : TVA due par le preneur (article 196 de la directive 2006/112/CE).',
  zero_review: 'TVA non applicable : opération non soumise à la TVA française (à confirmer avec votre comptable).',
  franchise: 'TVA non applicable, article 293 B du CGI.',
};
/** standard | reverse_charge | zero_review | franchise */
function vatRegime({ taxCents, buyerCountry, buyerVat, franchise }) {
  if (franchise) return 'franchise';
  if (taxCents > 0) return 'standard';
  const c = str(buyerCountry, 2).toUpperCase();
  if (buyerVat && c && c !== 'FR' && EU.has(c)) return 'reverse_charge';
  return 'zero_review';
}

const B2B_TERMS = 'Escompte pour paiement anticipé : néant. En cas de retard de paiement : pénalités au taux de refinancement de la BCE majoré de 10 points et indemnité forfaitaire de recouvrement de 40 €.';

function splitSiren(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(0, 9) : null;
}

/**
 * Données de facture à partir d'une session Stripe payée.
 * s : session Checkout ; m : metadata ; seller : copie du vendeur.
 */
function buildInvoiceDetails({ s, m, seller, paidAtIso, description }) {
  const cd = s.customer_details || {}, a = cd.address || {};
  const tax = (s.total_details && s.total_details.amount_tax) || 0, ttc = s.amount_total || 0, ht = ttc - tax;
  const taxId = cd.tax_ids && cd.tax_ids[0] ? String(cd.tax_ids[0].value) : null;
  const pro = m.kind === 'pack';                                                // les packs sont réservés aux professionnels
  const country = str(a.country, 2).toUpperCase() || null;
  const regime = vatRegime({ taxCents: tax, buyerCountry: country, buyerVat: taxId, franchise: seller.franchise });
  const rate = vatRate(ht, tax);
  const name = str(pro ? (m.company_name || cd.business_name || cd.name) : cd.name, 160) || null;
  const qty = 1;
  const lines = [{ label: str(description, 200), qty, unit_ht_cents: ht, vat_rate: rate, ht_cents: ht, tax_cents: tax, ttc_cents: ttc }];
  const day = (paidAtIso || new Date().toISOString()).slice(0, 10);
  return {
    buyer_type: pro ? 'professionnel' : 'particulier',
    buyer_name: name,
    buyer_address: { line1: str(a.line1, 160) || null, line2: str(a.line2, 160) || null, postal_code: str(a.postal_code, 20) || null, city: str(a.city, 100) || null, country },
    buyer_country: country,
    buyer_siren: pro ? splitSiren(m.company_siret) : null,
    buyer_vat: taxId || (pro && m.company_vat ? str(m.company_vat, 30) : null),
    vat_rate: rate, vat_regime: regime, vat_mention: MENTION[regime] || null,
    lines, service_date: day, operation_nature: 'services', due_date: day,   // payée à la commande : échéance = jour du paiement
    paid_at: paidAtIso || new Date().toISOString(),
    payment_terms: pro ? B2B_TERMS : null,
    seller,
  };
}

/** Une facture professionnelle est « complète » si l'acheteur est identifiable comme l'exige la réforme 2026. */
function missingBuyerFields(inv) {
  if (inv.buyer_type !== 'professionnel') return [];
  const a = inv.buyer_address || {}, miss = [];
  if (!str(inv.buyer_name)) miss.push('nom de la société');
  if (!str(a.line1) || !str(a.postal_code) || !str(a.city) || !str(a.country)) miss.push('adresse');
  if (a.country === 'FR' && !inv.buyer_siren) miss.push('SIREN');
  return miss;
}

/** Lignes d'une facture (anciennes factures sans détail : une ligne reconstituée à partir des totaux). */
function linesOf(inv) {
  if (Array.isArray(inv.lines) && inv.lines.length) return inv.lines;
  const r = vatRate(inv.amount_ht_cents, inv.amount_tax_cents);
  return [{ label: inv.description, qty: 1, unit_ht_cents: inv.amount_ht_cents, vat_rate: r, ht_cents: inv.amount_ht_cents, tax_cents: inv.amount_tax_cents, ttc_cents: inv.amount_ttc_cents }];
}

/** Export comptable CSV (séparateur « ; », virgule décimale, BOM UTF-8 : s'ouvre directement dans Excel). Les avoirs sont en négatif. */
const CSV_HEAD = ['Type', 'Numéro', 'Date', 'Facture d\'origine', 'Client', 'Type client', 'Pays', 'SIREN', 'N° TVA client', 'Total HT', 'TVA', 'Total TTC', 'Taux TVA', 'Régime TVA', 'Statut Pennylane', 'Réf. Pennylane'];
const cell = (v) => { if (v && v.n != null) return String(v.n); let t = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
const money = (c) => ({ n: (c / 100).toFixed(2).replace('.', ',') });
function accountingCsv(invoices, notes = []) {
  const rows = [];
  for (const i of invoices) rows.push(['Facture', i.number, String(i.issued_at).slice(0, 10), '', i.buyer_name || i.buyer_email, i.buyer_type || '', i.buyer_country || '', i.buyer_siren || '', i.buyer_vat || '', money(i.amount_ht_cents), money(i.amount_tax_cents), money(i.amount_ttc_cents), i.vat_rate != null ? String(i.vat_rate).replace('.', ',') : '', i.vat_regime || '', i.accounting_status || '', i.accounting_ref || '']);
  for (const n of notes) rows.push(['Avoir', n.number, String(n.issued_at).slice(0, 10), n.invoice_number || '', n.buyer_name || n.buyer_email, n.buyer_type || '', n.buyer_country || '', n.buyer_siren || '', n.buyer_vat || '', money(-n.amount_ht_cents), money(-n.amount_tax_cents), money(-n.amount_ttc_cents), n.vat_rate != null ? String(n.vat_rate).replace('.', ',') : '', n.vat_regime || '', n.accounting_status || '', n.accounting_ref || '']);
  rows.sort((a, b) => (a[2] + a[1] > b[2] + b[1] ? 1 : -1));
  return '\ufeff' + [CSV_HEAD, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/* ---- Export mensuel : TVA par pays (heure de Paris) ---- */
function parisOffsetMs(t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
function parisMonthStart(y, m0) { let t = Date.UTC(y, m0, 1); for (let i = 0; i < 3; i++) t = Date.UTC(y, m0, 1) - parisOffsetMs(t); return t; }
/** 'AAAA-MM' → { start, end } en ISO UTC : le mois civil complet, à l'heure de Paris. null si invalide. */
function monthBounds(month) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || '')); if (!m) return null;
  const y = +m[1], mo = +m[2] - 1;
  return { start: new Date(parisMonthStart(y, mo)).toISOString(), end: new Date(parisMonthStart(mo === 11 ? y + 1 : y, (mo + 1) % 12)).toISOString() };
}
/** Mois précédent (AAAA-MM) d'une date, à l'heure de Paris. */
function previousMonth(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]));
  let y = +p.year, m = +p.month - 1; if (m === 0) { m = 12; y--; }
  return `${y}-${String(m).padStart(2, '0')}`;
}
const parisDay = (now = new Date()) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', day: '2-digit' }).format(now);

const SUM_HEAD = ['Mois', 'Pays', 'Régime TVA', 'Taux TVA', 'Nb factures', 'Nb avoirs', 'HT factures', 'TVA factures', 'TTC factures', 'HT avoirs', 'TVA avoirs', 'TTC avoirs', 'HT net', 'TVA nette', 'TTC net'];
/** Synthèse TVA par pays / régime / taux : factures − avoirs = net à déclarer. Avoirs rattachés au mois d'émission de l'avoir. */
function vatByCountry(invoices, notes, month) {
  const g = new Map();
  const slot = (o) => { const k = [o.buyer_country || 'N/D', o.vat_regime || 'standard', o.vat_rate != null ? Number(o.vat_rate) : (o.amount_ht_cents ? vatRate(o.amount_ht_cents, o.amount_tax_cents) : 0)].join('|'); if (!g.has(k)) g.set(k, { c: o.buyer_country || 'N/D', reg: o.vat_regime || 'standard', rate: k.split('|')[2], ni: 0, nn: 0, ih: 0, it: 0, ic: 0, nh: 0, nt: 0, nc: 0 }); return g.get(k); };
  for (const i of invoices) { const x = slot(i); x.ni++; x.ih += i.amount_ht_cents; x.it += i.amount_tax_cents; x.ic += i.amount_ttc_cents; }
  for (const n of notes) { const x = slot(n); x.nn++; x.nh += n.amount_ht_cents; x.nt += n.amount_tax_cents; x.nc += n.amount_ttc_cents; }
  const list = [...g.values()].sort((a, b) => (a.c + a.reg + a.rate > b.c + b.reg + b.rate ? 1 : -1));
  const row = (x) => [month, x.c, x.reg, String(x.rate).replace('.', ','), x.ni, x.nn, money(x.ih), money(x.it), money(x.ic), money(-x.nh), money(-x.nt), money(-x.nc), money(x.ih - x.nh), money(x.it - x.nt), money(x.ic - x.nc)];
  const tot = list.reduce((a, x) => ({ ni: a.ni + x.ni, nn: a.nn + x.nn, ih: a.ih + x.ih, it: a.it + x.it, ic: a.ic + x.ic, nh: a.nh + x.nh, nt: a.nt + x.nt, nc: a.nc + x.nc }), { ni: 0, nn: 0, ih: 0, it: 0, ic: 0, nh: 0, nt: 0, nc: 0 });
  const rows = list.map(row); rows.push(row({ ...tot, c: 'TOTAL', reg: '', rate: '' }));
  return { list, total: tot, csv: '\ufeff' + [SUM_HEAD, ...rows].map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n' };
}
/** Pièces dont la comptabilité demande un regard humain (TVA à valider, envoi Pennylane en erreur). */
const anomalies = (invoices) => invoices.filter((i) => ['needs_review', 'error'].includes(i.accounting_status) || i.vat_regime === 'zero_review').length;

module.exports = { setSellerOverride, validSiren, SELLER_KEYS, monthBounds, previousMonth, parisDay, vatByCountry, anomalies, accountingCsv, sellerFromEnv, sellerMissing, vatRate, vatRegime, buildInvoiceDetails, missingBuyerFields, linesOf, splitSiren, MENTION, B2B_TERMS, EU };
