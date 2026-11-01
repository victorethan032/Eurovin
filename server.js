'use strict';
/**
 * EuroVin — backend v2 (Node.js / Express, Supabase, Stripe, Resend, PDFKit ; IA facultative pour la rédaction)
 * Principes : le serveur ne fait jamais confiance au client ; chaque paiement et chaque crédit est traité une seule fois ;
 * aucune donnée inventée n'est livrée ; le prix de cotation est calculé, jamais généré par l'IA.
 */
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const OpenAI = require('openai');
const lib = require('./lib');
const { decodeVin, getMarketStats, getHistory, getRecalls } = require('./providers');
const { translateOptions } = require('./translate');
const R = require('./report');
const path = require('path');
const { buildInvoicePdf, buildCreditNotePdf, sellerFromEnv } = require('./invoice');
const I = require('./invoicing');
const createPennylane = require('./pennylane');
const { createMailer } = require('./mail');
const createMonthly = require('./monthly');
const SC = require('./siteconfig');
const { buildReportPdf } = require('./reportpdf');
const P = require('./payments');
const accountRouter = require('./account');
const adminRouter = require('./admin');
const AP = require('./adminplus');

const need = (k) => { if (!process.env[k]) throw new Error(`Variable d'environnement manquante : ${k}`); return process.env[k]; };
if (process.env.NODE_ENV === 'production' && process.env.STRIPE_TAX !== '1')
  throw new Error('STRIPE_TAX=1 est obligatoire en production (TVA selon le pays de l\'acheteur).');

const stripe = Stripe(need('STRIPE_SECRET_KEY'));
const supabase = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_KEY'), { auth: { persistSession: false } });
const resend = new Resend(need('RESEND_API_KEY'));
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const APP_URL = need('APP_URL').replace(/\/$/, '');
const FROM = need('FROM_EMAIL');
const mailer = createMailer({ supabase, resend, from: FROM, appUrl: APP_URL, overrides: () => settings.emailOv });
const T = mailer.T;
// Profil de l'exploitant : la console admin le complète ; sans mentions légales complètes, la vente est bloquée (jamais de facture incomplète).
const settings = {
  site: SC.EMPTY(), siteUpdatedAt: null, hasPrevious: false, emailOv: {},
  async load() {
    const { data } = await supabase.from('app_settings').select('key,value,updated_at').in('key', ['seller', 'site', 'site_prev', 'email_ov']);
    const by = Object.fromEntries((data || []).map((r) => [r.key, r]));
    I.setSellerOverride((by.seller && by.seller.value) || {});
    const v = SC.validate(by.site && by.site.value);                              // contenu invalide en base : on retombe sur les valeurs par défaut
    this.site = v.ok ? v.value : SC.EMPTY(); this.siteUpdatedAt = by.site ? by.site.updated_at : null; this.hasPrevious = !!by.site_prev;
    SC.applyPrices(this.site);
    this.emailOv = require('./mail').cleanOv(by.email_ov && by.email_ov.value);
  },
  /** Publie le brouillon du site dont la date de publication est passée (prix déjà confirmés à la planification). */
  async publishDue() {
    const { data: d } = await supabase.from('app_settings').select('value').eq('key', 'site_draft').maybeSingle();
    const dr = d && d.value; if (!dr || !dr.publishAt || Date.parse(dr.publishAt) > Date.now()) return false;
    const v = SC.validate(dr.config);
    await supabase.from('app_settings').delete().eq('key', 'site_draft');
    if (!v.ok) { console.error('Publication planifiée abandonnée : contenu invalide', v.error); return false; }
    const changed = JSON.stringify(SC.effectivePrices(this.site)) !== JSON.stringify(SC.effectivePrices(v.value));
    if (changed && !dr.pricesConfirmed) { console.error('Publication planifiée abandonnée : changement de prix non confirmé'); return false; }
    await this.saveSite(v.value);
    await supabase.from('admin_audit').insert({ action: 'site_publish_scheduled', target: 'site', payload: { publishAt: dr.publishAt }, actor: 'planification' }).then(() => {}, () => {});
    return true;
  },
  /** Enregistre le contenu du site (la version précédente est gardée pour un retour en arrière). */
  async saveSite(cfg) {
    const { data: cur } = await supabase.from('app_settings').select('value').eq('key', 'site').maybeSingle();
    if (cur) await supabase.from('app_settings').upsert({ key: 'site_prev', value: cur.value, updated_at: nowIso() }, { onConflict: 'key' });
    const { error } = await supabase.from('app_settings').upsert({ key: 'site', value: cfg, updated_at: nowIso() }, { onConflict: 'key' });
    if (error) throw error;
    await this.load();
  },
  async restoreSite() {
    const { data: prev } = await supabase.from('app_settings').select('value').eq('key', 'site_prev').maybeSingle();
    if (!prev) return false;
    const { data: cur } = await supabase.from('app_settings').select('value').eq('key', 'site').maybeSingle();
    await supabase.from('app_settings').upsert({ key: 'site', value: prev.value, updated_at: nowIso() }, { onConflict: 'key' });
    if (cur) await supabase.from('app_settings').upsert({ key: 'site_prev', value: cur.value, updated_at: nowIso() }, { onConflict: 'key' });
    await this.load(); return true;
  },
  async save(seller) { const { error } = await supabase.from('app_settings').upsert({ key: 'seller', value: seller, updated_at: nowIso() }, { onConflict: 'key' }); if (error) throw error; I.setSellerOverride(seller); return I.sellerFromEnv(); },
};
const enforceSeller = () => process.env.NODE_ENV === 'production' || process.env.ENFORCE_SELLER === '1';
const sellerIncomplete = () => enforceSeller() && I.sellerMissing(I.sellerFromEnv()).length > 0;
const monthly = createMonthly({ supabase, mailer });
const CGV_VERSION = process.env.CGV_VERSION || 'brouillon';
const MAX_ATTEMPTS = parseInt(process.env.MAX_ATTEMPTS || '3', 10);
// Compteurs anonymes de l'entonnoir (aucune donnée personnelle) : jamais bloquants.
const track = (step, brand) => { try { Promise.resolve(supabase.rpc('bump_funnel', { p_step: step, p_brand: String(brand || '').slice(0, 40) })).then(() => {}, () => {}); } catch (e) { /* statistique facultative */ } };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowIso = () => new Date().toISOString();
const safeEq = (a, b) => { const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || '')); return A.length === B.length && crypto.timingSafeEqual(A, B); };

class GenerationError extends Error {
  constructor(code, msg, refundable) { super(msg || code); this.code = code; this.refundable = !!refundable; }
}

/* ============ Génération du rapport ============ */
async function getCachedVin(vin) {
  const since = new Date(Date.now() - 365 * 864e5).toISOString();
  const { data } = await supabase.from('vin_cache').select('payload,source').eq('vin', vin).gt('fetched_at', since).maybeSingle();
  return data ? { ...data.payload, source: data.source } : null;
}

async function writeExplanation(v) {
  const fallback = { text: lib.templateExplanation(v), ai: false };
  if (!openai || process.env.AI_EXPLANATIONS !== '1') return fallback;
  try {
    const r = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o', temperature: 0,
      messages: [
        { role: 'system', content: 'Tu rédiges en français 2 à 3 phrases neutres expliquant une estimation de prix de véhicule d’occasion. Utilise UNIQUEMENT les chiffres fournis. Ne donne aucun conseil d’achat et ne parle ni d’expertise, ni d’inspection, ni de garantie.' },
        { role: 'user', content: JSON.stringify({ n_annonces: v.n, bas: v.low, median: v.mid, haut: v.high, ajustement_km: v.kmAdj, plus_values_options: v.optionsAdj }) }, // aucune donnée personnelle, pas de VIN
      ],
    }, { timeout: 10000 });
    const text = r.choices[0] && r.choices[0].message && r.choices[0].message.content && r.choices[0].message.content.trim();
    return lib.explanationIsSafe(text, lib.allowedNumbers(v)) ? { text, ai: true } : fallback;
  } catch (e) { console.error('IA indisponible, texte standard utilisé :', e.message); return fallback; }
}

async function curatedLabels(brand) {
  const m = new Map();
  if (!brand) return m;
  const { data } = await supabase.from('option_labels').select('code,label_fr').eq('brand', brand.toUpperCase());
  for (const r of data || []) m.set(`${brand.toUpperCase()}|${r.code}`, r.label_fr);
  return m;
}

async function buildReport(order) {
  const t0 = Date.now();
  const F = R.PLAN_FEATURES[order.plan];
  let decoded = await getCachedVin(order.vin);
  if (!decoded) {
    try { decoded = await decodeVin(order.vin); }
    catch (e) { throw new GenerationError(e.code || 'PROVIDER_FAILED', e.message, e.code === 'NOT_CONFIGURED'); }
    if (lib.countOptions(decoded.options) >= lib.MIN_OPTIONS)
      await supabase.from('vin_cache').upsert({ vin: order.vin, payload: { vehicle: decoded.vehicle, options: decoded.options, tech: decoded.tech, catalogue: decoded.catalogue }, source: decoded.source, fetched_at: nowIso() });
  }
  const raw = lib.normalizeOptions(decoded.options);
  if (raw.length < lib.MIN_OPTIONS)
    throw new GenerationError('INSUFFICIENT_OPTIONS', `${raw.length} option(s) décodée(s)`, true);   // garantie : remboursement automatique

  // Traduction FR : libellé fournisseur FR > libellés validés à la main > glossaire > original (signalé dans le rapport).
  const brand = (decoded.vehicle && decoded.vehicle.make) || lib.brandFromVin(order.vin) || '';
  const curated = await curatedLabels(brand).catch(() => new Map());
  const tr = translateOptions(raw, { brand, curated });
  const catTr = Array.isArray(decoded.catalogue) ? translateOptions(decoded.catalogue, { brand, curated }) : null;
  const toLog = [...tr.untranslated, ...(catTr ? catTr.untranslated : [])];
  if (toLog.length) supabase.rpc('log_untranslated', { p_items: toLog.slice(0, 200) }).then(({ error }) => { if (error) console.error('log_untranslated :', error.message); });

  const [recalls, history] = await Promise.all([F.recalls ? getRecalls(order.vin) : null, F.provenance ? getHistory(order.vin) : null]);

  let valuation = null, inputs = null, explanation = null, ai = false;
  if (F.valuation && (typeof settings.site.valuation === 'boolean' ? settings.site.valuation : process.env.VALUATION_ENABLED === '1')) {      // cotation : désactivée au lancement tant qu'aucun fournisseur de marché n'est branché
    inputs = await getMarketStats(decoded.vehicle, tr.items).catch(() => null);
    valuation = lib.estimateValue(inputs, { presentCodes: tr.items.map((o) => o.code) });
    if (valuation.status === 'ok') ({ text: explanation, ai } = await writeExplanation(valuation));
  }
  const report = R.assembleReport({ plan: order.plan, vin: order.vin, decoded: { ...decoded, options: tr.items, catalogue: catTr ? catTr.items : undefined }, translation: tr, recalls, history, valuation, explanation });
  const { data, error } = await supabase.from('reports').upsert({
    order_id: order.id, user_id: order.user_id, vin: order.vin, plan: order.plan, vehicle: decoded.vehicle, options: tr.items,
    options_count: tr.items.length, valuation, valuation_inputs: inputs, explanation, explanation_ai: ai, data_source: decoded.source,
    report, report_version: R.REPORT_VERSION, generation_ms: Date.now() - t0,
  }, { onConflict: 'order_id' }).select().single();
  if (error) throw error;
  return data;
}

/* ============ Livraison, remboursement ============ */
async function deliver(order, report, opts = {}) {
  const url = `${APP_URL}/report/${report.access_token}`;
  const attachments = [];
  const { data: inv } = await supabase.from('invoices').select('number,amount_ttc_cents').eq('order_id', order.id).maybeSingle();
  try {
    const { data: full } = await supabase.from('reports').select(REPORT_COLS).eq('id', report.id).maybeSingle();
    if (full && full.report) attachments.push({ filename: `Rapport_${order.vin}.pdf`, content: Buffer.from(await buildReportPdf(publicReport(full), sellerFromEnv())) });
  } catch (e) { console.error('PDF du rapport non joint (lien disponible) :', e.message); }
  let balance = null;
  if (order.kind === 'credit_use' && order.user_id) { const { data: u } = await supabase.from('users').select('credits_balance').eq('id', order.user_id).maybeSingle(); balance = u ? u.credits_balance : null; }
  const tpl = T.reportReady({ plan: order.plan, vin: order.vin, url, ttc: inv ? inv.amount_ttc_cents : null, cgv: CGV_VERSION, creditCost: order.kind === 'credit_use' ? -order.credits_delta : null, balance });
  const r = await mailer.send({ key: opts.force ? `ready:${order.id}:resend:${Date.now()}` : `ready:${order.id}`, kind: 'report_ready', to: order.buyer_email, tpl, attachments, userId: order.user_id, maxAttempts: 8 });
  if (r === 'failed') throw new Error('E-mail du rapport non envoyé');
  await supabase.from('orders').update({ status: 'delivered', updated_at: nowIso() }).eq('id', order.id);
}

// Un échec d'email ne déclenche JAMAIS un remboursement : le rapport existe, l'envoi sera retenté.
async function deliverSafe(order, report, opts) {
  try { await deliver(order, report, opts); }
  catch (e) {
    console.error('Email non envoyé (rapport disponible, nouvel essai prévu) :', e.message);
    await supabase.from('orders').update({ email_attempts: (order.email_attempts || 0) + 1, last_error: ('email: ' + e.message).slice(0, 300), updated_at: nowIso() }).eq('id', order.id);
  }
}

/* ============ Remboursements et avoirs ============ */
async function alertAdmin(subject, html) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return console.error('ALERTE ADMIN (ADMIN_EMAIL non configuré) :', subject);
  try { await resend.emails.send({ from: FROM, to: [to], subject: `[EuroVin] ${subject}`, html }); }
  catch (e) { console.error('Alerte admin non envoyée :', e.message); }
}

// Enregistre un remboursement Stripe : avoir numéroté + commande mise à jour + email au client. Rejouable (même remboursement = même avoir).
async function recordRefund(orderId, refund, reason, wantedCredits) {
  const existing = await supabase.from('credit_notes').select('id,number').eq('stripe_refund_id', refund.id).maybeSingle();
  if (existing.data) return { number: existing.data.number, isNew: false };
  const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
  const split = P.splitCreditNote(order, refund.amount);
  let credits = P.creditsToReverse(order, refund.amount);
  if (credits > 0 && order.user_id) {                                  // pack : on ne retire jamais plus que le solde réel
    const { data: u } = await supabase.from('users').select('credits_balance').eq('id', order.user_id).maybeSingle();
    credits = Math.min(credits, u ? u.credits_balance : 0);
    if (wantedCredits != null) credits = Math.min(credits, wantedCredits);
  }
  const { data, error } = await supabase.rpc('issue_credit_note', { p_order: orderId, p_refund: refund.id, p_ttc: split.ttc, p_tax: split.tax, p_reason: reason || 'Remboursement', p_credits: credits });
  if (error) throw error;
  const row = data && data[0];
  if (row && row.is_new) await sendCreditNote(orderId, row.note_number);
  return { number: row && row.note_number, isNew: !!(row && row.is_new) };
}

async function sendCreditNote(orderId, number) {
  try {
    const { data: note } = await supabase.from('credit_notes').select('*').eq('number', number).single();
    const { data: inv } = note.invoice_id ? await supabase.from('invoices').select('number').eq('id', note.invoice_id).maybeSingle() : { data: null };
    await mailer.send({ key: 'note:' + note.number, kind: 'credit_note', to: note.buyer_email, tpl: T.creditNote({ amountCents: note.amount_ttc_cents, number: note.number }),
      attachments: [{ filename: `Avoir_${note.number}.pdf`, content: await buildCreditNotePdf(note, inv, sellerFromEnv()) }] });
  } catch (e) { console.error('Email d’avoir non envoyé :', e.message); }
}

/**
 * Rembourse une commande (automatique ou demandé par l'admin).
 *  - achat par crédits : les crédits sont recrédités (pas d'argent, donc pas d'avoir)
 *  - achat par carte / autre moyen : remboursement Stripe sur le moyen d'origine + avoir
 *  - opts.amountCents : remboursement partiel (centimes TTC) ; opts.strict : erreurs explicites pour l'admin
 */
async function refundOrder(order, reason, opts = {}) {
  const fail = (code, msg) => Object.assign(new Error(msg || code), { code });
  const { data: fresh } = await supabase.from('orders').select('*').eq('id', order.id).single();
  order = fresh || order;
  if (order.kind === 'credit_use') {
    if (order.status === 'refunded') { if (opts.strict) throw fail('NOT_REFUNDABLE', 'Déjà remboursée'); return {}; }
    const { error } = await supabase.rpc('apply_credits', { p_user: order.user_id, p_delta: -order.credits_delta, p_reason: 'refund', p_ref: 'refund:order:' + order.id });
    if (error) throw error;
    await supabase.from('orders').update({ status: 'refunded', last_error: reason, updated_at: nowIso() }).eq('id', order.id);
    await mailRefundNotice(order);
    return { creditsRestored: -order.credits_delta };
  }
  if (!order.stripe_payment_intent) {                                   // commande gratuite (code promo à 100 %) : rien à rembourser
    if (opts.strict) throw fail('NOT_REFUNDABLE', 'Aucun paiement à rembourser');
    await supabase.from('orders').update({ status: 'refunded', last_error: reason, updated_at: nowIso() }).eq('id', order.id);
    await mailRefundNotice(order);
    return {};
  }
  const remaining = (order.amount_ttc_cents || 0) - (order.refunded_cents || 0);
  if (remaining <= 0) { if (opts.strict) throw fail('NOTHING_TO_REFUND', 'Commande déjà intégralement remboursée'); return {}; }
  const amount = opts.amountCents != null ? opts.amountCents : remaining;
  const split = P.splitCreditNote(order, amount);                       // lève AMOUNT_INVALID / EXCEEDS_REMAINING
  if (order.kind === 'pack' && opts.strict) {
    const need = P.creditsToReverse(order, amount);
    const { data: u } = await supabase.from('users').select('credits_balance').eq('id', order.user_id).maybeSingle();
    if (!u || u.credits_balance < need) throw fail('CREDITS_ALREADY_USED', `Il faut retirer ${need} crédit(s) mais le solde est insuffisant`);
  }
  const refund = await stripe.refunds.create({ payment_intent: order.stripe_payment_intent, amount: split.ttc, metadata: { order_id: order.id, reason: String(reason).slice(0, 100) } },
    { idempotencyKey: `refund:${order.id}:${order.refunded_cents || 0}:${split.ttc}` });
  await supabase.from('orders').update({ last_error: String(reason).slice(0, 300) }).eq('id', order.id);
  const out = await recordRefund(order.id, refund, reason);
  return { refundId: refund.id, amountCents: split.ttc, creditNote: out.number };
}
async function mailRefundNotice(order) {
  const tpl = order.kind === 'credit_use' ? T.creditRefund({ plan: order.plan, vin: order.vin, credits: -order.credits_delta }) : T.refundNoPayment();
  await mailer.send({ key: 'refund:' + order.id, kind: 'refund_notice', to: order.buyer_email, tpl, userId: order.user_id });
}

async function runOrder(id) {
  const { data, error } = await supabase.rpc('claim_order', { p_id: id });   // prise en charge atomique : un seul traitement à la fois
  if (error) throw error;
  const order = data && data[0];
  if (!order) return;
  let report;
  try { report = await buildReport(order); }
  catch (e) {
    console.error(`Commande ${id}, tentative ${order.attempts} :`, e.code || '', e.message);
    if (e.refundable || order.attempts >= MAX_ATTEMPTS) {
      try { await refundOrder(order, e.code || 'GENERATION_FAILED'); return; }
      catch (re) { console.error('REMBOURSEMENT AUTOMATIQUE EN ÉCHEC :', re.message); alertAdmin('Remboursement automatique en échec', `<p>Commande ${order.id} : ${esc(re.message)}</p>`); return; }
    }
    await supabase.from('orders').update({ status: 'pending', last_error: String(e.message).slice(0, 300), updated_at: nowIso() }).eq('id', id);
    return;
  }
  await supabase.from('orders').update({ status: 'ready', last_error: null, updated_at: nowIso() }).eq('id', id);
  await deliverSafe(order, report);
}
// Alerte Pro : solde faible (une seule fois par niveau de solde).
async function lowCreditsCheck(user) {
  const { data: u } = await supabase.from('users').select('credits_balance').eq('id', user.id).maybeSingle();
  const lim = parseInt(process.env.LOW_CREDITS_THRESHOLD || '2', 10);
  if (u && u.credits_balance <= lim) await mailer.send({ key: `low:${user.id}:${u.credits_balance}`, kind: 'low_credits', to: user.email, tpl: T.lowCredits({ balance: u.credits_balance }), userId: user.id });
}
const runLater = (id) => setImmediate(() => runOrder(id).catch((e) => console.error('runOrder :', e.message)));

/* ============ Paiement (Stripe) ============ */
async function authUser(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return null;
  const { data, error } = await supabase.auth.getUser(t);   // identité tirée du jeton, jamais du corps de la requête
  return error ? null : data.user;
}

async function getOrCreateCustomer(user) {
  const { data: u } = await supabase.from('users').select('stripe_customer_id').eq('id', user.id).maybeSingle();
  if (u && u.stripe_customer_id) return u.stripe_customer_id;
  const c = await stripe.customers.create({ email: user.email, metadata: { user_id: user.id } }, { idempotencyKey: 'customer:' + user.id });
  await supabase.from('users').update({ stripe_customer_id: c.id }).eq('id', user.id);
  return c.id;
}

// Frais réels prélevés par Stripe (pour la marge réelle). Facultatif : une erreur ou une absence de donnée (paiement SEPA différé) ne bloque jamais la commande.
async function captureStripeFee(s) {
  try {
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent && s.payment_intent.id;
    if (!pi || !stripe.paymentIntents || !stripe.paymentIntents.retrieve) return;
    const p = await stripe.paymentIntents.retrieve(pi, { expand: ['latest_charge.balance_transaction'] });
    const bt = p && p.latest_charge && p.latest_charge.balance_transaction;
    if (!bt || !Number.isInteger(bt.fee) || bt.fee < 0) return;
    await supabase.from('orders').update({ stripe_fee_cents: bt.fee }).eq('stripe_payment_intent', pi);
  } catch (e) { console.error('Frais Stripe :', e.message); }
}
async function recordPayment(s) {
  const m = s.metadata || {};
  const email = ((s.customer_details && s.customer_details.email) || s.customer_email || '').toLowerCase();
  if (!email) throw new Error('Email client absent');
  let vin = null, plan = null, credits = null, desc;
  if (m.kind === 'report') {
    const v = lib.checkVin(m.vin);
    if (!v.ok || !has(lib.PRICES_TTC_CENTS, m.plan)) throw new Error('Métadonnées de rapport invalides');
    vin = v.vin; plan = m.plan; desc = `Rapport ${plan === 'premium' ? 'Premium' : 'Essentiel'} — VIN ${vin}`;
  } else if (m.kind === 'pack') {
    if (!has(lib.PACKS_HT_CENTS, m.pack_size) || !m.user_id) throw new Error('Métadonnées de pack invalides');
    credits = parseInt(m.pack_size, 10); desc = `Pack ${credits} crédits`;
  } else throw new Error('Type de commande inconnu');
  const taxId = s.customer_details && s.customer_details.tax_ids && s.customer_details.tax_ids[0];
  const { data, error } = await supabase.rpc('record_payment', {
    p_session: s.id, p_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null,
    p_kind: m.kind, p_email: email, p_user: m.user_id || null, p_vin: vin, p_plan: plan, p_credits: credits,
    p_ttc: s.amount_total || 0, p_tax: (s.total_details && s.total_details.amount_tax) || 0,
    p_consent: { cgv_version: m.cgv_version, waiver: m.waiver === '1', at: m.consent_at }, p_buyer_vat: taxId ? taxId.value : null, p_description: desc,
  });
  if (error) throw error;
  const row = data && data[0];
  // Mentions légales de la facture (acheteur, TVA, lignes, copie du vendeur) : rejouable sans effet ; en cas d'échec on lève → Stripe réessaie.
  if (row) { await storeInvoiceDetails(row.order_id, s, m, desc, row.is_new); await mailPayment(row.order_id, s, m, email, credits); }
  return row && row.is_new && m.kind === 'report' ? row.order_id : null;
}
// Confirmation de paiement + facture en pièce jointe (dédoublonnée : un paiement rejoué ne renvoie rien).
async function mailPayment(orderId, s, m, email, credits) {
  try {
    const { data: inv } = await supabase.from('invoices').select('*').eq('order_id', orderId).maybeSingle();
    const attachments = inv ? [{ filename: `Facture_${inv.number}.pdf`, content: await buildInvoicePdf(inv, inv.seller || sellerFromEnv()) }] : [];
    let tpl;
    if (m.kind === 'pack') {
      const { data: u } = await supabase.from('users').select('credits_balance').eq('id', m.user_id).maybeSingle();
      tpl = T.packPaid({ credits, balance: u ? u.credits_balance : null, ttc: s.amount_total || 0, invoiceNumber: inv && inv.number, company: m.company_name });
    } else tpl = T.reportPaid({ plan: m.plan, vin: m.vin, ttc: s.amount_total || 0, invoiceNumber: inv && inv.number, cgv: m.cgv_version || CGV_VERSION });
    await mailer.send({ key: 'paid:' + s.id, kind: m.kind === 'pack' ? 'pack_paid' : 'report_paid', to: email, tpl, attachments, userId: m.user_id || null });
  } catch (e) { console.error('E-mail de confirmation non envoyé :', e.message); }
}
async function storeInvoiceDetails(orderId, s, m, desc, isNew) {
  if (!isNew) {                                                    // rejeu : on ne complète que si un incident a interrompu l'écriture initiale
    const { data: cur } = await supabase.from('invoices').select('buyer_type').eq('order_id', orderId).maybeSingle();
    if (cur && cur.buyer_type) return;
  }
  const paidIso = s.created ? new Date(s.created * 1000).toISOString() : nowIso();
  const d = I.buildInvoiceDetails({ s, m, seller: I.sellerFromEnv(), paidAtIso: paidIso, description: desc });
  const miss = I.missingBuyerFields(d);
  const { error } = await supabase.from('invoices').update({ ...d, details_complete: miss.length === 0 }).eq('order_id', orderId);
  if (error) throw error;
  if (miss.length) {
    alertAdmin('Facture professionnelle incomplète', `<p>Commande ${esc(orderId)} : il manque ${esc(miss.join(', '))}. À compléter avec le client avant transmission à son comptable.</p>`);
    const { data: inv } = await supabase.from('invoices').select('number,buyer_email').eq('order_id', orderId).maybeSingle();
    if (inv) mailer.send({ key: 'invoice_incomplete:' + inv.number, kind: 'invoice_incomplete', to: inv.buyer_email, tpl: T.incompleteInvoice({ number: inv.number, missing: miss }) });
  }
  if (typeof accountingKick === 'function') accountingKick();
}

const pennylane = createPennylane({ supabase, buildInvoicePdf, buildCreditNotePdf, nowIso });
// Synchronisation comptable en tâche de fond : jamais bloquante pour la commande ; le cron rattrape ce qui échoue.
const accountingKick = () => setImmediate(() => pennylane.syncPending(5).catch((e) => console.error('Pennylane :', e.message)));

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: { useDefaults: true, directives: {
  'script-src': ["'self'"], 'script-src-attr': ["'unsafe-inline'"],          // gestionnaires onclick du site ; tout contenu dynamique est échappé
  'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], 'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:'], 'connect-src': ["'self'", process.env.SUPABASE_URL || "'self'"], 'frame-ancestors': ["'none'"], 'form-action': ["'self'", 'https://checkout.stripe.com'],
} } }));
const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false });

// Événements Stripe : chaque traitement est rejouable sans effet (paiement, avoir, litige).
async function handleStripeEvent(event) {
  const o = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const free = o.payment_status === 'no_payment_required' && o.amount_total === 0;   // code promo à 100 %
      if (o.payment_status !== 'paid' && !free) return null;                           // SEPA, virement… : on attend « async_payment_succeeded »
      const run = await recordPayment(o); await captureStripeFee(o);
      return { run };
    }
    case 'checkout.session.expired': {                                                 // paiement commencé puis abandonné : statistique « ce qui ne se vend pas » (sans donnée personnelle)
      const m = o.metadata || {}, size = parseInt(m.pack_size, 10);
      if (m.kind === 'report' && has(lib.PRICES_TTC_CENTS, m.plan)) await supabase.from('abandoned_checkouts').upsert({ session_id: o.id, kind: 'report', plan: m.plan, created_at: nowIso() }, { onConflict: 'session_id', ignoreDuplicates: true });
      else if (m.kind === 'pack' && has(lib.PACKS_HT_CENTS, size)) await supabase.from('abandoned_checkouts').upsert({ session_id: o.id, kind: 'pack', pack_size: size, created_at: nowIso() }, { onConflict: 'session_id', ignoreDuplicates: true });
      await supabase.from('abandoned_checkouts').delete().lt('created_at', new Date(Date.now() - 400 * 864e5).toISOString()).then(() => {}, () => {});
      return null;
    }
    case 'checkout.session.async_payment_failed': {
      const to = (o.customer_details && o.customer_details.email) || o.customer_email;
      if (to) await mailer.send({ key: 'payfail:' + o.id, kind: 'payment_failed', to, tpl: T.paymentFailed() });
      return null;
    }
    case 'refund.created': case 'refund.updated': {                                     // remboursement fait aussi depuis le Dashboard Stripe
      if (!['succeeded', 'pending', 'requires_action'].includes(o.status) || !o.payment_intent) return null;
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent.id;
      const { data: order } = await supabase.from('orders').select('id').eq('stripe_payment_intent', pi).maybeSingle();
      if (!order) return null;
      await recordRefund(order.id, o, (o.metadata && o.metadata.reason) || 'Remboursement effectué depuis Stripe');
      return null;
    }
    case 'refund.failed':
      await alertAdmin('Remboursement refusé par la banque', `<p>Refund ${esc(o.id)} (${(o.amount / 100).toFixed(2)} €) : ${esc(o.failure_reason || 'raison inconnue')}. À traiter manuellement.</p>`);
      return null;
    case 'charge.dispute.created': case 'charge.dispute.updated': case 'charge.dispute.closed': {
      const pi = typeof o.payment_intent === 'string' ? o.payment_intent : o.payment_intent && o.payment_intent.id;
      if (pi) await supabase.from('orders').update({ dispute_status: o.status, dispute_id: o.id, updated_at: nowIso() }).eq('stripe_payment_intent', pi);
      if (event.type !== 'charge.dispute.updated')
        await alertAdmin(`Litige bancaire (${o.status})`, `<p>Litige ${esc(o.id)}, ${(o.amount / 100).toFixed(2)} €, motif : ${esc(o.reason)}. ${o.evidence_details && o.evidence_details.due_by ? 'Réponse à fournir avant le ' + new Date(o.evidence_details.due_by * 1000).toLocaleDateString('fr-FR') + ' dans le Dashboard Stripe.' : ''}</p>`);
      return null;
    }
    default: return null;
  }
}

// Webhook : corps brut obligatoire (avant tout express.json) ; en cas d'erreur Stripe réessaie automatiquement.
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], need('STRIPE_WEBHOOK_SECRET')); }
  catch (e) { return res.status(400).send('Signature invalide'); }
  try {
    const seen = await supabase.from('stripe_events').select('id').eq('id', event.id).maybeSingle();
    if (seen.data) return res.json({ received: true, duplicate: true });
    const out = await handleStripeEvent(event);
    await supabase.from('stripe_events').upsert({ id: event.id, type: event.type }, { onConflict: 'id', ignoreDuplicates: true });
    res.json({ received: true });
    if (out && out.run) runLater(out.run);
  } catch (e) { console.error('Webhook Stripe :', event.type, e.message); res.status(500).json({ error: 'retry' }); }
});

app.post('/api/checkout', limiter, express.json({ limit: '10kb' }), async (req, res, next) => {
  try {
    if (settings.site.maintenance && settings.site.maintenance.enabled) return res.status(503).json({ error: 'MAINTENANCE', message: settings.site.maintenance.message || null });
    if (sellerIncomplete()) return res.status(503).json({ error: 'SELLER_INCOMPLETE' });
    const v = lib.validateCheckoutBody(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const b = v.value;
    let user = null;
    if (req.headers.authorization) { user = await authUser(req); if (!user) return res.status(401).json({ error: 'Session invalide.' }); }
    const meta = { kind: b.kind, user_id: user ? user.id : '', cgv_version: CGV_VERSION, waiver: b.kind === 'report' ? '1' : '0', consent_at: nowIso() };
    if (b.kind === 'report') { meta.vin = b.vin; meta.plan = b.plan; }
    else {
      if (!user) return res.status(401).json({ error: 'Connexion requise pour acheter des crédits.' });
      // Une facture professionnelle exige la raison sociale et le SIRET de l'acheteur (TVA récupérable par son comptable).
      const { data: prof } = await supabase.from('users').select('company_name,company_siret,company_vat').eq('id', user.id).maybeSingle();
      if (!prof || !String(prof.company_name || '').trim() || !P.validSiret(prof.company_siret)) return res.status(400).json({ error: 'COMPANY_REQUIRED' });
      meta.pack_size = String(b.packSize);
      meta.company_name = String(prof.company_name).trim().slice(0, 160);
      meta.company_siret = String(prof.company_siret).replace(/\s/g, '');
      if (prof.company_vat) meta.company_vat = String(prof.company_vat).trim().slice(0, 30);
    }
    const customerId = user ? await getOrCreateCustomer(user) : null;
    const params = P.buildCheckoutParams({ body: b, user, customerId, meta, appUrl: APP_URL, taxOn: process.env.STRIPE_TAX === '1' });
    const session = await stripe.checkout.sessions.create(params);
    track(b.kind === 'report' ? 'checkout' : 'checkout_pack', b.kind === 'report' ? lib.brandFromVin(b.vin) : '');
    res.json({ url: session.url });
  } catch (e) { next(e); }
});

/* ============ Rapports et crédits ============ */
// Consommation de crédits (professionnels). L'utilisateur vient du jeton ; la clé d'idempotence évite le double débit.
app.post('/api/reports', limiter, express.json({ limit: '10kb' }), async (req, res, next) => {
  try {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });
    const v = lib.checkVin(req.body && req.body.vin);
    const plan = req.body && req.body.plan;
    const idem = String(req.headers['idempotency-key'] || '').slice(0, 80);
    if (!v.ok) return res.status(400).json({ error: 'VIN_INVALID' });
    if (typeof plan !== 'string' || !has(lib.CREDIT_COST, plan)) return res.status(400).json({ error: 'PLAN_INVALID' });
    if (!idem) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
    const cost = lib.CREDIT_COST[plan];
    const ins = await supabase.from('orders').insert({ kind: 'credit_use', status: 'pending', user_id: user.id, buyer_email: user.email, vin: v.vin, plan, credits_delta: -cost, idempotency_key: idem }).select().single();
    if (ins.error) {
      if (ins.error.code === '23505') {                          // même clé d'idempotence : requête déjà reçue
        const { data: ex } = await supabase.from('orders').select('id,status').eq('user_id', user.id).eq('idempotency_key', idem).single();
        return res.status(200).json({ orderId: ex.id, status: ex.status, duplicate: true });
      }
      throw ins.error;
    }
    const order = ins.data;
    const { error } = await supabase.rpc('apply_credits', { p_user: user.id, p_delta: -cost, p_reason: 'report', p_ref: 'order:' + order.id });
    if (error) {
      await supabase.from('orders').delete().eq('id', order.id);
      if (error.code === '23514') return res.status(402).json({ error: 'Solde de crédits insuffisant.' });
      throw error;
    }
    res.status(202).json({ orderId: order.id, status: 'pending' });
    lowCreditsCheck(user).catch(() => {});
    runLater(order.id);
  } catch (e) { next(e); }
});

app.get('/api/orders/:id', limiter, async (req, res, next) => {
  try {
    const user = await authUser(req);
    if (!user) return res.status(401).json({ error: 'Non authentifié.' });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
    const { data: o } = await supabase.from('orders').select('id,status').eq('id', req.params.id).eq('user_id', user.id).maybeSingle();
    if (!o) return res.status(404).json({ error: 'Introuvable.' });
    let token = null;
    if (o.status === 'ready' || o.status === 'delivered') { const { data: r } = await supabase.from('reports').select('access_token').eq('order_id', o.id).maybeSingle(); token = r && r.access_token; }
    res.json({ status: o.status, reportToken: token });
  } catch (e) { next(e); }
});

// Lecture d'un rapport par lien secret : on ne renvoie jamais les données brutes du fournisseur ni l'identité de l'acheteur.
const TOKEN = /^[a-f0-9]{48}$/;
const REPORT_COLS = 'id,vin,plan,vehicle,options,options_count,valuation,explanation,explanation_ai,data_source,report,report_version,generation_ms,created_at,expires_at';
const publicReport = (r) => ({
  reference: 'RP-' + String(r.id).replace(/-/g, '').slice(0, 8).toUpperCase(), createdAt: r.created_at, expiresAt: r.expires_at, generationMs: r.generation_ms || null,
  report: r.report || null,                                                  // rapports d'avant la v2 : report = null (le site affiche la version simple)
  legacy: r.report ? null : { vin: r.vin, plan: r.plan, vehicle: r.vehicle, options: r.options, valuation: r.valuation, explanation: r.explanation },
});
app.get('/api/reports/:token', limiter, async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    const { data: r } = await supabase.from('reports').select(REPORT_COLS).eq('access_token', req.params.token).gt('expires_at', nowIso()).maybeSingle();
    if (!r) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    track('opened', lib.brandFromVin(r.vin));
    res.set('Cache-Control', 'no-store').json(publicReport(r));
  } catch (e) { next(e); }
});

app.get('/api/reports/:token/pdf', limiter, async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    const { data: r } = await supabase.from('reports').select(REPORT_COLS).eq('access_token', req.params.token).gt('expires_at', nowIso()).maybeSingle();
    if (!r || !r.report) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    const pdf = await buildReportPdf(publicReport(r), sellerFromEnv());
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="Rapport_${r.vin}.pdf"`, 'Cache-Control': 'no-store' }).send(Buffer.from(pdf));
  } catch (e) { next(e); }
});


// Page vendeur : lien public SÉPARÉ du lien de l'acheteur, activé/révoqué par le détenteur du rapport.
// Contenu volontairement restreint : VIN masqué (6 derniers caractères), ni cotation, ni comparatif, ni identité de l'acheteur.
const maskVin = (v) => String(v || '').slice(0, 11) + '••••••';
const sellerView = (r) => { const x = r.report || {};
  return { public: true, reference: null, createdAt: r.created_at, expiresAt: r.expires_at, generationMs: null, legacy: null,
    report: { version: x.version, plan: x.plan, vin: maskVin(r.vin), generatedAt: x.generatedAt, vehicle: x.vehicle, options: x.options, techSheet: x.techSheet, recalls: x.recalls || null, provenance: x.provenance || null, comparison: null, valuation: null, explanation: null, notices: [], sources: x.sources || [] } }; };
const sellerState = async (token) => {
  const { data: r, error } = await supabase.from('reports').select('id,public_token,public_at,expires_at,report').eq('access_token', token).gt('expires_at', nowIso()).maybeSingle();
  if (error) return { unavailable: true };
  return { r };
};
app.get('/api/reports/:token/public', limiter, async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    const s = await sellerState(req.params.token); if (s.unavailable) return res.json({ available: false });
    if (!s.r || !s.r.report) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    res.set('Cache-Control', 'no-store').json({ available: true, active: !!s.r.public_token, token: s.r.public_token || null, until: s.r.public_token ? s.r.expires_at : null });
  } catch (e) { next(e); }
});
app.post('/api/reports/:token/public', limiter, express.json({ limit: '1kb' }), async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    const b = req.body || {}; if (typeof b.on !== 'boolean') return res.status(400).json({ error: 'BAD_REQUEST' });
    const s = await sellerState(req.params.token); if (s.unavailable) return res.status(503).json({ error: 'FEATURE_OFF' });
    if (!s.r || !s.r.report) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    const tok = b.on ? (s.r.public_token || crypto.randomBytes(24).toString('hex')) : null;
    const { error } = await supabase.from('reports').update({ public_token: tok, public_at: b.on ? (s.r.public_at || nowIso()) : null }).eq('id', s.r.id);
    if (error) return res.status(503).json({ error: 'FEATURE_OFF' });
    res.set('Cache-Control', 'no-store').json({ available: true, active: b.on, token: tok, until: b.on ? s.r.expires_at : null });
  } catch (e) { next(e); }
});
app.get('/api/public/:ptoken', limiter, async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.ptoken)) return res.status(404).json({ error: 'Introuvable.' });
    const { data: r, error } = await supabase.from('reports').select('id,vin,created_at,expires_at,report').eq('public_token', req.params.ptoken).gt('expires_at', nowIso()).maybeSingle();
    if (error || !r || !r.report) return res.status(404).json({ error: 'Introuvable, retiré par son auteur ou expiré.' });
    track('opened', lib.brandFromVin(r.vin));
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).json(sellerView(r));
  } catch (e) { next(e); }
});

// Rapport d'exemple public : données fictives, aucun fournisseur, aucun coût.
app.get('/api/sample-report', limiter, (_req, res) => res.set('Cache-Control', 'public, max-age=300').json(require('./sample').sampleReport()));

// Aperçu gratuit avant achat : lit la marque dans le VIN (préfixe constructeur), n'appelle AUCUN fournisseur payant.
app.post('/api/preview', limiter, express.json({ limit: '1kb' }), (req, res) => {
  const v = lib.checkVin(req.body && req.body.vin);
  if (!v.ok) return res.status(400).json({ error: v.reason === 'NON_EU' ? 'VIN_NON_EU' : 'VIN_INVALID', reason: v.reason });
  track('lookup', lib.brandFromVin(v.vin));
  res.json({ vin: v.vin, brand: lib.brandFromVin(v.vin), ...lib.vinFacts(v.vin) });
});

// Suivi d'une commande payée (page « merci ») : l'identifiant de session Stripe est secret et non devinable.
app.get('/api/checkout/status', limiter, async (req, res, next) => {
  try {
    const sid = String(req.query.session_id || '');
    if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) return res.status(400).json({ error: 'SESSION_INVALID' });
    const { data: o } = await supabase.from('orders').select('id,kind,status,plan').eq('stripe_session_id', sid).maybeSingle();
    if (!o) return res.set('Cache-Control', 'no-store').json({ status: 'waiting_payment' });   // le webhook n'est pas encore arrivé
    let token = null;
    if (o.kind === 'report' && (o.status === 'ready' || o.status === 'delivered')) {
      const { data: r } = await supabase.from('reports').select('access_token').eq('order_id', o.id).maybeSingle(); token = r && r.access_token;
    }
    res.set('Cache-Control', 'no-store').json({ status: o.status, kind: o.kind, plan: o.plan, reportToken: token });
  } catch (e) { next(e); }
});

// Recalcul de la cotation selon le kilométrage : déterministe, sans IA.
app.post('/api/reports/:token/valuation', limiter, express.json({ limit: '2kb' }), async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    const km = Number(req.body && req.body.km);
    if (!Number.isFinite(km) || km < 0 || km > 1_000_000) return res.status(400).json({ error: 'KM_INVALID' });
    const { data: r } = await supabase.from('reports').select('plan,options,valuation_inputs').eq('access_token', req.params.token).gt('expires_at', nowIso()).maybeSingle();
    if (!r || r.plan !== 'premium') return res.status(404).json({ error: 'Introuvable.' });
    res.json(lib.estimateValue(r.valuation_inputs, { km, presentCodes: (r.options || []).map((o) => o.code) }));
  } catch (e) { next(e); }
});

/* ============ Relances (service) ============ */
async function sweepReminders(ago) {
  // 1. Commande en retard (> 15 min sans rapport) : on prévient le client une seule fois.
  const { data: late } = await supabase.from('orders').select('id,vin,buyer_email,user_id,status').eq('kind', 'report').in('status', ['pending', 'generating']).lt('created_at', ago(15 * 60e3)).limit(50);
  for (const o of late || []) await mailer.send({ key: 'delay:' + o.id, kind: 'delay_notice', to: o.buyer_email, tpl: T.delayNotice({ vin: o.vin }), userId: o.user_id });
  // 2. Rapport qui va être supprimé (conservation 12 mois) : rappel 7 jours avant.
  const in7 = new Date(Date.now() + 7 * 864e5).toISOString();
  const { data: exp } = await supabase.from('reports').select('id,order_id,vin,access_token,expires_at').gt('expires_at', nowIso()).lt('expires_at', in7).limit(50);
  for (const r of exp || []) {
    const { data: o } = await supabase.from('orders').select('buyer_email,user_id').eq('id', r.order_id).maybeSingle();
    if (o && o.buyer_email) await mailer.send({ key: 'expiry:' + r.id, kind: 'report_expiring', to: o.buyer_email, tpl: T.reportExpiring({ vin: r.vin, url: `${APP_URL}/report/${r.access_token}`, days: Math.max(1, Math.ceil((Date.parse(r.expires_at) - Date.now()) / 864e5)) }), userId: o.user_id });
  }
}

/* ============ Alerte rappel (opt-in) ============ */
const recallEnabled = () => process.env.RECALL_ALERTS === '1' && !!process.env.RECALL_ORDER;     // désactivée tant que vous ne l'activez pas : chaque contrôle coûte un appel au fournisseur
const recallId = (x) => String((x && x.ref) || (((x && x.title) || '') + '|' + ((x && x.date) || ''))).slice(0, 200);
async function sweepRecallWatches() {
  if (!recallEnabled()) return;
  const now = nowIso();
  await supabase.from('recall_watches').update({ active: false, stopped_at: now, stopped_reason: 'expired' }).eq('active', true).lt('expires_at', now);
  const days = Math.max(1, parseInt(process.env.RECALL_INTERVAL_DAYS || '7', 10)), batch = Math.max(1, Math.min(200, parseInt(process.env.RECALL_BATCH || '25', 10)));
  const cutoff = new Date(Date.now() - days * 864e5).toISOString(), retry = () => new Date(Date.now() - (days - 1) * 864e5).toISOString();
  const [a, b] = await Promise.all([
    supabase.from('recall_watches').select('*').eq('active', true).is('last_checked_at', null).limit(batch),
    supabase.from('recall_watches').select('*').eq('active', true).lt('last_checked_at', cutoff).order('last_checked_at', { ascending: true }).limit(batch),
  ]);
  for (const w of [...(a.data || []), ...(b.data || [])].slice(0, batch)) {
    let r = null; try { r = await getRecalls(w.vin); } catch (e) { console.error('Alerte rappel :', e.message); }
    if (!r || r.status !== 'ok' || !Array.isArray(r.items)) { await supabase.from('recall_watches').update({ last_checked_at: retry() }).eq('id', w.id); continue; }   // source indisponible : nouvel essai dans 1 jour, aucune alerte
    const items = r.items.filter((x) => x && typeof x === 'object'), ids = items.map(recallId), known = Array.isArray(w.known_refs) ? w.known_refs : null;
    const fresh = known ? items.filter((_, i) => !known.includes(ids[i])) : [];
    const patch = { last_checked_at: nowIso() };
    if (!known) patch.known_refs = ids;                                   // première lecture : on mémorise l'existant, sans alerte
    else if (fresh.length) {
      const stopUrl = `${APP_URL}/rappels/arret?t=${w.token}`;
      const { data: rep } = w.report_id ? await supabase.from('reports').select('access_token,expires_at').eq('id', w.report_id).maybeSingle() : { data: null };
      const reportUrl = rep && rep.access_token && Date.parse(rep.expires_at) > Date.now() ? `${APP_URL}/report/${rep.access_token}` : APP_URL;
      const key = 'recall:' + w.id + ':' + crypto.createHash('sha1').update(fresh.map(recallId).sort().join('|')).digest('hex').slice(0, 12);
      const st = await mailer.send({ key, kind: 'recall_alert', to: w.email, userId: w.user_id, headers: { 'List-Unsubscribe': `<${stopUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tpl: T.recallAlert({ vin: w.vin, items: fresh.map((x) => ({ ref: String(x.ref || '').slice(0, 40), date: R.fmtDate(x.date), title: String(x.title || '').slice(0, 300) })), reportUrl, stopUrl, source: r.source, asOf: r.asOf }) });
      if (st === 'failed') patch.last_checked_at = retry();               // e-mail non parti : on réessaie demain, sans oublier la campagne
      else { patch.known_refs = [...new Set([...known, ...ids])]; if (st === 'sent') { patch.last_alert_at = nowIso(); patch.alerts_sent = (w.alerts_sent || 0) + 1; } }
    }
    await supabase.from('recall_watches').update(patch).eq('id', w.id);
  }
}

/* ============ Tâche planifiée (cron) ============ */
app.post('/api/jobs/sweep', async (req, res, next) => {
  try {
    if (!safeEq(req.headers['x-cron-secret'], need('CRON_SECRET'))) return res.status(401).end();
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    await supabase.from('orders').update({ status: 'pending', updated_at: nowIso() }).eq('status', 'generating').lt('updated_at', ago(10 * 60e3));
    const { data: pend } = await supabase.from('orders').select('id').eq('status', 'pending').lt('updated_at', ago(2 * 60e3)).limit(20);
    for (const o of pend || []) await runOrder(o.id).catch((e) => console.error('sweep run :', e.message));
    const { data: rdy } = await supabase.from('orders').select('*').eq('status', 'ready').lt('email_attempts', 5).lt('updated_at', ago(2 * 60e3)).limit(20);
    for (const o of rdy || []) { const { data: rep } = await supabase.from('reports').select('*').eq('order_id', o.id).maybeSingle(); if (rep) await deliverSafe(o, rep); }
    await pennylane.syncPending(20).catch((e) => console.error('Pennylane :', e.message));
    await sweepReminders(ago).catch((e) => console.error('Relances :', e.message));
    await sweepRecallWatches().catch((e) => console.error('Alertes rappel :', e.message));
    await supabase.from('funnel_daily').delete().lt('day', new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10)).then(() => {}, () => {});
    await monthly.sweepMonthly().catch((e) => console.error('Export mensuel :', e.message));
    await settings.publishDue().catch((e) => console.error('Publication planifiée :', e.message));
    await AP.sendDigest({ supabase, mailer }).catch((e) => console.error('Résumé admin :', e.message));
    await supabase.from('reports').delete().lt('expires_at', nowIso());                 // purge à expiration (RGPD)
    await supabase.from('vin_cache').delete().lt('fetched_at', ago(365 * 864e5));
    res.json({ ok: true });
  } catch (e) { next(e); }
});

const adminLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false });
/* ============ Marketing : désabonnement (lien dans les e-mails) et retours Brevo ============ */
async function setMarketing(where, on, source) {
  const col = where.token ? 'unsub_token' : 'email';
  const { data: u } = await supabase.from('users').select('id,email,marketing_consent').eq(col, where.token || where.email).maybeSingle();
  if (!u) return null;
  if (!!u.marketing_consent === on) return u;
  const patch = on ? { marketing_consent: true, marketing_consent_at: nowIso(), marketing_consent_source: source, marketing_unsub_at: null } : { marketing_consent: false, marketing_unsub_at: nowIso() };
  await supabase.from('users').update(patch).eq('id', u.id);
  await supabase.from('consent_events').insert({ user_id: u.id, email: u.email, action: on ? 'grant' : 'withdraw', source });
  return u;
}
const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, '$1•••$2');
const page = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head><body style="font-family:Arial,sans-serif;max-width:480px;margin:60px auto;padding:0 16px;color:#1b1f24"><h2>${esc(title)}</h2>${body}<p><a href="${APP_URL}">Retour au site</a></p></body></html>`;
app.get('/desabonnement', limiter, async (req, res) => {          // GET : aucun effet (les antivirus de messagerie ouvrent les liens) ; l'action est un POST
  const t = String(req.query.t || '');
  const { data: u } = /^[a-f0-9]{32,64}$/.test(t) ? await supabase.from('users').select('email').eq('unsub_token', t).maybeSingle() : { data: null };
  res.set('Cache-Control', 'no-store').type('html').send(u
    ? page('Se désabonner des actualités', `<p>Confirmez le désabonnement de <b>${esc(maskEmail(u.email))}</b> de nos e-mails d’actualités. Vous continuerez à recevoir les e-mails liés à vos commandes et à votre compte.</p><form method="post" action="/desabonnement?t=${esc(t)}"><button type="submit" style="padding:12px 24px;background:#0b57d0;color:#fff;border:0;border-radius:6px;font-size:16px;cursor:pointer">Me désabonner</button></form>`)
    : page('Lien invalide', '<p>Ce lien de désabonnement n’est pas valide. Vous pouvez aussi vous désabonner depuis Mon espace › Informations.</p>'));
});
app.post('/desabonnement', limiter, express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {   // POST : aussi le « désabonnement en un clic » des clients de messagerie
  try {
    const t = String(req.query.t || '');
    const u = /^[a-f0-9]{32,64}$/.test(t) ? await setMarketing({ token: t }, false, 'unsubscribe_link') : null;
    res.status(u ? 200 : 404).set('Cache-Control', 'no-store').type('html').send(u ? page('Désabonnement confirmé', '<p>Vous ne recevrez plus nos actualités. Les e-mails liés à vos commandes et à votre compte continuent.</p>') : page('Lien invalide', '<p>Ce lien n’est pas valide.</p>'));
  } catch (e) { next(e); }
});
// Retours de désabonnement / rebond de Brevo (secret partagé dans l'en-tête x-webhook-secret).
app.post('/api/webhooks/brevo', express.json({ limit: '20kb' }), async (req, res, next) => {
  try {
    if (!process.env.BREVO_WEBHOOK_SECRET || !safeEq(req.headers['x-webhook-secret'], process.env.BREVO_WEBHOOK_SECRET)) return res.status(401).end();
    const b = req.body || {}, ev = String(b.event || '').toLowerCase(), email = String(b.email || '').trim().toLowerCase();
    if (email && ['unsubscribe', 'unsubscribed', 'hard_bounce', 'hardbounce', 'spam', 'complaint', 'blocked'].includes(ev)) await setMarketing({ email }, false, 'brevo');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ============ Alerte rappel : activation depuis le rapport et arrêt en un clic ============ */
async function recallCtx(token) {
  const { data: r } = await supabase.from('reports').select('id,vin,order_id').eq('access_token', token).gt('expires_at', nowIso()).maybeSingle();
  if (!r) return null;
  const { data: o } = await supabase.from('orders').select('buyer_email,user_id').eq('id', r.order_id).maybeSingle();
  return o && o.buyer_email ? { reportId: r.id, vin: r.vin, email: String(o.buyer_email).trim().toLowerCase(), userId: o.user_id || null } : null;
}
app.get('/api/reports/:token/recall-watch', limiter, async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    if (!recallEnabled()) return res.set('Cache-Control', 'no-store').json({ available: false });
    const c = await recallCtx(req.params.token); if (!c) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    const { data: w } = await supabase.from('recall_watches').select('active,expires_at').eq('vin', c.vin).eq('email', c.email).maybeSingle();
    res.set('Cache-Control', 'no-store').json({ available: true, active: !!(w && w.active), until: w && w.active ? w.expires_at : null });
  } catch (e) { next(e); }
});
app.post('/api/reports/:token/recall-watch', limiter, express.json({ limit: '1kb' }), async (req, res, next) => {
  try {
    if (!TOKEN.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
    if (!recallEnabled()) return res.status(404).json({ error: 'FEATURE_OFF' });
    const c = await recallCtx(req.params.token); if (!c) return res.status(404).json({ error: 'Introuvable ou expiré.' });
    const b = req.body || {}, now = nowIso();
    const { data: w } = await supabase.from('recall_watches').select('*').eq('vin', c.vin).eq('email', c.email).maybeSingle();
    if (b.on === false) {
      if (w && w.active) await supabase.from('recall_watches').update({ active: false, stopped_at: now, stopped_reason: 'user' }).eq('id', w.id);
      return res.json({ active: false });
    }
    if (b.on !== true) return res.status(400).json({ error: 'BAD_REQUEST' });
    if (b.consent !== true) return res.status(400).json({ error: 'CONSENT_REQUIRED' });
    const until = new Date(Date.now() + Math.max(1, parseInt(process.env.RECALL_WATCH_MONTHS || '24', 10)) * 30.44 * 864e5).toISOString();
    if (w) {
      const stale = !w.active;                                           // réactivation : on relit l'existant sans alerter
      await supabase.from('recall_watches').update({ active: true, consent_at: now, expires_at: until, stopped_at: null, stopped_reason: null, report_id: c.reportId, ...(stale ? { known_refs: null, last_checked_at: null } : {}) }).eq('id', w.id);
    } else {
      const { count } = await supabase.from('recall_watches').select('id', { count: 'exact', head: true }).eq('email', c.email).eq('active', true);
      if ((count || 0) >= 50) return res.status(429).json({ error: 'LIMIT' });
      const ins = await supabase.from('recall_watches').insert({ vin: c.vin, email: c.email, user_id: c.userId, report_id: c.reportId, token: crypto.randomBytes(24).toString('hex'), known_refs: null, active: true, consent_at: now, expires_at: until });
      if (ins && ins.error && ins.error.code !== '23505') throw new Error(ins.error.message);
    }
    res.json({ active: true, until });
  } catch (e) { next(e); }
});
const stopRecall = async (t) => /^[a-f0-9]{48}$/.test(t || '') ? supabase.from('recall_watches').select('id,vin,active').eq('token', t).maybeSingle().then(({ data }) => data) : null;
app.get('/rappels/arret', limiter, async (req, res, next) => {              // GET : aucun effet (les antivirus de messagerie ouvrent les liens)
  try {
    const t = String(req.query.t || ''), w = await stopRecall(t);
    res.set('Cache-Control', 'no-store').type('html').send(w
      ? page('Désactiver l’alerte rappel', `<p>Confirmez la désactivation de l’alerte rappel pour le VIN <b>${esc(w.vin)}</b>.</p><form method="post" action="/rappels/arret"><input type="hidden" name="t" value="${esc(t)}"><button class="b" type="submit">Désactiver l’alerte</button></form>`)
      : page('Lien invalide', '<p>Ce lien n’est pas valide. Vous pouvez aussi désactiver l’alerte depuis la page de votre rapport.</p>'));
  } catch (e) { next(e); }
});
app.post('/rappels/arret', limiter, express.urlencoded({ extended: false, limit: '2kb' }), async (req, res, next) => {   // POST : aussi le « un clic » des clients de messagerie (jeton dans l'URL)
  try {
    const t = String((req.body && req.body.t) || req.query.t || ''), w = await stopRecall(t);
    if (w && w.active) await supabase.from('recall_watches').update({ active: false, stopped_at: nowIso(), stopped_reason: 'user' }).eq('id', w.id);
    res.set('Cache-Control', 'no-store').type('html').send(w ? page('Alerte désactivée', `<p>L’alerte rappel pour le VIN <b>${esc(w.vin)}</b> est désactivée. Vous ne recevrez plus d’e-mail à ce sujet.</p>`) : page('Lien invalide', '<p>Ce lien n’est pas valide.</p>'));
  } catch (e) { next(e); }
});

settings.load().catch((e) => console.error('Paramètres non chargés :', e.message));
setInterval(() => settings.publishDue().catch(() => {}).then(() => settings.load()).catch(() => {}), 60_000).unref();

const deps = { supabase, stripe, authUser, limiter, adminLimiter, appUrl: APP_URL, nowIso, buildInvoicePdf, buildCreditNotePdf, sellerFromEnv, alertAdmin, pennylane, mailer, settings, sellerIncomplete, monthly, setMarketing, getOrCreateCustomer, refundOrder, runOrder, deliverSafe };
app.use(accountRouter(deps));
app.use(adminRouter(deps));

// Contenu public du site (bandeau, maintenance, prix, textes, FAQ) : aucune donnée sensible.
app.get('/api/site', async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  if (req.query && req.query.preview) {                                  // aperçu du brouillon : lien signé, 30 minutes, jamais indexé
    try {
      if (AP.verifyPreview(process.env, String(req.query.preview))) {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'site_draft').maybeSingle();
        const v = data && SC.validate(data.value && data.value.config);
        if (v && v.ok) { res.set('X-Robots-Tag', 'noindex'); return res.json({ ...SC.publicView(v.value, null), preview: true }); }
      }
    } catch (e) { /* retombe sur la version publiée */ }
  }
  res.json(SC.publicView(settings.site, settings.siteUpdatedAt));
});

/* ============ Site (fichiers statiques + pages à adresse propre) ============ */
const SITE = path.join(__dirname, 'site');
// Configuration publique du navigateur : uniquement des valeurs faites pour être publiques (clé « anon », jamais la clé service).
app.get('/config.js', (_req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache')
  .send('window.EV_CONFIG=' + JSON.stringify({ supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '', supportEmail: process.env.SUPPORT_EMAIL || '' }).replace(/</g, '\\u003c') + ';'));
// Service worker : jamais mis en cache par le navigateur (sinon une mise à jour du site pourrait rester bloquée).
app.get('/sw.js', (_req, res) => res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).sendFile(path.join(SITE, 'sw.js')));
app.use(express.static(SITE, { index: false, maxAge: '1h' }));
// Console d'administration : page statique (inutilisable sans la clé ADMIN_API_KEY), jamais indexée ni mise en cache.
app.get(/^\/admin\/?$/, (req, res) => {
  const allow = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (allow.length && !allow.includes(req.ip)) return res.status(404).end();
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }).sendFile(path.join(SITE, 'admin.html'));
});
const PAGES = /^\/(?:report\/[a-f0-9]{48}|commande\/succes|exemple|rapport\/[a-f0-9]{48}|compte|mon-espace|pro|cgv|confidentialite|mentions-legales|aide|a-propos)?\/?$/;
const BP = require('./brandpages');
let INDEX_RAW = null;
const indexHtml = () => { if (!INDEX_RAW) INDEX_RAW = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8'); return INDEX_RAW.split('{{APP_URL}}').join(APP_URL); };
app.get(PAGES, (req, res) => res.set('Cache-Control', 'no-cache').set(/^\/rapport\//.test(req.path) ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}).type('html').send(indexHtml()));
app.get('/marques', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').type('html').send(BP.renderIndex(APP_URL)));
app.get('/options/:slug', (req, res) => { const h = BP.renderBrand(APP_URL, req.params.slug); if (!h) return res.status(404).type('html').send(indexHtml()); res.set('Cache-Control', 'public, max-age=3600').type('html').send(h); });
app.get('/sitemap.xml', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').type('application/xml').send(BP.sitemap(APP_URL)));
app.get('/robots.txt', (_req, res) => res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(BP.robots(APP_URL)));

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Erreur interne.' }); });   // pas de détails techniques au client
process.on('unhandledRejection', (e) => console.error('unhandledRejection :', e));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur actif sur le port ${PORT}`));
