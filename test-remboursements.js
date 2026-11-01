'use strict';
// Simulation du flux de remboursement avec de faux Supabase / Stripe / Resend (aucun réseau).
const Module = require('module'), assert = require('assert');
const db = { orders: [], credit_notes: [], users: [], invoices: [], ledger: [] };
const sent = [], refunds = []; let deps;
let nid = 0;
const chain = (table, rows) => {
  let f = rows.slice(), upd = null, ins = null;
  const q = { select: () => q, eq: (k, v) => { f = f.filter((r) => r[k] === v); return q; }, in: () => q, gt: () => q, lt: () => q, order: () => q, limit: () => q,
    maybeSingle: async () => ({ data: f[0] || null }), single: async () => ({ data: f[0] || null, error: f[0] ? null : { message: 'none' } }),
    update: (v) => { upd = v; return q; }, then: (res) => { if (upd) f.forEach((r) => Object.assign(r, upd)); res({ data: f, error: null }); } };
  return q;
};
const supabase = {
  from: (t) => chain(t, db[t === 'credit_notes' ? 'credit_notes' : t] || []),
  rpc: async (name, a) => {
    if (name === 'issue_credit_note') {
      const o = db.orders.find((x) => x.id === a.p_order);
      const ex = db.credit_notes.find((n) => n.stripe_refund_id === a.p_refund); if (ex) return { data: [{ note_id: ex.id, note_number: ex.number, is_new: false }] };
      if (o.refunded_cents + a.p_ttc > o.amount_ttc_cents) return { error: { message: 'EXCEEDS_REMAINING' } };
      const n = { id: 'n' + (++nid), number: 'AV-2026-00000' + nid, order_id: o.id, stripe_refund_id: a.p_refund, buyer_email: o.buyer_email, amount_ttc_cents: a.p_ttc, amount_tax_cents: a.p_tax, amount_ht_cents: a.p_ttc - a.p_tax, issued_at: new Date().toISOString(), reason: a.p_reason };
      db.credit_notes.push(n); o.refunded_cents += a.p_ttc; o.refunded_tax_cents += a.p_tax; o.credits_reversed += a.p_credits;
      if (o.refunded_cents >= o.amount_ttc_cents) o.status = 'refunded';
      if (a.p_credits > 0) db.users.find((u) => u.id === o.user_id).credits_balance -= a.p_credits;
      return { data: [{ note_id: n.id, note_number: n.number, is_new: true }] };
    }
    if (name === 'apply_credits') { const u = db.users.find((x) => x.id === a.p_user); u.credits_balance += a.p_delta; return { data: u.credits_balance }; }
    return { data: null };
  },
};
const fakes = {
  express: Object.assign(() => ({ set() {}, use() {}, get() {}, post() {}, listen() {} }), { json: () => 0, urlencoded: () => 0, raw: () => 0, static: () => 0, Router: () => ({ use() {}, get() {}, post() {}, patch() {}, delete() {} }) }),
  helmet: () => 0, 'express-rate-limit': () => 0, openai: function () {},
  stripe: () => ({ refunds: { create: async (p, o) => { const r = { id: 're_' + (refunds.length + 1), amount: p.amount, payment_intent: p.payment_intent, status: 'succeeded' }; refunds.push(r); return r; } }, webhooks: {} }),
  '@supabase/supabase-js': { createClient: () => supabase },
  resend: { Resend: function () { this.emails = { send: async (m) => { sent.push(m); } }; } },
  pdfkit: function () {},
};
const orig = Module._load;
Module._load = function (req, ...r) {
  if (req === './account') return (d) => { deps = d; return { stack: [] }; };
  if (req === './admin') return () => ({ stack: [] });
  if (req === './invoice') return { buildInvoicePdf: async () => Buffer.from('pdf'), buildCreditNotePdf: async () => Buffer.from('pdf'), sellerFromEnv: () => ({}) };
  if (fakes[req]) return fakes[req];
  return orig.call(this, req, ...r);
};
Object.assign(process.env, { STRIPE_SECRET_KEY: 'sk', SUPABASE_URL: 'http://x', SUPABASE_SERVICE_KEY: 'k', RESEND_API_KEY: 'r', APP_URL: 'https://x.fr', FROM_EMAIL: 'a@x.fr', PORT: '0' });
require('./server.js');
const mk = (o) => { const x = { id: 'o' + (db.orders.length + 1), buyer_email: 'c@x.fr', refunded_cents: 0, refunded_tax_cents: 0, credits_reversed: 0, status: 'pending', stripe_payment_intent: 'pi_' + db.orders.length, ...o }; db.orders.push(x); return x; };
(async () => {
  let o = mk({ kind: 'report', amount_ttc_cents: 1299, amount_tax_cents: 217 });
  let r = await deps.refundOrder(o, 'INSUFFICIENT_OPTIONS');
  assert.strictEqual(r.amountCents, 1299); assert.strictEqual(o.status, 'refunded'); assert.strictEqual(db.credit_notes.length, 1); assert.strictEqual(db.credit_notes[0].amount_tax_cents, 217);
  assert.ok(sent.some((m) => /avoir/i.test(m.subject)), 'email avoir'); assert.strictEqual(sent[0].attachments.length, 1);
  console.log('1 remboursement auto total : OK');
  await assert.rejects(deps.refundOrder(o, 'x', { strict: true }), (e) => e.code === 'NOTHING_TO_REFUND'); console.log('2 double remboursement refusé : OK');
  o = mk({ kind: 'report', amount_ttc_cents: 1299, amount_tax_cents: 217 });
  await deps.refundOrder(o, 'geste', { amountCents: 500, strict: true }); assert.strictEqual(o.status, 'pending'); assert.strictEqual(o.refunded_cents, 500);
  await assert.rejects(deps.refundOrder(o, 'x', { amountCents: 900, strict: true }), (e) => e.code === 'EXCEEDS_REMAINING');
  await deps.refundOrder(o, 'solde'); assert.strictEqual(o.refunded_cents, 1299); assert.strictEqual(o.status, 'refunded');
  assert.strictEqual(db.credit_notes.filter((n) => n.order_id === o.id).reduce((a, n) => a + n.amount_tax_cents, 0), 217); console.log('3 partiel puis solde (TVA exacte) : OK');
  db.users.push({ id: 'u1', credits_balance: 30 });
  let p = mk({ kind: 'pack', user_id: 'u1', credits_delta: 30, amount_ttc_cents: 15480, amount_tax_cents: 2580 });
  await deps.refundOrder(p, 'rétractation', { strict: true }); assert.strictEqual(db.users[0].credits_balance, 0); assert.strictEqual(p.credits_reversed, 30); console.log('4 pack remboursé : crédits retirés : OK');
  db.users[0].credits_balance = 5;
  p = mk({ kind: 'pack', user_id: 'u1', credits_delta: 30, amount_ttc_cents: 15480, amount_tax_cents: 2580 });
  const before = refunds.length;
  await assert.rejects(deps.refundOrder(p, 'x', { strict: true }), (e) => e.code === 'CREDITS_ALREADY_USED'); assert.strictEqual(refunds.length, before, 'aucun remboursement Stripe');
  console.log('5 pack déjà consommé : refus avant Stripe : OK');
  const c = mk({ kind: 'credit_use', user_id: 'u1', credits_delta: -2, status: 'generating', stripe_payment_intent: null }); db.users[0].credits_balance = 3;
  await deps.refundOrder(c, 'GENERATION_FAILED'); assert.strictEqual(db.users[0].credits_balance, 5); assert.strictEqual(c.status, 'refunded'); 
  await deps.refundOrder(c, 'again'); assert.strictEqual(db.users[0].credits_balance, 5); console.log('6 achat par crédits recrédité une seule fois : OK');
  const free = mk({ kind: 'report', amount_ttc_cents: 0, amount_tax_cents: 0, stripe_payment_intent: null });
  await deps.refundOrder(free, 'x'); assert.strictEqual(free.status, 'refunded'); console.log('7 commande gratuite (promo 100 %) : OK');
  process.exit(0);
})().catch((e) => { console.error('ÉCHEC :', e); process.exit(1); });
