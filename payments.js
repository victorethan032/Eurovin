'use strict';
/**
 * Logique de paiement et de gestion, PURE (sans réseau ni base) : testable seule.
 * - Construction de la session Stripe Checkout (tous les moyens de paiement activés dans le Dashboard Stripe)
 * - Calcul des avoirs (remboursements partiels ou totaux), sans dérive d'arrondi
 * - Validation SIRET, tickets de support, authentification admin
 */
const crypto = require('crypto');
const lib = require('./lib');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const safeEq = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length === B.length && A.length > 0 && crypto.timingSafeEqual(A, B); };

/** Moyens de paiement affichés par Stripe Checkout.
 *  Par défaut : AUCUNE liste ici → Stripe choisit dynamiquement selon le pays, la devise et les moyens activés dans
 *  Dashboard → Paramètres → Moyens de paiement (carte, Apple Pay, Google Pay, Link, PayPal, iDEAL, Bancontact, SEPA,
 *  EPS, Przelewy24, BLIK, Klarna, etc.). Pour forcer une liste : PAYMENT_METHOD_TYPES="card,paypal,ideal". */
function paymentMethodTypes(env = process.env) {
  const raw = String(env.PAYMENT_METHOD_TYPES || '').trim();
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9_]+$/.test(s));
  return list.length ? list : null;
}

const planName = (p) => (p === 'premium' ? 'Premium' : 'Essentiel');

/** Paramètres de la session Checkout. Les montants viennent TOUJOURS du serveur (lib), jamais du client. */
function buildCheckoutParams({ body, user, customerId, meta, appUrl, taxOn, env = process.env }) {
  const methods = paymentMethodTypes(env);
  const common = {
    mode: 'payment',
    locale: 'auto',                                           // langue de l'acheteur, dans toute l'Europe
    billing_address_collection: 'required',                   // nécessaire à la TVA du pays de l'acheteur
    allow_promotion_codes: env.ALLOW_PROMO_CODES !== '0',     // codes promo créés dans le Dashboard Stripe
    metadata: meta,
    cancel_url: `${appUrl}/`,
    success_url: `${appUrl}/commande/succes?session_id={CHECKOUT_SESSION_ID}`,
    expires_at: Math.floor(Date.now() / 1000) + 30 * 60,     // lien de paiement valable 30 minutes
    ...(methods ? { payment_method_types: methods } : {}),
    ...(taxOn ? { automatic_tax: { enabled: true } } : {}),
  };
  if (customerId) {                                           // compte connecté : moyens de paiement enregistrables
    common.customer = customerId;
    common.customer_update = { address: 'auto', name: 'auto' };
    common.saved_payment_method_options = { payment_method_save: 'enabled' };
  }
  if (body.kind === 'report') {
    return { ...common,
      ...(customerId ? {} : { customer_email: body.email }),
      payment_intent_data: { description: `Rapport ${planName(body.plan)} — VIN ${body.vin}`, metadata: { kind: 'report', plan: body.plan } },
      line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: lib.PRICES_TTC_CENTS[body.plan], tax_behavior: 'inclusive',
        product_data: { name: `Rapport ${planName(body.plan)}`, description: `VIN ${body.vin}` } } }] };
  }
  return { ...common,
    ...(customerId ? {} : { customer_email: user.email }),
    tax_id_collection: { enabled: true },                     // numéro de TVA des professionnels
    payment_intent_data: { description: `Pack ${body.packSize} crédits`, metadata: { kind: 'pack', pack_size: String(body.packSize) } },
    line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: lib.PACKS_HT_CENTS[body.packSize], tax_behavior: 'exclusive',
      product_data: { name: `Pack ${body.packSize} crédits` } } }] };
}

/** Répartition HT / TVA d'un avoir. Le dernier avoir solde exactement la TVA restante (pas d'écart d'un centime). */
function splitCreditNote(order, amountCents) {
  const ttc = order.amount_ttc_cents | 0, tax = order.amount_tax_cents | 0;
  const done = order.refunded_cents | 0, doneTax = order.refunded_tax_cents | 0;
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw Object.assign(new Error('Montant invalide'), { code: 'AMOUNT_INVALID' });
  const remaining = ttc - done;
  if (amountCents > remaining) throw Object.assign(new Error('Dépasse le montant restant remboursable'), { code: 'EXCEEDS_REMAINING' });
  let t = amountCents === remaining ? tax - doneTax : Math.round((tax * amountCents) / (ttc || 1));
  t = Math.max(0, Math.min(t, amountCents));
  return { ttc: amountCents, tax: t, ht: amountCents - t, remainingAfter: remaining - amountCents };
}

/** Crédits à retirer lors du remboursement (partiel ou total) d'un pack. */
function creditsToReverse(order, amountCents) {
  if (order.kind !== 'pack' || !(order.credits_delta > 0)) return 0;
  const remaining = (order.amount_ttc_cents | 0) - (order.refunded_cents | 0);
  const left = order.credits_delta - (order.credits_reversed | 0);
  if (amountCents >= remaining) return Math.max(0, left);
  return Math.min(left, Math.ceil((order.credits_delta * amountCents) / (order.amount_ttc_cents || 1)));
}

/** Contrôle SIRET (14 chiffres + clé de Luhn ; La Poste et ses établissements ont une règle propre). */
function validSiret(raw) {
  const s = String(raw || '').replace(/\s/g, '');
  if (!/^\d{14}$/.test(s)) return false;
  if (s.startsWith('356000000')) return [...s].reduce((a, d) => a + +d, 0) % 5 === 0;
  let sum = 0;
  for (let i = 0; i < 14; i++) { let d = +s[13 - i]; if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return sum % 10 === 0;
}

const TICKET_SUBJECTS = ['Rapport incomplet ou erroné', 'Remboursement', 'Facture', 'Mon compte', 'Autre'];
function validateTicket(b) {
  b = b || {};
  const email = String(b.email || '').trim().toLowerCase();
  const message = String(b.message || '').trim();
  if (!lib.MAIL.test(email)) return { ok: false, error: 'EMAIL_INVALID' };
  if (!TICKET_SUBJECTS.includes(b.subject)) return { ok: false, error: 'SUBJECT_INVALID' };
  if (message.length < 10 || message.length > 4000) return { ok: false, error: 'MESSAGE_INVALID' };
  let vin = null;
  if (b.vin) { const v = lib.checkVin(b.vin); if (!v.ok) return { ok: false, error: 'VIN_INVALID' }; vin = v.vin; }
  return { ok: true, value: { email, subject: b.subject, message, vin } };
}

const ERROR_TYPES = ['Une option manque', 'Une option est en trop', 'Couleur ou sellerie', 'Motorisation ou finition', 'Autre'];
function validateReportError(b) {
  b = b || {};
  const details = String(b.details || '').trim();
  if (!ERROR_TYPES.includes(b.type)) return { ok: false, error: 'TYPE_INVALID' };
  if (details.length > 2000) return { ok: false, error: 'DETAILS_INVALID' };
  return { ok: true, value: { type: b.type, details } };
}

function validateProfilePatch(b) {
  b = b || {};
  const out = {};
  if (has(b, 'phone')) {
    const p = String(b.phone || '').replace(/[\s().-]/g, '');
    if (p && !/^\+?\d{9,15}$/.test(p)) return { ok: false, error: 'PHONE_INVALID' };
    out.phone = p || null;
  }
  if (has(b, 'company_name')) { const n = String(b.company_name || '').trim(); if (n.length > 120) return { ok: false, error: 'COMPANY_INVALID' }; out.company_name = n || null; }
  if (has(b, 'company_siret')) { const s = String(b.company_siret || '').replace(/\s/g, ''); if (s && !validSiret(s)) return { ok: false, error: 'SIRET_INVALID' }; out.company_siret = s || null; }
  if (has(b, 'company_vat')) { const v = String(b.company_vat || '').replace(/\s/g, '').toUpperCase(); if (v && !/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(v)) return { ok: false, error: 'VAT_INVALID' }; out.company_vat = v || null; }
  if (!Object.keys(out).length) return { ok: false, error: 'NOTHING_TO_UPDATE' };
  return { ok: true, value: out };
}

/** Résumé chiffré pour le tableau de bord admin, à partir de lignes de commandes. */
function summarizeOrders(rows) {
  const s = { orders: 0, paid_ttc_cents: 0, refunded_cents: 0, net_ttc_cents: 0, tax_cents: 0, reports: 0, packs: 0, credit_uses: 0, refunded_orders: 0, disputes: 0 };
  for (const o of rows) {
    s.orders++;
    if (o.kind === 'credit_use') { s.credit_uses++; if (o.status === 'refunded') s.refunded_orders++; continue; }
    s.paid_ttc_cents += o.amount_ttc_cents | 0; s.refunded_cents += o.refunded_cents | 0; s.tax_cents += (o.amount_tax_cents | 0) - (o.refunded_tax_cents | 0);
    if (o.kind === 'report') s.reports++; else if (o.kind === 'pack') s.packs++;
    if ((o.refunded_cents | 0) > 0) s.refunded_orders++;
    if (o.dispute_status) s.disputes++;
  }
  s.net_ttc_cents = s.paid_ttc_cents - s.refunded_cents;
  return s;
}

module.exports = { safeEq, paymentMethodTypes, buildCheckoutParams, splitCreditNote, creditsToReverse, validSiret, validateTicket, validateReportError,
  validateProfilePatch, summarizeOrders, TICKET_SUBJECTS, ERROR_TYPES };
