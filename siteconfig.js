'use strict';
/**
 * Contenu et réglages du site modifiables par l'administrateur (bandeau, maintenance, prix, textes, pages légales, FAQ).
 * Validation stricte : rien n'est enregistré s'il y a une valeur invalide. Les textes sont du texte simple (jamais du HTML).
 */
const lib = require('./lib');

const DEFAULT_PRICES = Object.freeze({ essentiel: 799, premium: 1299, packs: Object.freeze({ 10: 4900, 30: 12900, 100: 37900 }) });
const PAGE_KEYS = ['mentions', 'cgv', 'privacy', 'cookies', 'ret', 'med'];
const EMPTY = () => ({ banner: { enabled: false, text: '', level: 'info' }, maintenance: { enabled: false, message: '' }, brand: { name: '', supportEmail: '' },
  home: { title1: '', title2: '', lead: '', note: '' }, prices: null, pages: {}, faq: null, valuation: null });

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\r\n?/g, '\n').trim().slice(0, n);
const line = (v, n) => clean(v, n).replace(/\n+/g, ' ');
const isCents = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

/** Valide une configuration envoyée par l'admin. Renvoie { ok, value } ou { ok:false, error }. */
function validate(input) {
  const b = input && typeof input === 'object' ? input : {}, out = EMPTY(), fail = (error) => ({ ok: false, error });
  const bn = b.banner || {}; out.banner = { enabled: bn.enabled === true, text: line(bn.text, 240), level: bn.level === 'warn' ? 'warn' : 'info' };
  if (out.banner.enabled && !out.banner.text) return fail('BANNER_TEXT_REQUIRED');
  const mt = b.maintenance || {}; out.maintenance = { enabled: mt.enabled === true, message: line(mt.message, 400) };
  const br = b.brand || {}; out.brand = { name: line(br.name, 40), supportEmail: line(br.supportEmail, 120).toLowerCase() };
  if (out.brand.supportEmail && !lib.MAIL.test(out.brand.supportEmail)) return fail('EMAIL_INVALID');
  const hm = b.home || {}; out.home = { title1: line(hm.title1, 80), title2: line(hm.title2, 80), lead: line(hm.lead, 300), note: line(hm.note, 300) };
  if (b.prices) {
    const p = b.prices, pk = p.packs || {};
    const next = { essentiel: Number(p.essentiel), premium: Number(p.premium), packs: { 10: Number(pk[10]), 30: Number(pk[30]), 100: Number(pk[100]) } };
    if (!isCents(next.essentiel, 100, 100000) || !isCents(next.premium, 100, 100000)) return fail('PRICE_INVALID');
    if (next.premium < next.essentiel) return fail('PRICE_ORDER');
    if (![10, 30, 100].every((n) => isCents(next.packs[n], 500, 5000000))) return fail('PRICE_INVALID');
    if (!(next.packs[10] < next.packs[30] && next.packs[30] < next.packs[100])) return fail('PACK_ORDER');
    // un pack plus gros ne doit jamais coûter plus cher par crédit qu'un plus petit
    if (next.packs[30] / 30 > next.packs[10] / 10 || next.packs[100] / 100 > next.packs[30] / 30) return fail('PACK_UNIT_ORDER');
    const same = next.essentiel === DEFAULT_PRICES.essentiel && next.premium === DEFAULT_PRICES.premium && [10, 30, 100].every((n) => next.packs[n] === DEFAULT_PRICES.packs[n]);
    out.prices = same ? null : next;
  }
  const pg = b.pages || {};
  for (const k of PAGE_KEYS) { const t = clean(pg[k], 40000); if (t) out.pages[k] = t; }
  if (Array.isArray(b.faq)) {
    if (b.faq.length > 30) return fail('FAQ_TOO_LONG');
    const items = b.faq.map((x) => ({ q: line(x && x.q, 200), a: clean(x && x.a, 2000) })).filter((x) => x.q || x.a);
    if (items.some((x) => !x.q || !x.a)) return fail('FAQ_INCOMPLETE');
    out.faq = items.length ? items : null;
  }
  out.valuation = typeof b.valuation === 'boolean' ? b.valuation : null;
  return { ok: true, value: out };
}

/** Prix effectifs (centimes) : personnalisés ou par défaut. */
function effectivePrices(cfg) { return cfg && cfg.prices ? cfg.prices : DEFAULT_PRICES; }
/** Applique les prix au module lib (utilisé par Stripe Checkout et les validations). */
function applyPrices(cfg) {
  const p = effectivePrices(cfg);
  lib.PRICES_TTC_CENTS.essentiel = p.essentiel; lib.PRICES_TTC_CENTS.premium = p.premium;
  for (const n of [10, 30, 100]) lib.PACKS_HT_CENTS[n] = p.packs[n];
}
/** Vue publique (sans rien de sensible) consommée par le site. */
function publicView(cfg, updatedAt) {
  const c = cfg || EMPTY();
  return { banner: c.banner && c.banner.enabled ? { text: c.banner.text, level: c.banner.level } : null, maintenance: c.maintenance && c.maintenance.enabled ? { message: c.maintenance.message } : null,
    brand: c.brand || {}, home: c.home || {}, prices: effectivePrices(c), pages: c.pages || {}, faq: c.faq || null, updatedAt: updatedAt || null };
}
module.exports = { validate, effectivePrices, applyPrices, publicView, EMPTY, DEFAULT_PRICES, PAGE_KEYS };
