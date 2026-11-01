'use strict';
/**
 * DÉMONSTRATION UNIQUEMENT. Remplace l'API /api/admin/* par des données fictives, dans la page d'administration intégrée au prototype.
 * Le mot de passe n'est qu'un garde-fou de démonstration (il est lisible dans ce fichier) : il ne protège rien.
 * Les modifications du contenu du site passent par la VRAIE validation (siteconfig.js) puis sont envoyées au site de démonstration.
 */
(function () {
  const PASSWORD = 'demo-admin', SC = window.SC;
  const now = Date.now(), day = 864e5, iso = (d, h = 10) => new Date(now - d * day - (24 - h) * 36e5 / 4).toISOString();
  const rid = () => Math.random().toString(16).slice(2, 10) + '-demo';
  let seq = 6;
  const audit = [];
  const log = (action, target) => audit.unshift({ created_at: new Date().toISOString(), actor: window.__actor || 'demo', action, target: String(target || '') });

  // ---- données fictives ----
  const orders = [
    { id: 'a1b2c3d4-0001', kind: 'report', plan: 'premium', vin: 'WBA8E9C50GK123456', buyer_email: 'alice.martin@exemple.fr', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, status: 'delivered', created_at: iso(0.2), stripe_payment_intent: 'pi_demo_1' },
    { id: 'a1b2c3d4-0002', kind: 'pack', credits: 30, vin: null, buyer_email: 'achats@garage-dupont.fr', amount_ttc_cents: 15480, amount_tax_cents: 2580, refunded_cents: 0, status: 'delivered', created_at: iso(1), stripe_payment_intent: 'pi_demo_2' },
    { id: 'a1b2c3d4-0003', kind: 'report', plan: 'essentiel', vin: 'WVWZZZ1KZAW123456', buyer_email: 'paul.durand@exemple.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 0, status: 'delivered', created_at: iso(2), stripe_payment_intent: 'pi_demo_3' },
    { id: 'a1b2c3d4-0004', kind: 'credit_use', plan: 'premium', vin: 'WBAJC51050CK12345', buyer_email: 'achats@garage-dupont.fr', amount_ttc_cents: null, refunded_cents: 0, status: 'delivered', created_at: iso(2.5), credits: -2 },
    { id: 'a1b2c3d4-0005', kind: 'report', plan: 'premium', vin: 'TMBJG7NE5J0123456', buyer_email: 'sophie.l@exemple.fr', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 1299, status: 'refunded', created_at: iso(4), stripe_payment_intent: 'pi_demo_5', last_error: 'Moins de 10 options décodées' },
    { id: 'a1b2c3d4-0006', kind: 'pack', credits: 10, buyer_email: 'info@autohandel-berlin.de', amount_ttc_cents: 4900, amount_tax_cents: 0, refunded_cents: 0, status: 'delivered', created_at: iso(5), stripe_payment_intent: 'pi_demo_6' },
    { id: 'a1b2c3d4-0007', kind: 'report', plan: 'essentiel', vin: 'VSSZZZ5FZGR123456', buyer_email: 'marc.h@exemple.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 0, status: 'delivered', created_at: iso(6), stripe_payment_intent: 'pi_demo_7' },
    { id: 'a1b2c3d4-0008', kind: 'report', plan: 'premium', vin: 'WAUZZZF21JN123456', buyer_email: 'lea.b@exemple.fr', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, status: 'delivered', created_at: iso(8), stripe_payment_intent: 'pi_demo_8' },
    { id: 'a1b2c3d4-0009', kind: 'report', plan: 'essentiel', vin: 'WBA8E9C50GK654321', buyer_email: 'nicolas.p@exemple.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 0, status: 'generating', created_at: iso(0.01), stripe_payment_intent: 'pi_demo_9', last_error: 'Fournisseur lent, nouvel essai prévu' },
    { id: 'a1b2c3d4-0010', kind: 'pack', credits: 100, buyer_email: 'direction@concession-moreau.fr', amount_ttc_cents: 45480, amount_tax_cents: 7580, refunded_cents: 0, status: 'delivered', created_at: iso(12), stripe_payment_intent: 'pi_demo_10' },
    { id: 'a1b2c3d4-0011', kind: 'report', plan: 'premium', vin: 'WVWZZZAUZHW123456', buyer_email: 'camille.r@exemple.fr', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, status: 'delivered', created_at: iso(15), stripe_payment_intent: 'pi_demo_11' },
    { id: 'a1b2c3d4-0012', kind: 'report', plan: 'essentiel', vin: 'WBA8E9C50GK777777', buyer_email: 'julien.g@exemple.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 0, status: 'delivered', created_at: iso(20), stripe_payment_intent: 'pi_demo_12' },
  ];
  const invDefs = { '0001': ['EV-2026-000041', 'particulier', 'synced'], '0002': ['EV-2026-000040', 'professionnel', 'pending'], '0003': ['EV-2026-000039', 'particulier', 'synced'], '0005': ['EV-2026-000037', 'particulier', 'synced'],
    '0006': ['EV-2026-000036', 'professionnel', 'needs_review', 'TVA à valider (régime autoliquidation, taux 0 %, pays DE)'], '0007': ['EV-2026-000035', 'particulier', 'synced'], '0008': ['EV-2026-000034', 'particulier', 'error', 'Pennylane POST /customer_invoices/import → 500 (démonstration)'],
    '0010': ['EV-2026-000030', 'professionnel', 'pending'], '0011': ['EV-2026-000028', 'particulier', 'synced'], '0012': ['EV-2026-000024', 'particulier', 'synced'] };
  const names = { '0002': 'Garage Dupont SARL', '0006': 'Autohandel Berlin GmbH', '0010': 'Concession Moreau SAS' };
  const invoices = Object.entries(invDefs).map(([k, v]) => { const o = orders.find((x) => x.id.endsWith(k)); return { id: 'inv-' + k, order_id: o.id, number: v[0], issued_at: o.created_at, buyer_email: o.buyer_email, buyer_name: names[k] || null, buyer_type: v[1], details_complete: true, amount_ttc_cents: o.amount_ttc_cents, accounting_status: v[2], accounting_error: v[3] || null }; });
  const creditNotes = [{ number: 'AV-2026-000002', order_id: 'a1b2c3d4-0005', amount_ttc_cents: 1299 }];
  const users = {
    'alice.martin@exemple.fr': { id: 'u1', role: 'b2c', credits_balance: 0, created_at: iso(30), phone: '0612345678' },
    'achats@garage-dupont.fr': { id: 'u2', role: 'pro', credits_balance: 28, created_at: iso(60), phone: '0478000000', company_name: 'Garage Dupont SARL', company_siret: '73282932000074', company_vat: 'FR40732829320' },
    'direction@concession-moreau.fr': { id: 'u3', role: 'pro', credits_balance: 100, created_at: iso(90), company_name: 'Concession Moreau SAS', company_siret: '73282932000074' },
    'paul.durand@exemple.fr': { id: 'u4', role: 'b2c', credits_balance: 0, created_at: iso(10) },
  };
  let tickets = [
    { id: 'tk-1111-aaaa', status: 'open', created_at: iso(0.3), email: 'nicolas.p@exemple.fr', vin: 'WBA8E9C50GK654321', subject: 'Rapport', message: 'Bonjour, mon rapport met longtemps à arriver, pouvez-vous vérifier ma commande ?' },
    { id: 'tk-2222-bbbb', status: 'open', created_at: iso(1.2), email: 'lea.b@exemple.fr', vin: null, subject: 'Facture', message: 'Je souhaiterais une facture au nom de ma société, comment faire ?' },
    { id: 'tk-3333-cccc', status: 'closed', created_at: iso(9), email: 'marc.h@exemple.fr', vin: null, subject: 'Mon compte', message: 'Comment supprimer mon compte ?' },
  ];
  let rerrors = [{ id: 're-1', created_at: iso(2), report_id: 'r1234567-aaaa', error_type: 'Option mal traduite', details: 'Le code 6AC est traduit « Régulateur » alors que c’est un pack éclairage.' }, { id: 're-2', created_at: iso(5), report_id: 'r7654321-bbbb', error_type: 'Donnée manquante', details: 'Le kilométrage de l’historique est absent.' }];
  let labels = [{ brand: 'BMW', code: '6AC', label: 'Fahrerassistenz Plus', seen_count: 9 }, { brand: 'VOLKSWAGEN', code: 'PR-3FA', label: 'Interieurpaket Chrom', seen_count: 4 }, { brand: 'SKODA', code: 'PA3', label: 'Kamera Paket', seen_count: 2 }];
  const emails = [
    { created_at: iso(0.2), kind: 'report_ready', to_email: 'alice.martin@exemple.fr', subject: 'Votre rapport EuroVin est prêt', attempts: 1, status: 'sent' },
    { created_at: iso(1), kind: 'pack_paid', to_email: 'achats@garage-dupont.fr', subject: 'Votre pack de 30 crédits', attempts: 1, status: 'sent' },
    { created_at: iso(2.6), kind: 'welcome', to_email: 'paul.durand@exemple.fr', subject: 'Bienvenue sur EuroVin', attempts: 1, status: 'sent' },
    { created_at: iso(4), kind: 'credit_note', to_email: 'sophie.l@exemple.fr', subject: 'Votre remboursement et avoir', attempts: 3, status: 'failed', error: 'Boîte de réception pleine (démonstration)' },
    { created_at: iso(0.02), kind: 'report_paid', to_email: 'nicolas.p@exemple.fr', subject: 'Paiement reçu', attempts: 1, status: 'sending' },
  ];
  let seller = { name: 'EuroVin (démonstration)', legalForm: 'SAS', capital: '1 000 €', siren: '732829320', rcs: 'RCS Lyon 732 829 320', address: '1 rue d’exemple, 69001 Lyon', vat: 'FR40732829320', email: 'contact@exemple.fr', franchise: false };
  const validSiren = (s) => { if (!/^\d{9}$/.test(s)) return false; let t = 0; for (let i = 0; i < 9; i++) { let d = +s[i]; if (i % 2) { d *= 2; if (d > 9) d -= 9; } t += d; } return t % 10 === 0; };
  let cfg = SC.EMPTY(), prev = null, updatedAt = null;

  // ---- nouveautés : équipe, promo, coûts, modèles d'e-mails, brouillon ----
  const ACCOUNTS = [
    { id: 'tm-1', email: 'proprietaire@exemple.fr', name: 'Victor', role: 'owner', totpEnabled: false, mustChange: false, active: true, lastLoginAt: iso(0.1), locked: false },
    { id: 'tm-2', email: 'lecteur@exemple.fr', name: 'Léa', role: 'viewer', totpEnabled: false, mustChange: false, active: true, lastLoginAt: iso(3), locked: false },
    { id: 'tm-3', email: 'compta@exemple.fr', name: 'Cabinet Martin', role: 'accountant', totpEnabled: true, mustChange: false, active: true, lastLoginAt: iso(6), locked: false },
  ];
  const DEMO_CODE = '123456';
  let promos = [{ id: 'promo_demo1', code: 'BIENVENUE10', active: true, percentOff: 10, amountOffCents: null, maxRedemptions: 50, timesRedeemed: 7, expiresAt: new Date(now + 40 * day).toISOString(), createdAt: iso(20) },
    { id: 'promo_demo2', code: 'GARAGE5', active: false, percentOff: null, amountOffCents: 500, maxRedemptions: null, timesRedeemed: 12, expiresAt: null, createdAt: iso(50) }];
  let costs = { essentiel_cents: 150, premium_cents: 320, stripe_pct: 1.5, stripe_fixed_cents: 25 };
  const notes = {};
  let goalCents = 80000;
  const goalView = () => { const cur = ymd0(now).slice(0, 7), d0 = Number(ymd0(now).slice(8, 10)), dim = new Date(Date.UTC(+cur.slice(0, 4), +cur.slice(5, 7), 0)).getUTCDate();
    const done = orders.filter((o) => paid(o) && ymd0(Date.parse(o.created_at)).slice(0, 7) === cur).reduce((a, o) => a + o.amount_ttc_cents - (o.refunded_cents || 0) - Math.round((o.amount_tax_cents || 0) * (1 - (o.refunded_cents || 0) / o.amount_ttc_cents)), 0), proj = Math.round(done / d0 * dim);
    return { month: cur, target_ht_cents: goalCents, done_ht_cents: done, pct: goalCents ? done / goalCents : null, day: d0, daysInMonth: dim, projected_ht_cents: proj, onTrack: goalCents ? proj >= goalCents : null }; };
  const EXP_CATS = { donnees: 'Données véhicule', outils: 'Outils et logiciels', hebergement: 'Hébergement et e-mails', publicite: 'Publicité', autre: 'Autre' };
  let expenses = [{ id: 'ex-1', date: ymd0(now - 3 * day), label: 'Fournisseur de données — septembre', category: 'donnees', amount_ht_cents: 4200 }, { id: 'ex-2', date: ymd0(now - 10 * day), label: 'Hébergement et e-mails', category: 'hebergement', amount_ht_cents: 1900 }];
  function ymd0(t) { return new Date(t).toISOString().slice(0, 10); }
  const TPL = { welcome: 'Bienvenue', report_paid: 'Paiement reçu (rapport)', report_ready: 'Rapport prêt', pack_paid: 'Pack de crédits acheté', credit_note: 'Remboursement et avoir', ticket_reply: 'Réponse du support', report_failed: 'Rapport non généré', password_reset: 'Réinitialisation du mot de passe' };
  const TPL_SUB = { welcome: 'Bienvenue sur EuroVin', report_paid: 'Paiement reçu', report_ready: 'Votre rapport EuroVin est prêt', pack_paid: 'Votre pack de crédits', credit_note: 'Votre remboursement et avoir', ticket_reply: 'Réponse à votre message', report_failed: 'Votre rapport n’a pas pu être généré', password_reset: 'Réinitialisation de votre mot de passe' };
  let emailOv = {};
  let draft = null;
  const SESS = {};   // jeton de démonstration -> compte
  const H = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const paid = (o) => o.kind !== 'credit_use' && !['pending', 'failed'].includes(o.status) && o.amount_ttc_cents != null;
  const ymd = (t) => new Date(t).toISOString().slice(0, 10);
  function charts(days) {
    const byDay = new Map(); for (let i = days - 1; i >= 0; i--) { const d = ymd(now - i * day); byDay.set(d, { date: d, net_ttc_cents: 0, net_ht_cents: 0, orders: 0 }); }
    const plans = { essentiel: 0, premium: 0 }, kinds = { report: 0, pack: 0, credit_use: 0 }; let net = 0, netHt = 0, nPaid = 0, nRef = 0;
    for (const o of orders) { const t = Date.parse(o.created_at); if (t < now - days * day) continue; if (o.kind === 'credit_use') { kinds.credit_use++; continue; } if (!paid(o)) continue;
      const row = byDay.get(ymd(t)); const v = o.amount_ttc_cents - (o.refunded_cents || 0), vh = Math.round(v - (o.amount_tax_cents || 0) * v / o.amount_ttc_cents); if (row) { row.net_ttc_cents += v; row.net_ht_cents += vh; row.orders++; } net += v; netHt += vh; nPaid++; if (o.refunded_cents) nRef++; kinds[o.kind]++; if (o.kind === 'report' && plans[o.plan] != null) plans[o.plan]++; }
    return { days, series: Array.from(byDay.values()), plans, kinds, paidOrders: nPaid, refundedOrders: nRef, refundRate: nPaid ? nRef / nPaid : 0, net_ttc_cents: net, net_ht_cents: netHt };
  }
  function margin(days) {
    const rows = orders.filter((o) => Date.parse(o.created_at) >= now - days * day && paid(o)), n = { essentiel: 0, premium: 0 };
    let ttc = 0, tax = 0, fees = 0;
    for (const o of rows) { const k = 1 - (o.refunded_cents || 0) / o.amount_ttc_cents; ttc += o.amount_ttc_cents * k; tax += (o.amount_tax_cents || 0) * k; fees += costs.stripe_fixed_cents + o.amount_ttc_cents * costs.stripe_pct / 100; if (o.kind === 'report' && n[o.plan] != null) n[o.plan]++; }
    const ht = Math.round(ttc - tax), dc = n.essentiel * costs.essentiel_cents + n.premium * costs.premium_cents, f = Math.round(fees);
    const from = ymd0(now - (days - 1) * day), to = ymd0(now), byCat = {}; let exp = 0;
    for (const e of expenses) if (e.date >= from && e.date <= to) { exp += e.amount_ht_cents; byCat[e.category] = (byCat[e.category] || 0) + e.amount_ht_cents; }
    const known = rows.filter((o, i) => i % 2 === 0), feeK = known.reduce((a, o) => a + Math.round(o.amount_ttc_cents * 0.0145) + 25, 0), feeE = rows.filter((o, i) => i % 2 === 1).reduce((a, o) => a + Math.round(o.amount_ttc_cents * costs.stripe_pct / 100) + costs.stripe_fixed_cents, 0);
    const real = { revenue_ht_cents: ht, tax_cents: Math.round(tax), stripe_fees_cents: feeK + feeE, stripe_fees_actual_cents: feeK, stripe_fees_estimated_cents: feeE, paying_orders: rows.length, orders_with_actual_fee: known.length, expenses_cents: exp, by_category: byCat, margin_cents: ht - feeK - feeE - exp, marginRate: ht > 0 ? (ht - feeK - feeE - exp) / ht : null, complete: known.length === rows.length, from, to };
    return { revenue_ht_cents: ht, tax_cents: Math.round(tax), data_cost_cents: dc, fees_cents: f, margin_cents: ht - dc - f, reports: n, paidOrders: rows.length, marginRate: ht > 0 ? (ht - dc - f) / ht : null, costs, estimate: true, real };
  }
  const quality = () => ({ brands: [{ brand: 'BMW', orders: 5, ok: 4, failed: 1, failureRate: 0.2, avgOptions: 138 }, { brand: 'VOLKSWAGEN', orders: 3, ok: 3, failed: 0, failureRate: 0, avgOptions: 96 }, { brand: 'SKODA', orders: 2, ok: 1, failed: 1, failureRate: 0.5, avgOptions: 71 }, { brand: 'AUDI', orders: 1, ok: 1, failed: 0, failureRate: 0, avgOptions: 120 }],
    sources: [{ source: 'Fournisseur A (démo)', reports: 9, avgOptions: 118 }, { source: 'Fournisseur B (démo)', reports: 2, avgOptions: 64 }] });
  const mailPrev = (key, o) => { const sub = (o && o.subject ? o.subject : TPL_SUB[key]).replace(/\{marque\}/g, 'EuroVin'); const intro = o && o.intro ? String(o.intro).split(/\n\s*\n/).map((x) => '<p>' + H(x) + '</p>').join('') : '';
    return { subject: sub, html: '<!doctype html><meta charset="utf-8"><body style="font-family:Arial,sans-serif;max-width:560px;margin:20px auto;color:#1d1d1f"><h2>EuroVin</h2>' + intro + '<p>Bonjour,</p><p>(Contenu de l’e-mail « ' + H(TPL[key]) + ' » — exemple fictif : les informations de commande, de facture et les mentions légales restent inchangées.)</p><p style="color:#86868b;font-size:12px">EuroVin · e-mail de service</p></body>' }; };
  const cleanOv = (b) => { const t = (v, n) => String(v == null ? '' : v).trim().slice(0, n); const subject = t(b && b.subject, 150), intro = t(b && b.intro, 1200); return subject || intro ? { ...(subject ? { subject } : {}), ...(intro ? { intro } : {}) } : null; };
  const ROLES = ['owner', 'viewer', 'accountant'];
  const tempPw = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; let r = ''; for (let i = 0; i < 16; i++) r += a[Math.floor(Math.random() * a.length)]; return r; };

  const view = () => ({ config: cfg, defaults: { prices: SC.DEFAULT_PRICES }, pageKeys: SC.PAGE_KEYS, hasPrevious: !!prev, updatedAt, valuationEnv: true });
  const pushSite = () => { try { parent.postMessage({ type: 'ev-site', site: SC.publicView(cfg, updatedAt) }, '*'); } catch (e) { /* hors intégration */ } };
  const sellerMissing = () => ['name', 'legalForm', 'siren', 'address', 'email'].filter((k) => !seller[k]).map((k) => 'SELLER_' + k.toUpperCase()).concat(!seller.franchise && !seller.vat ? ['SELLER_VAT'] : []);

  const J = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const csv = (rows) => new Response(new Blob(['﻿' + rows.map((r) => r.join(';')).join('\r\n')], { type: 'text/csv' }), { status: 200 });
  const eur = (c) => (c / 100).toFixed(2).replace('.', ',');

  let SELF = null, ROLE = 'owner', VIA = 'key';
  const pubU = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, totpEnabled: !!u.totpEnabled, mustChange: !!u.mustChange, active: u.active !== false, lastLoginAt: u.lastLoginAt, locked: !!u.locked });
  const ME_VIEW = () => ({ via: VIA, email: SELF ? SELF.email : null, name: SELF ? SELF.name : (window.__actor || 'demo'), role: ROLE, totpEnabled: SELF ? !!SELF.totpEnabled : null, mustChange: SELF ? !!SELF.mustChange : false, restricted: !!(SELF && SELF.mustChange), require2fa: false });
  const allowed = (method, path) => {
    if (path.startsWith('/auth/')) return true;
    if (SELF && SELF.mustChange) return false;
    if (ROLE === 'owner') return true;
    if (ROLE === 'viewer') return method === 'GET' && !path.startsWith('/team') && !path.startsWith('/marketing/export') && !/^\/accounting\/(export|monthly)/.test(path);
    return (path.startsWith('/accounting') && ['GET', 'POST'].includes(method)) || (method === 'GET' && ['/orders', '/stats', '/charts'].some((x) => path === x || path.startsWith(x + '/')));
  };

  function handle(method, path, q, body) {
    if (!allowed(method, path)) return J({ error: 'FORBIDDEN' }, 403);
    let m;
    if (path === '/health') return J({ checks: [
      { key: 'seller', label: 'Mentions légales du vendeur complètes', level: 'required', ok: !sellerMissing().length, hint: 'Manque : ' + sellerMissing().join(', ') },
      { key: 'tax', label: 'TVA automatique Stripe (STRIPE_TAX=1)', level: 'required', ok: true, hint: '' },
      { key: 'webhook', label: 'Secret du webhook Stripe', level: 'required', ok: true, hint: '' },
      { key: 'provider', label: 'Fournisseur de données véhicule réel', level: 'required', ok: false, hint: 'Choisir un fournisseur et renseigner PROVIDER_ORDER (démonstration : données factices)' },
      { key: 'cron', label: 'Tâche planifiée protégée (CRON_SECRET)', level: 'required', ok: true, hint: '' },
      { key: 'support', label: 'Adresse de support (SUPPORT_EMAIL)', level: 'recommended', ok: false, hint: 'SUPPORT_EMAIL' },
      { key: 'pennylane', label: 'Pennylane connecté', level: 'info', ok: false, hint: 'PENNYLANE_API_TOKEN (sinon export CSV)' }] });
    if (path === '/stats') {
      const days = +q.get('days') || 30, from = now - days * day, rows = orders.filter((o) => Date.parse(o.created_at) >= from && o.kind !== 'credit_use');
      const net = rows.reduce((s, o) => s + (o.amount_ttc_cents || 0) - (o.refunded_cents || 0), 0), tax = rows.reduce((s, o) => s + (o.amount_tax_cents || 0) * (1 - (o.refunded_cents || 0) / (o.amount_ttc_cents || 1)), 0);
      return J({ days, net_ttc_cents: net, tax_cents: Math.round(tax), orders: rows.length, reports: rows.filter((o) => o.kind === 'report').length, packs: rows.filter((o) => o.kind === 'pack').length, credit_uses: orders.filter((o) => o.kind === 'credit_use').length, refunded_orders: rows.filter((o) => o.refunded_cents).length, disputes: 0,
        open_tickets: tickets.filter((t) => t.status === 'open').length, open_report_errors: rerrors.length, stuck_orders: orders.filter((o) => ['pending', 'generating'].includes(o.status) && now - Date.parse(o.created_at) > 15 * 6e4).length });
    }
    if (path === '/orders' && method === 'GET') {
      let l = orders.slice(); for (const [k, f] of [['email', 'buyer_email'], ['vin', 'vin'], ['status', 'status'], ['kind', 'kind']]) { const v = (q.get(k) || '').toLowerCase(); if (v) l = l.filter((o) => String(o[f] || '').toLowerCase().includes(v)); }
      return J({ orders: l, total: l.length });
    }
    if ((m = path.match(/^\/orders\/([\w-]+)(\/resend|\/retry|\/refund)?$/))) {
      const o = orders.find((x) => x.id === m[1]); if (!o) return J({ error: 'NOT_FOUND', message: 'Introuvable.' }, 404);
      if (!m[2]) { const iv = invoices.find((i) => i.order_id === o.id); return J({ order: o, invoice: iv || null, creditNotes: creditNotes.filter((n) => n.order_id === o.id), report: o.kind === 'pack' ? null : { plan: o.plan, options_count: 142, expires_at: new Date(Date.parse(o.created_at) + 365 * day).toISOString() } }); }
      if (m[2] === '/resend') { log('order_resend', o.id); return J({ ok: true }); }
      if (m[2] === '/retry') { if (!['pending', 'generating'].includes(o.status)) return J({ error: 'NOT_RETRYABLE' }, 409); o.status = 'delivered'; o.last_error = null; log('order_retry', o.id); return J({ ok: true }); }
      if (m[2] === '/refund') {
        if (String(body.reason || '').trim().length < 3) return J({ error: 'REASON_REQUIRED' }, 400);
        if (o.status === 'refunded') return J({ error: 'NOTHING_TO_REFUND' }, 409);
        if (o.kind === 'credit_use') { o.status = 'refunded'; log('order_refund', o.id); return J({ ok: true }); }
        const rest = o.amount_ttc_cents - o.refunded_cents, amt = body.amountCents || rest;
        if (amt > rest) return J({ error: 'EXCEEDS_REMAINING' }, 400);
        if (o.kind === 'pack') return J({ error: 'CREDITS_ALREADY_USED' }, 409);
        o.refunded_cents += amt; if (o.refunded_cents >= o.amount_ttc_cents) o.status = 'refunded';
        const num = 'AV-2026-' + String(++seq).padStart(6, '0'); creditNotes.push({ number: num, order_id: o.id, amount_ttc_cents: amt });
        emails.unshift({ created_at: new Date().toISOString(), kind: 'credit_note', to_email: o.buyer_email, subject: 'Votre remboursement et avoir ' + num, attempts: 1, status: 'sent' });
        log('order_refund', o.id); return J({ ok: true, creditNote: num });
      }
    }
    if (path === '/users') {
      const u = users[(q.get('email') || '').toLowerCase()]; if (!u) return J({ error: 'NOT_FOUND', message: 'Introuvable.' }, 404);
      return J({ email: (q.get('email') || '').toLowerCase(), ...u });
    }
    if ((m = path.match(/^\/users\/([\w-]+)\/(credits|role)$/))) {
      const e = Object.keys(users).find((k) => users[k].id === m[1]); if (!e) return J({ error: 'NOT_FOUND', message: 'Introuvable.' }, 404);
      if (m[2] === 'role') { users[e].role = body.role === 'pro' ? 'pro' : 'b2c'; log('user_role', e); return J({ ok: true }); }
      const d = body.delta; if (!Number.isInteger(d) || !d || Math.abs(d) > 1000) return J({ error: 'DELTA_INVALID' }, 400);
      if (users[e].credits_balance + d < 0) return J({ error: 'INSUFFICIENT_BALANCE' }, 409);
      users[e].credits_balance += d; log('credits_adjust', e + ' ' + d); return J({ balance: users[e].credits_balance });
    }
    if (path === '/tickets' && method === 'GET') return J({ tickets: tickets.filter((t) => t.status === (q.get('status') || 'open')) });
    if ((m = path.match(/^\/tickets\/([\w-]+)(\/reply)?$/))) {
      const t = tickets.find((x) => x.id === m[1]); if (!t) return J({ error: 'NOT_FOUND', message: 'Introuvable.' }, 404);
      if (m[2]) { if (String(body.message || '').trim().length < 3) return J({ error: 'MESSAGE_INVALID' }, 400); t.status = 'pending'; log('ticket_reply', t.id); return J({ ok: true }); }
      t.status = body.status || t.status; log('ticket_update', t.id); return J({ ok: true });
    }
    if (path === '/report-errors' && method === 'GET') return J({ errors: rerrors });
    if ((m = path.match(/^\/report-errors\/([\w-]+)$/))) { rerrors = rerrors.filter((x) => x.id !== m[1]); log('report_error_' + body.status, m[1]); return J({ ok: true }); }
    if (path === '/labels/untranslated') return J({ items: labels });
    if (path === '/labels' && method === 'PUT') { labels = labels.filter((x) => !(x.brand === body.brand && x.code === body.code)); log('label_set', body.brand + '/' + body.code); return J({ ok: true }); }
    if (path === '/accounting' && method === 'GET') { const st = q.get('status'); return J({ pennylane: false, items: invoices.filter((i) => !st || i.accounting_status === st) }); }
    if (path === '/accounting/retry') { const i = invoices.find((x) => x.id === body.id); if (i) { i.accounting_status = i.accounting_status === 'needs_review' ? 'needs_review' : 'pending'; i.accounting_error = i.accounting_status === 'needs_review' ? i.accounting_error : null; } log('accounting_retry', body.id); return J({ ok: true }); }
    if (path === '/accounting/monthly/send') { if (!/^\d{4}-\d{2}$/.test(body.month || '')) return J({ error: 'MONTH_INVALID' }, 400); log('monthly_send', body.month); return J({ ok: true, to: ['admin@exemple.fr', 'comptable@exemple.fr'] }); }
    if (path === '/accounting/monthly') {
      const mo = q.get('month'); if (!/^\d{4}-\d{2}$/.test(mo || '')) return J({ error: 'MONTH_INVALID' }, 400);
      if (q.get('part') === 'detail') return csv([['Numéro', 'Date', 'Client', 'Pays', 'HT', 'TVA', 'TTC']].concat(invoices.map((i) => { const o = orders.find((x) => x.id === i.order_id); return [i.number, i.issued_at.slice(0, 10), i.buyer_name || i.buyer_email, i.buyer_email.endsWith('.de') ? 'DE' : 'FR', eur(o.amount_ttc_cents - o.amount_tax_cents), eur(o.amount_tax_cents), eur(o.amount_ttc_cents)]; })));
      return csv([['Pays', 'Régime', 'Taux', 'HT', 'TVA', 'TTC'], ['FR', 'standard', '20', '312,40', '62,48', '374,88'], ['DE', 'autoliquidation', '0', '49,00', '0,00', '49,00'], ['(démonstration : données fictives)']]);
    }
    if (path === '/accounting/export') return csv([['Numéro', 'Date', 'Client', 'TTC']].concat(invoices.map((i) => [i.number, i.issued_at.slice(0, 10), i.buyer_name || i.buyer_email, eur(i.amount_ttc_cents)])));
    if (path === '/emails') return J({ items: emails.filter((e) => e.status === (q.get('status') || 'failed')) });
    if (path === '/marketing/stats') return J({ subscribers: 18, users: 42 });
    if (path === '/marketing/export') return csv([['email', 'consent_at', 'source'], ['alice.martin@exemple.fr', iso(30).slice(0, 10), 'signup'], ['(démonstration : données fictives)']]);
    if (path === '/audit') return J({ items: audit.slice(0, 50) });
    if (path === '/settings' && method === 'GET') return J({ seller, missing: sellerMissing(), enforced: false });
    if (path === '/settings' && method === 'PUT') {
      const b = body.seller || {}, t = (k) => String(b[k] == null ? '' : b[k]).trim().slice(0, 200), siren = t('siren').replace(/\s/g, '');
      if (siren && !validSiren(siren)) return J({ error: 'SIREN_INVALID' }, 400);
      const vat = t('vat').replace(/\s/g, '').toUpperCase(); if (vat && !/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(vat)) return J({ error: 'VAT_INVALID' }, 400);
      if (t('email') && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t('email'))) return J({ error: 'EMAIL_INVALID' }, 400);
      seller = { name: t('name'), legalForm: t('legalForm'), capital: t('capital'), rcs: t('rcs'), address: t('address'), siren, vat, email: t('email'), franchise: b.franchise === true }; log('settings_update', 'seller'); return J({ ok: true });
    }
    if (path === '/site' && method === 'GET') return J(view());
    if (path === '/site' && method === 'PUT') {
      const v = SC.validate(body.config); if (!v.ok) return J({ error: v.error }, 400);
      const before = JSON.stringify(SC.effectivePrices(cfg)), after = JSON.stringify(SC.effectivePrices(v.value));
      if (before !== after && body.confirmPrices !== true) return J({ error: 'PRICES_CONFIRM_REQUIRED' }, 409);
      prev = cfg; cfg = v.value; updatedAt = new Date().toISOString(); log('site_update', 'site'); pushSite(); return J(view());
    }
    if (path === '/site/restore' && method === 'POST') { if (!prev) return J({ error: 'NO_PREVIOUS' }, 409); const t = cfg; cfg = prev; prev = t; updatedAt = new Date().toISOString(); log('site_restore', 'site'); pushSite(); return J(view()); }

    // ---- nouveautés ----
    if (path === '/charts') return J(charts(+q.get('days') || 30));

    if (path === '/compare') {
      const days = +q.get('days') || 30, per = (a, b) => { const r = orders.filter((o) => { const t = Date.parse(o.created_at); return t >= now - b * day && t < now - a * day && paid(o); }); const ttc = r.reduce((x, o) => x + o.amount_ttc_cents - (o.refunded_cents || 0), 0), tax = r.reduce((x, o) => x + (o.amount_tax_cents || 0) * (1 - (o.refunded_cents || 0) / o.amount_ttc_cents), 0); return { net_ttc_cents: ttc, net_ht_cents: Math.round(ttc - tax), orders: r.length, refundRate: r.length ? r.filter((o) => o.refunded_cents).length / r.length : 0, avgBasket_cents: r.length ? Math.round(ttc / r.length) : 0 }; };
      const c = per(0, days); let p = per(days, days * 2); if (!p.orders) p = { net_ttc_cents: Math.round(c.net_ttc_cents * 0.82), net_ht_cents: Math.round(c.net_ht_cents * 0.82), orders: Math.max(1, c.orders - 2), refundRate: 0.18, avgBasket_cents: Math.round(c.avgBasket_cents * 1.05) };
      const d = (a, b) => (b > 0 ? (a - b) / b : null);
      return J({ days, current: c, previous: p, delta: { net_ttc: d(c.net_ttc_cents, p.net_ttc_cents), net_ht: d(c.net_ht_cents, p.net_ht_cents), orders: d(c.orders, p.orders), avgBasket: d(c.avgBasket_cents, p.avgBasket_cents), refundRate: c.refundRate - p.refundRate }, hasPrevious: true });
    }
    if (path === '/goal' && method === 'GET') return J(goalView());
    if (path === '/goal' && method === 'PUT') { const v = Number(body.ht_cents); if (!Number.isInteger(v) || v < 0 || v > 1e9) return J({ error: 'GOAL_INVALID' }, 400); goalCents = v; log('goal_update', 'objectif'); return J({ ok: true, goal: { ht_cents: v } }); }
    if (path === '/funnel') { const k = Math.min(+q.get('days') || 30, 90) / 30, n = (x) => Math.round(x * k), steps = [['lookup', 'VIN saisi (aperçu)', n(240)], ['checkout', 'Paiement commencé', n(52)], ['paid', 'Rapport payé', n(31)], ['opened', 'Rapport ouvert', n(44)]];
      return J({ days: +q.get('days') || 30, steps: steps.map(([key, label, count], i) => ({ key, label, count, fromPrevious: i ? count / steps[i - 1][2] : null })), overall: steps[2][2] / steps[0][2], trackingOn: true }); }
    if (path === '/brands') return J({ days: +q.get('days') || 30, trackingOn: true, brands: [{ brand: 'Peugeot', lookups: 61, paid: 3, withoutPurchase: 58, conversion: 3 / 61, avgOptions: 22 }, { brand: 'Renault', lookups: 48, paid: 2, withoutPurchase: 46, conversion: 2 / 48, avgOptions: 31 }, { brand: 'Volkswagen', lookups: 40, paid: 9, withoutPurchase: 31, conversion: 9 / 40, avgOptions: 96 }, { brand: 'BMW', lookups: 35, paid: 12, withoutPurchase: 23, conversion: 12 / 35, avgOptions: 138 }, { brand: 'Skoda', lookups: 14, paid: 2, withoutPurchase: 12, conversion: 2 / 14, avgOptions: 71 }] });
    if (path === '/pro-credits') {
      const items = [{ id: 'u3', email: 'direction@concession-moreau.fr', company: 'Concession Moreau SAS', balance: 100, packs: 1, lastPurchase: iso(12), uses: 0, lastUse: null, idleDays: null, status: 'never' }, { id: 'u5', email: 'contact@carrosserie-lopez.fr', company: 'Carrosserie Lopez', balance: 14, packs: 2, lastPurchase: iso(110), uses: 9, lastUse: iso(75), idleDays: 75, status: 'sleeping' }, { id: 'u2', email: 'achats@garage-dupont.fr', company: 'Garage Dupont SARL', balance: 1, packs: 3, lastPurchase: iso(1), uses: 31, lastUse: iso(2.5), idleDays: 2, status: 'low' }, { id: 'u6', email: 'compta@auto-services.fr', company: 'Auto Services 69', balance: 0, packs: 1, lastPurchase: iso(40), uses: 10, lastUse: iso(6), idleDays: 6, status: 'empty' }];
      const c = (k) => items.filter((i) => i.status === k).length; return J({ items, threshold: 2, summary: { total: items.length, never: c('never'), sleeping: c('sleeping'), low: c('low'), empty: c('empty'), creditsOutstanding: items.reduce((a, i) => a + i.balance, 0) } });
    }
    if (path === '/recall-alerts') return J({ enabled: true, intervalDays: 7, active: 14, stopped: 3, stoppedBy: { user: 2, expired: 1 }, alertsSent: 5, alerted30d: 2, awaitingFirstCheck: 1, dueNow: 4, checksPerMonth: 60 });
    if (path === '/treasury') { const cur = ymd0(now).slice(0, 7), pm = new Date(now); pm.setUTCDate(1); pm.setUTCMonth(pm.getUTCMonth() - 1); const mk = (k, f) => ({ month: k, orders: Math.round(11 * f), ttc_cents: Math.round(72953 * f), tax_cents: Math.round(11343 * f), ht_cents: Math.round(61610 * f), refunded_cents: Math.round(1299 * f) });
      return J({ current: mk(cur, 1), previous: mk(pm.toISOString().slice(0, 7), 1.4), recent7_ttc_cents: 19230, ordersInProgress: 1, disputes: 0, estimate: true }); }
    if (path === '/tech') { const days = Math.min(+q.get('days') || 30, 90), series = []; for (let i = days - 1; i >= 0; i--) series.push({ date: ymd0(now - i * day), orders: 2, failed: i % 11 === 3 ? 1 : 0, avgSeconds: 6 + (i % 5) * 2 + (i === 4 ? 14 : 0) });
      return J({ days, series, avgSeconds: 9, p95Seconds: 21, failureRate: 0.04, reports: 9 * Math.ceil(days / 10) }); }
    if (path === '/recap') {
      const mo = q.get('month'); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mo || '')) return J({ error: 'MONTH_INVALID' }, 400); log('recap_export', mo);
      if (q.get('format') === 'pdf') return new Response(new Blob(['%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'], { type: 'application/pdf' }), { status: 200 });
      return csv([['Récapitulatif mensuel', mo], ['(démonstration : données fictives)'], ['Chiffre d’affaires net HT', '616,10'], ['Marge réelle', '541,49']]);
    }
    if (path === '/unsold') {
      const days = +q.get('days') || 30, from = now - days * day, rows = orders.filter((o) => Date.parse(o.created_at) >= from && ['report', 'pack'].includes(o.kind));
      const OFF = [['report:essentiel', 'Rapport Essentiel', 7], ['report:premium', 'Rapport Premium', 5], ['pack:10', 'Pack 10 crédits', 6], ['pack:30', 'Pack 30 crédits', 3], ['pack:100', 'Pack 100 crédits', 2]];
      const offers = OFF.map(([key, label, ab]) => { const mine = rows.filter((o) => (o.kind === 'report' ? 'report:' + o.plan : 'pack:' + o.credits) === key), sold = mine.length, abandoned = Math.round(ab * Math.min(days, 90) / 30), started = sold + abandoned;
        return { key, label, sold, refunded: mine.filter((o) => o.refunded_cents > 0).length, abandoned, started, abandonRate: started ? abandoned / started : null, refundRate: sold ? mine.filter((o) => o.refunded_cents > 0).length / sold : null }; })
        .sort((a, b) => a.sold - b.sold || b.abandoned - a.abandoned || (a.key < b.key ? -1 : 1));
      const at = offers.reduce((a, o) => a + o.abandoned, 0), st = offers.reduce((a, o) => a + o.sold, 0);
      return J({ days, offers, notSelling: offers.filter((o) => o.sold === 0).map((o) => o.key), abandonedTotal: at, soldTotal: st, abandonRate: st + at ? at / (st + at) : null, trackingOn: at > 0 });
    }
    if (path === '/margin') return J(margin(+q.get('days') || 30));
    if (path === '/quality') return J(quality());
    if (path === '/costs' && method === 'GET') return J({ costs });
    if (path === '/costs' && method === 'PUT') {
      const o = { essentiel_cents: +body.essentiel_cents, premium_cents: +body.premium_cents, stripe_pct: +body.stripe_pct, stripe_fixed_cents: +body.stripe_fixed_cents };
      if (['essentiel_cents', 'premium_cents', 'stripe_fixed_cents'].some((k) => !Number.isInteger(o[k]) || o[k] < 0 || o[k] > 100000) || !(o.stripe_pct >= 0 && o.stripe_pct <= 10)) return J({ error: 'COSTS_INVALID' }, 400);
      costs = o; log('costs_update', 'costs'); return J({ costs });
    }
    if (path === '/expenses' && method === 'GET') return J({ items: expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1)), categories: EXP_CATS });
    if (path === '/expenses' && method === 'POST') {
      const c = Number(body.amount_ht_cents), label = String(body.label || '').trim().slice(0, 80);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) || !label || !(body.category in EXP_CATS) || !Number.isInteger(c) || c < 1 || c > 10000000) return J({ error: 'EXPENSE_INVALID' }, 400);
      const e = { id: 'ex-' + rid(), date: body.date, label, category: body.category, amount_ht_cents: c }; expenses.push(e); log('expense_add', label); return J({ item: e }, 201);
    }
    if ((m = path.match(/^\/expenses\/([\w-]+)$/)) && method === 'DELETE') { expenses = expenses.filter((x) => x.id !== m[1]); log('expense_delete', m[1]); return J({ ok: true }); }
    if (path === '/search') {
      const t = String(q.get('q') || '').trim(); if (t.length < 3) return J({ error: 'QUERY_TOO_SHORT' }, 400);
      const e = t.toLowerCase(), up = t.toUpperCase(), out = { users: [], orders: [], invoices: [], creditNotes: [], tickets: [] };
      if (/^[^\s@]+@[^\s@]+$/.test(e)) { if (users[e]) out.users = [{ id: users[e].id, email: e, role: users[e].role, company_name: users[e].company_name }]; out.orders = orders.filter((o) => o.buyer_email === e); out.tickets = tickets.filter((x) => x.email === e); }
      if (/^[A-HJ-NPR-Z0-9]{17}$/.test(up)) out.orders = out.orders.concat(orders.filter((o) => o.vin === up));
      if (/^EV-\d{4}-\d{6}$/.test(up)) out.invoices = invoices.filter((i) => i.number === up);
      if (/^AV-\d{4}-\d{6}$/.test(up)) out.creditNotes = creditNotes.filter((n) => n.number === up);
      return J({ q: t, ...out });
    }
    if ((m = path.match(/^\/users\/([\w-]+)\/note$/))) {
      if (method === 'GET') return J({ note: notes[m[1]] ? notes[m[1]].note : '', author: notes[m[1]] ? notes[m[1]].author : null, updatedAt: notes[m[1]] ? notes[m[1]].at : null });
      notes[m[1]] = { note: String(body.note || '').slice(0, 2000), author: window.__actor || 'demo', at: new Date().toISOString() }; log('user_note', m[1]); return J({ ok: true });
    }
    if (path === '/labels/bulk' && method === 'PUT') {
      const items = Array.isArray(body.items) ? body.items : []; if (!items.length || items.length > 300) return J({ error: 'BULK_INVALID' }, 400);
      let saved = 0; const rejected = [];
      items.forEach((x, i) => { const b = String(x.brand || '').trim().toUpperCase(), c = String(x.code || '').trim().toUpperCase(), l = String(x.labelFr || '').trim(); if (!b || !c || !l || l.length > 200) return rejected.push({ line: i + 1 }); labels = labels.filter((y) => !(y.brand === b && y.code === c)); saved++; });
      log('labels_bulk', saved + ' lignes'); return J({ saved, rejected });
    }
    if (path === '/promos' && method === 'GET') return J({ items: promos, enabled: true });
    if (path === '/promos' && method === 'POST') {
      const code = String(body.code || '').trim().toUpperCase(); if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return J({ error: 'PROMO_CODE_INVALID' }, 400);
      const pc = body.percentOff, am = body.amountOffCents;
      if ((pc == null) === (am == null) || (pc != null && !(pc >= 1 && pc <= 100)) || (am != null && !(Number.isInteger(am) && am >= 1 && am <= 50000))) return J({ error: 'PROMO_VALUE_INVALID' }, 400);
      if (body.maxRedemptions && !(Number.isInteger(+body.maxRedemptions) && +body.maxRedemptions >= 1)) return J({ error: 'PROMO_MAX_INVALID' }, 400);
      if (body.expiresAt && !(Date.parse(body.expiresAt) > now)) return J({ error: 'PROMO_EXPIRY_INVALID' }, 400);
      if (promos.some((p) => p.code === code)) return J({ error: 'PROMO_EXISTS' }, 409);
      promos.unshift({ id: 'promo_' + rid().replace(/-/g, '_'), code, active: true, percentOff: pc != null ? +pc : null, amountOffCents: am != null ? am : null, maxRedemptions: body.maxRedemptions ? +body.maxRedemptions : null, timesRedeemed: 0, expiresAt: body.expiresAt ? new Date(body.expiresAt).toISOString() : null, createdAt: new Date().toISOString() });
      log('promo_create', code); return J({ ok: true }, 201);
    }
    if ((m = path.match(/^\/promos\/([\w-]+)\/active$/))) { const p = promos.find((x) => x.id === m[1]); if (!p) return J({ error: 'NOT_FOUND' }, 404); p.active = body.active === true; log('promo_active', p.code + ' ' + p.active); return J({ ok: true }); }
    if (path === '/email-templates' && method === 'GET') return J({ items: Object.keys(TPL).map((key) => ({ key, label: TPL[key], override: emailOv[key] || null, subject: TPL_SUB[key] })), internal: { admin_login: 'Alerte de connexion', admin_locked: 'Compte verrouillé', admin_digest: 'Résumé quotidien' } });
    if ((m = path.match(/^\/email-templates\/(\w+)(\/preview)?$/)) && TPL[m[1]]) {
      if (m[2]) return J(mailPrev(m[1], cleanOv(body)));
      const c = cleanOv(body); if (c) emailOv[m[1]] = c; else delete emailOv[m[1]]; log('email_template', m[1]); return J({ ok: true, override: c });
    }
    if (path === '/site/draft' && method === 'GET') return J({ draft });
    if (path === '/site/draft' && method === 'PUT') {
      const v = SC.validate(body.config); if (!v.ok) return J({ error: v.error }, 400);
      let publishAt = null; if (body.publishAt) { const t = Date.parse(body.publishAt); if (!(t > now + 3e4) || t > now + 90 * day) return J({ error: 'PUBLISH_AT_INVALID' }, 400); publishAt = new Date(t).toISOString(); }
      const changed = JSON.stringify(SC.effectivePrices(cfg)) !== JSON.stringify(SC.effectivePrices(v.value)); if (changed && publishAt && body.confirmPrices !== true) return J({ error: 'PRICES_CONFIRM_REQUIRED' }, 409);
      draft = { config: v.value, publishAt, savedAt: new Date().toISOString(), pricesConfirmed: changed && !!publishAt }; log('site_draft', publishAt || 'brouillon'); return J({ draft });
    }
    if (path === '/site/draft' && method === 'DELETE') { draft = null; log('site_draft_delete', 'brouillon'); return J({ ok: true }); }
    if (path === '/site/draft/publish') {
      if (!draft) return J({ error: 'NO_DRAFT' }, 404); const v = SC.validate(draft.config); if (!v.ok) return J({ error: v.error }, 400);
      if (JSON.stringify(SC.effectivePrices(cfg)) !== JSON.stringify(SC.effectivePrices(v.value)) && body.confirmPrices !== true) return J({ error: 'PRICES_CONFIRM_REQUIRED' }, 409);
      prev = cfg; cfg = v.value; updatedAt = new Date().toISOString(); draft = null; log('site_publish_draft', 'site'); pushSite(); return J({ ok: true });
    }
    if (path === '/site/preview-link') return draft ? J({ url: '', minutes: 30, demo: true }) : J({ error: 'NO_DRAFT' }, 404);
    // équipe et compte
    if (path === '/auth/me') return J(ME_VIEW());
    if (path === '/auth/logout') return J({ ok: true });
    if (path === '/auth/password') {
      if (!SELF) return J({ error: 'KEY_ACCOUNT' }, 400);
      if (body.current !== PASSWORD && body.current !== SELF.pw) return J({ error: 'INVALID_CREDENTIALS' }, 401);
      if (String(body.newPassword || '').length < 12) return J({ error: 'PASSWORD_WEAK' }, 400);
      if (body.newPassword === body.current) return J({ error: 'PASSWORD_SAME' }, 400);
      SELF.pw = body.newPassword; SELF.mustChange = false; log('password_change', SELF.email); return J({ ok: true });
    }
    if (path === '/auth/2fa/start') { if (!SELF) return J({ error: 'KEY_ACCOUNT' }, 400); return J({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth: 'otpauth://totp/EuroVin:' + SELF.email + '?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=EuroVin' }); }
    if (path === '/auth/2fa/confirm') { if (!SELF) return J({ error: 'KEY_ACCOUNT' }, 400); if (body.code !== DEMO_CODE) return J({ error: 'INVALID_CODE' }, 401); SELF.totpEnabled = true; log('2fa_enable', SELF.email); return J({ ok: true }); }
    if (path === '/auth/2fa/disable') { if (!SELF) return J({ error: 'KEY_ACCOUNT' }, 400); if (body.password !== PASSWORD && body.password !== SELF.pw) return J({ error: 'INVALID_CREDENTIALS' }, 401); SELF.totpEnabled = false; return J({ ok: true }); }
    if (path === '/team' && method === 'GET') return J({ users: ACCOUNTS.map(pubU), require2fa: false });
    if (path === '/team' && method === 'POST') {
      const email = String(body.email || '').trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return J({ error: 'EMAIL_INVALID' }, 400);
      if (!ROLES.includes(body.role)) return J({ error: 'ROLE_INVALID' }, 400); if (ACCOUNTS.some((a) => a.email === email)) return J({ error: 'EMAIL_EXISTS' }, 409);
      const pw = tempPw(), u = { id: 'tm-' + rid(), email, name: String(body.name || '').slice(0, 60), role: body.role, totpEnabled: false, mustChange: true, active: true, lastLoginAt: null, locked: false, pw };
      ACCOUNTS.push(u); log('team_create', email); return J({ user: pubU(u), tempPassword: pw }, 201);
    }
    if ((m = path.match(/^\/team\/([\w-]+)$/)) && method === 'PATCH') {
      const u = ACCOUNTS.find((x) => x.id === m[1]); if (!u) return J({ error: 'NOT_FOUND' }, 404);
      if (SELF && u.id === SELF.id && (body.active === false || (body.role && body.role !== u.role))) return J({ error: 'SELF' }, 409);
      if (body.role) { if (!ROLES.includes(body.role)) return J({ error: 'ROLE_INVALID' }, 400); u.role = body.role; }
      if (typeof body.active === 'boolean') u.active = body.active; if (body.unlock) u.locked = false; if (body.reset2fa) u.totpEnabled = false;
      let tp; if (body.resetPassword) { tp = tempPw(); u.pw = tp; u.mustChange = true; }
      log('team_update', u.email); return J({ ok: true, ...(tp ? { tempPassword: tp } : {}) });
    }
    return J({ error: 'NOT_FOUND' }, 404);
  }

  const realFetch = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = async function (url, o = {}) {
    const u = new URL(String(url), 'http://demo.local');
    if (!u.pathname.startsWith('/api/admin/')) return realFetch ? realFetch(url, o) : J({ error: 'NOT_FOUND' }, 404);
    await new Promise((r) => setTimeout(r, 90));
    const h = o.headers || {};
    if (u.pathname === '/api/admin/auth/login') {
      let b = {}; try { b = JSON.parse(o.body || '{}'); } catch (e) { /* */ }
      const a = ACCOUNTS.find((x) => x.email === String(b.email || '').trim().toLowerCase());
      if (!a || a.active === false || (b.password !== PASSWORD && b.password !== a.pw)) return J({ error: 'INVALID_CREDENTIALS', left: 4 }, 401);
      if (a.locked) return J({ error: 'LOCKED' }, 423);
      if (a.totpEnabled) { if (!b.code) return J({ needCode: true }); if (String(b.code).replace(/\s/g, '') !== DEMO_CODE) return J({ error: 'INVALID_CODE', left: 4 }, 401); }
      const tok = 'demo-' + rid(); SESS[tok] = a; a.lastLoginAt = new Date().toISOString();
      return J({ token: tok, expiresAt: new Date(now + 12 * 36e5).toISOString(), user: pubU(a), restricted: !!a.mustChange });
    }
    const bearer = /^Bearer (.+)$/.exec(h.authorization || '');
    if (bearer) { const a = SESS[bearer[1]]; if (!a || a.active === false) return J({ error: 'UNAUTHORIZED' }, 401); SELF = a; ROLE = a.role; VIA = 'account'; window.__actor = a.email; }
    else if (h['x-admin-key'] === PASSWORD) { SELF = null; ROLE = 'owner'; VIA = 'key'; window.__actor = h['x-admin-actor'] || 'demo'; }
    else return J({ error: 'UNAUTHORIZED' }, 401);
    let body = {}; try { body = o.body ? JSON.parse(o.body) : {}; } catch (e) { /* corps invalide */ }
    return handle((o.method || 'GET').toUpperCase(), u.pathname.slice('/api/admin'.length), u.searchParams, body);
  };

  document.addEventListener('DOMContentLoaded', () => {
    const f = document.getElementById('flogin');
    if (f) { const n = document.createElement('div'); n.className = 'card'; n.id = 'demohint'; n.innerHTML = '<b>Démonstration</b> — toutes les données sont fictives et aucun serveur n’est contacté. Clé de secours : <code>' + PASSWORD + '</code>. Comptes d’essai (mot de passe <code>' + PASSWORD + '</code>) : <code>proprietaire@exemple.fr</code>, <code>lecteur@exemple.fr</code> (lecture seule), <code>compta@exemple.fr</code> (comptable, code <code>123456</code>). Vos modifications du site (bandeau, prix, textes, pages, FAQ) s’appliquent en direct au site de démonstration ; fermez l’administration pour les voir.'; f.parentNode.insertBefore(n, f); }
    const lg = document.querySelector('.logo'); if (lg) lg.insertAdjacentHTML('beforeend', '<span class="chip" style="margin-left:8px">Démo</span>');
  });
})();
