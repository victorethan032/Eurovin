'use strict';
/**
 * Back-office (API) : tableau de bord, commandes, remboursements, crédits, rôles Pro, support, signalements.
 * Protégé par ADMIN_API_KEY (en-tête x-admin-key). À placer derrière un VPN ou une liste d'adresses IP en production.
 * Chaque action sensible est écrite dans admin_audit.
 */
const express = require('express');
const P = require('./payments');
const crypto = require('crypto');

module.exports = function adminRouter(d) {
  const { supabase, nowIso, refundOrder, runOrder, deliverSafe, mailer } = d;
  const T = mailer.T;
  const r = express.Router();
  const json = express.json({ limit: '10kb' });
  const json2 = express.json({ limit: '300kb' });                        // contenu du site : pages légales longues
  const UUID = /^[0-9a-f-]{36}$/i;

  const auth = require('./adminauth')({ supabase, mailer });
  const ipOk = (req) => { const allow = String(process.env.ADMIN_IP_ALLOWLIST || '').split(',').map((x) => x.trim()).filter(Boolean); return !allow.length || allow.includes(req.ip); };   // liste blanche d'adresses IP facultative
  // Connexion personnelle (e-mail + mot de passe + code à usage unique) : seule route publique de l'API admin.
  r.post('/api/admin/auth/login', d.adminLimiter, (req, res, next) => (ipOk(req) ? next() : res.status(404).json({ error: 'Introuvable.' })), json, auth.login);
  r.use('/api/admin', d.adminLimiter, async (req, res, next) => {
    try {
      if (!ipOk(req)) return res.status(404).json({ error: 'Introuvable.' });
      const a = await auth.authenticate(req);
      if (a.error) return res.status(a.status).json({ error: a.error });
      const rel = String(req.path).replace(/^\/api\/admin/, '') || '/';
      if (a.restricted && !/^\/auth(\/|$)/.test(rel)) return res.status(403).json({ error: a.user && a.user.must_change ? 'PASSWORD_CHANGE_REQUIRED' : '2FA_SETUP_REQUIRED' });
      if (!auth.can(a.role, req.method, rel)) return res.status(403).json({ error: 'FORBIDDEN' });
      req.admin = a; req.actor = a.actor; req.role = a.role;
      next();
    } catch (e) { next(e); }
  });
  const audit = (req, action, target, payload) => supabase.from('admin_audit').insert({ action, target, payload, actor: req.actor }).then(() => {}, (e) => console.error('audit :', e.message));
  auth.mount(r, json, audit);
  require('./adminplus')(r, { supabase, stripe: d.stripe, mailer, settings: d.settings, audit, json, json2, nowIso });

  // Libellés d'options : file des termes non traduits + validation manuelle (prioritaire sur le glossaire intégré).
  r.get('/api/admin/labels/untranslated', async (req, res, next) => {
    try {
      const { data, error } = await supabase.from('untranslated_labels').select('*').order('seen_count', { ascending: false }).limit(200);
      if (error) throw error;
      res.json({ items: data || [] });
    } catch (e) { next(e); }
  });
  r.put('/api/admin/labels', json, async (req, res, next) => {
    try {
      const b = req.body || {};
      const brand = String(b.brand || '').trim().toUpperCase().slice(0, 60), code = String(b.code || '').trim().slice(0, 60), label = String(b.labelFr || '').trim();
      if (!brand || !code || label.length < 2 || label.length > 200) return res.status(400).json({ error: 'LABEL_INVALID' });
      const { error } = await supabase.from('option_labels').upsert({ brand, code, label_fr: label, updated_at: nowIso() }, { onConflict: 'brand,code' });
      if (error) throw error;
      await supabase.from('untranslated_labels').delete().eq('brand', brand).eq('code', code);
      audit(req, 'label_set', brand + '/' + code, { label });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Profil de l'exploitant (mentions légales des factures) : saisi ici, prioritaire sur les variables d'environnement.
  const I = require('./invoicing');
  const sellerView = () => { const eff = I.sellerFromEnv(); return { seller: eff, missing: I.sellerMissing(eff), enforced: process.env.NODE_ENV === 'production' || process.env.ENFORCE_SELLER === '1' }; };
  r.get('/api/admin/settings', (req, res) => res.json(sellerView()));
  r.put('/api/admin/settings', json, async (req, res, next) => {
    try {
      const b = (req.body && req.body.seller) || {}, out = {}, t = (k, n = 200) => String(b[k] == null ? '' : b[k]).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
      for (const k of ['name', 'legalForm', 'capital', 'rcs', 'address']) out[k] = t(k);
      out.siren = t('siren').replace(/\s/g, ''); if (out.siren && !I.validSiren(out.siren)) return res.status(400).json({ error: 'SIREN_INVALID' });
      out.vat = t('vat', 20).replace(/\s/g, '').toUpperCase(); if (out.vat && !/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(out.vat)) return res.status(400).json({ error: 'VAT_INVALID' });
      out.email = t('email', 120).toLowerCase(); if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(out.email)) return res.status(400).json({ error: 'EMAIL_INVALID' });
      out.franchise = b.franchise === true;
      await d.settings.save(out);
      audit(req, 'settings_seller', 'seller', { ...out, siren: out.siren ? '•••' + out.siren.slice(-3) : '' });
      res.json(sellerView());
    } catch (e) { next(e); }
  });
  // État de la configuration : uniquement des oui/non, jamais de valeur secrète.
  r.get('/api/admin/health', (req, res) => {
    const e = process.env, miss = I.sellerMissing(I.sellerFromEnv());
    const c = (key, label, level, ok, hint) => ({ key, label, level, ok: !!ok, hint });
    res.json({ checks: [
      c('seller', 'Mentions légales du vendeur complètes', 'required', !miss.length, miss.length ? 'Manque : ' + miss.join(', ') + ' (onglet Paramètres)' : ''),
      c('tax', 'TVA automatique Stripe (STRIPE_TAX=1)', 'required', e.STRIPE_TAX === '1', 'Activer Stripe Tax et STRIPE_TAX=1'),
      c('webhook', 'Secret du webhook Stripe', 'required', e.STRIPE_WEBHOOK_SECRET, 'STRIPE_WEBHOOK_SECRET'),
      c('provider', 'Fournisseur de données véhicule réel', 'required', e.PROVIDER_ORDER && e.PROVIDER_ORDER !== 'mock' && e.ALLOW_MOCK !== '1', 'PROVIDER_ORDER (les données factices sont réservées aux tests)'),
      c('https', 'Adresse du site en HTTPS', 'required', /^https:/.test(e.APP_URL || ''), 'APP_URL en https://'),
      c('cron', 'Tâche planifiée protégée (CRON_SECRET)', 'required', (e.CRON_SECRET || '').length >= 24, 'CRON_SECRET d’au moins 24 caractères et un appel régulier à /api/jobs/sweep'),
      c('adminmail', 'E-mail d’alerte admin (ADMIN_EMAIL)', 'required', e.ADMIN_EMAIL, 'ADMIN_EMAIL'),
      c('support', 'Adresse de support (SUPPORT_EMAIL)', 'recommended', e.SUPPORT_EMAIL, 'SUPPORT_EMAIL'),
      c('pennylane', 'Pennylane connecté', 'recommended', e.PENNYLANE_API_TOKEN && e.PENNYLANE_SYNC !== '0', 'PENNYLANE_API_TOKEN (sinon export CSV manuel)'),
      c('accountant', 'Comptable destinataire de l’export mensuel', 'recommended', e.ACCOUNTANT_EMAIL, 'ACCOUNTANT_EMAIL'),
      c('brevo', 'Webhook Brevo sécurisé', 'recommended', e.BREVO_WEBHOOK_SECRET, 'BREVO_WEBHOOK_SECRET'),
      c('ip', 'Accès admin limité par adresse IP', 'recommended', e.ADMIN_IP_ALLOWLIST, 'ADMIN_IP_ALLOWLIST (ou VPN)'),
      c('twofa', 'Double authentification obligatoire pour les comptes', 'recommended', e.ADMIN_REQUIRE_2FA === '1', 'ADMIN_REQUIRE_2FA=1 (après avoir créé les comptes personnels dans l’onglet Équipe)'),
      c('valuation', 'Cotation de prix', 'info', e.VALUATION_ENABLED === '1', 'Désactivée au lancement (aucun fournisseur de marché)'),
    ], production: e.NODE_ENV === 'production' });
  });
  // Contenu du site : bandeau, maintenance, prix, textes, pages légales, FAQ (version précédente restaurable).
  const SC = require('./siteconfig');
  const siteView = () => ({ config: d.settings.site, defaults: { prices: SC.DEFAULT_PRICES }, pageKeys: SC.PAGE_KEYS, hasPrevious: d.settings.hasPrevious, updatedAt: d.settings.siteUpdatedAt, valuationEnv: process.env.VALUATION_ENABLED === '1' });
  r.get('/api/admin/site', (req, res) => res.json(siteView()));
  r.put('/api/admin/site', json2, async (req, res, next) => {
    try {
      const v = SC.validate(req.body && req.body.config);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const before = JSON.stringify(SC.effectivePrices(d.settings.site)), after = JSON.stringify(SC.effectivePrices(v.value));
      if (before !== after && req.body.confirmPrices !== true) return res.status(409).json({ error: 'PRICES_CONFIRM_REQUIRED' });
      await d.settings.saveSite(v.value);
      audit(req, 'site_update', 'site', { prices: before !== after ? JSON.parse(after) : undefined, banner: v.value.banner.enabled, maintenance: v.value.maintenance.enabled, pages: Object.keys(v.value.pages), faq: v.value.faq ? v.value.faq.length : 0 });
      res.json(siteView());
    } catch (e) { next(e); }
  });
  r.post('/api/admin/site/restore', async (req, res, next) => {
    try { const ok = await d.settings.restoreSite(); if (!ok) return res.status(409).json({ error: 'NO_PREVIOUS' }); audit(req, 'site_restore', 'site', {}); res.json(siteView()); } catch (e) { next(e); }
  });
  r.get('/api/admin/audit', async (req, res, next) => {
    try { const { data, error } = await supabase.from('admin_audit').select('action,target,actor,created_at,payload').order('created_at', { ascending: false }).limit(100); if (error) throw error; res.json({ items: data || [] }); } catch (e) { next(e); }
  });
  r.get('/api/admin/marketing/stats', async (req, res, next) => {
    try {
      const { data, error } = await supabase.from('users').select('marketing_consent,marketing_unsub_at,deleted_at').limit(100000); if (error) throw error;
      const rows = data || [];
      res.json({ users: rows.length, subscribers: rows.filter((u) => u.marketing_consent && !u.marketing_unsub_at && !u.deleted_at).length });
    } catch (e) { next(e); }
  });
  // Réponse du support : e-mail au client (modèle de service), ticket passé « en attente ».
  r.post('/api/admin/tickets/:id/reply', json, async (req, res, next) => {
    try {
      const msg = String((req.body && req.body.message) || '').trim();
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      if (msg.length < 3 || msg.length > 4000) return res.status(400).json({ error: 'MESSAGE_INVALID' });
      const { data: tk } = await supabase.from('support_tickets').select('email,subject').eq('id', req.params.id).maybeSingle();
      if (!tk) return res.status(404).json({ error: 'Introuvable.' });
      const sent = await mailer.send({ key: `ticket_reply:${req.params.id}:${Date.now()}`, kind: 'ticket_reply', to: tk.email, tpl: T.ticketReply({ subject: tk.subject, reference: req.params.id.slice(0, 8).toUpperCase(), message: msg }) });
      if (sent === 'failed') return res.status(502).json({ error: 'EMAIL_FAILED' });
      await supabase.from('support_tickets').update({ status: 'pending', updated_at: nowIso() }).eq('id', req.params.id);
      audit(req, 'ticket_reply', req.params.id, { length: msg.length });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Comptabilité : état de la synchronisation Pennylane, relance, export CSV pour le comptable.
  r.get('/api/admin/accounting', async (req, res, next) => {
    try {
      const st = String(req.query.status || '');
      let q = supabase.from('invoices').select('id,number,issued_at,buyer_name,buyer_email,buyer_type,amount_ttc_cents,accounting_status,accounting_error,accounting_attempts,details_complete').order('issued_at', { ascending: false }).limit(200);
      if (st) q = q.eq('accounting_status', st);
      const { data, error } = await q; if (error) throw error;
      res.json({ pennylane: d.pennylane.enabled(), items: data || [] });
    } catch (e) { next(e); }
  });
  r.post('/api/admin/accounting/retry', json, async (req, res, next) => {
    try {
      const kind = req.body && req.body.kind === 'credit_note' ? 'credit_note' : 'invoice', id = String((req.body && req.body.id) || '');
      if (!UUID.test(id)) return res.status(400).json({ error: 'ID_INVALID' });
      const out = await d.pennylane.retry(kind, id);
      audit(req, 'accounting_retry', id, { kind });
      res.json(out);
    } catch (e) { next(e); }
  });
  r.get('/api/admin/accounting/export', async (req, res, next) => {
    try {
      const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
      const from = ok(req.query.from) ? req.query.from : '1970-01-01', to = ok(req.query.to) ? req.query.to : '2999-12-31';
      const lo = from + 'T00:00:00.000Z', hi = to + 'T23:59:59.999Z';
      const { data: inv, error } = await supabase.from('invoices').select('*').gte('issued_at', lo).lt('issued_at', hi).order('issued_at', { ascending: true }).limit(20000);
      if (error) throw error;
      const { data: notes } = await supabase.from('credit_notes').select('*').gte('issued_at', lo).lt('issued_at', hi).limit(20000);
      const byId = new Map((inv || []).map((i) => [i.id, i]));
      const { data: allInv } = notes && notes.length ? await supabase.from('invoices').select('id,number').limit(20000) : { data: [] };
      const num = new Map((allInv || []).map((i) => [i.id, i.number]));
      const csv = require('./invoicing').accountingCsv(inv || [], (notes || []).map((n) => ({ ...n, invoice_number: (byId.get(n.invoice_id) || {}).number || num.get(n.invoice_id) })));
      audit(req, 'accounting_export', from + '..' + to, {});
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="eurovin-compta-${from}_${to}.csv"`);
      res.send(csv);
    } catch (e) { next(e); }
  });

  // Export comptable mensuel : synthèse TVA par pays (part=summary, défaut) ou détail des pièces (part=detail).
  r.get('/api/admin/accounting/monthly', async (req, res, next) => {
    try {
      const x = await d.monthly.build(String(req.query.month || ''));
      if (!x) return res.status(400).json({ error: 'MONTH_INVALID' });
      const detail = req.query.part === 'detail';
      audit(req, 'accounting_monthly', x.month, { part: detail ? 'detail' : 'summary' });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${detail ? 'Detail-pieces' : 'TVA-par-pays'}_${x.month}.csv"`);
      res.send(detail ? x.detailCsv : x.summaryCsv);
    } catch (e) { next(e); }
  });
  r.post('/api/admin/accounting/monthly/send', json, async (req, res, next) => {
    try {
      const month = String((req.body && req.body.month) || '');
      const out = await d.monthly.sendMonthly(month, { force: true });
      audit(req, 'accounting_monthly_send', month, { out });
      if (out === 'bad_month') return res.status(400).json({ error: 'MONTH_INVALID' });
      if (out === 'no_recipient') return res.status(409).json({ error: 'NO_RECIPIENT', message: 'Configurez ADMIN_EMAIL (et ACCOUNTANT_EMAIL).' });
      res.json({ ok: out === 'sent', result: out, to: d.monthly.recipients() });
    } catch (e) { next(e); }
  });

  // Marketing : liste des inscrits consentants (prête à importer dans Brevo) + journal des e-mails de service.
  r.get('/api/admin/marketing/export', async (req, res, next) => {
    try {
      const { data, error } = await supabase.from('users').select('email,role,company_name,marketing_consent,marketing_consent_at,marketing_consent_source,marketing_unsub_at,created_at,deleted_at').eq('marketing_consent', true).order('marketing_consent_at', { ascending: true }).limit(100000);
      if (error) throw error;
      const rows = (data || []).filter((u) => !u.marketing_unsub_at && !u.deleted_at);
      const q = (v) => { const t = v == null ? '' : String(v); return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const csv = '\ufeff' + [['EMAIL', 'TYPE', 'ENTREPRISE', 'DATE_CONSENTEMENT', 'SOURCE_CONSENTEMENT', 'DATE_INSCRIPTION'], ...rows.map((u) => [u.email, u.role === 'pro' ? 'professionnel' : 'particulier', u.company_name, u.marketing_consent_at, u.marketing_consent_source, u.created_at])].map((x) => x.map(q).join(';')).join('\r\n') + '\r\n';
      audit(req, 'marketing_export', 'brevo', { count: rows.length });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="inscrits-marketing-${new Date().toISOString().slice(0, 10)}.csv"`);
      res.send(csv);
    } catch (e) { next(e); }
  });
  r.get('/api/admin/emails', async (req, res, next) => {
    try {
      const st = ['sent', 'failed', 'sending'].includes(req.query.status) ? req.query.status : 'failed';
      const { data, error } = await supabase.from('email_log').select('kind,to_email,subject,status,attempts,error,created_at,sent_at').eq('status', st).order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      res.json({ status: st, items: data || [] });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/stats', async (req, res, next) => {
    try {
      const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
      const since = new Date(Date.now() - days * 864e5).toISOString();
      const { data: rows, error } = await supabase.from('orders').select('kind,status,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,dispute_status').gte('created_at', since).limit(10000);
      if (error) throw error;
      const [{ count: tickets }, { count: errs }, { count: failed }] = await Promise.all([
        supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('report_errors').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('orders').select('id', { count: 'exact', head: true }).in('status', ['pending', 'generating']).lt('updated_at', new Date(Date.now() - 15 * 60e3).toISOString()),
      ]);
      res.json({ days, ...P.summarizeOrders(rows || []), open_tickets: tickets || 0, open_report_errors: errs || 0, stuck_orders: failed || 0 });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/orders', async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200), offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      let q = supabase.from('orders').select('id,kind,status,buyer_email,vin,plan,amount_ttc_cents,refunded_cents,dispute_status,last_error,created_at', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      if (req.query.status) q = q.eq('status', String(req.query.status));
      if (req.query.kind) q = q.eq('kind', String(req.query.kind));
      if (req.query.email) q = q.eq('buyer_email', String(req.query.email).toLowerCase());
      if (req.query.vin) q = q.eq('vin', String(req.query.vin).toUpperCase());
      const { data, count, error } = await q;
      if (error) throw error;
      res.json({ total: count, orders: data });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/orders/:id', async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle();
      if (!order) return res.status(404).json({ error: 'Introuvable.' });
      const [invoice, notes, report] = await Promise.all([
        supabase.from('invoices').select('*').eq('order_id', order.id).maybeSingle(),
        supabase.from('credit_notes').select('*').eq('order_id', order.id).order('issued_at'),
        supabase.from('reports').select('id,plan,options_count,data_source,created_at,expires_at').eq('order_id', order.id).maybeSingle(),
      ]);
      res.json({ order, invoice: invoice.data, creditNotes: notes.data, report: report.data });
    } catch (e) { next(e); }
  });

  // Remboursement total ou partiel (montant en centimes TTC). Génère l'avoir et prévient le client.
  r.post('/api/admin/orders/:id/refund', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (reason.length < 3) return res.status(400).json({ error: 'REASON_REQUIRED' });
      const amount = req.body && req.body.amountCents != null ? Number(req.body.amountCents) : null;
      if (amount != null && (!Number.isInteger(amount) || amount <= 0)) return res.status(400).json({ error: 'AMOUNT_INVALID' });
      const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle();
      if (!order) return res.status(404).json({ error: 'Introuvable.' });
      await audit(req, 'refund', order.id, { amount, reason });
      const out = await refundOrder(order, reason, { amountCents: amount, strict: true });
      res.json({ ok: true, ...out });
    } catch (e) {
      if (['AMOUNT_INVALID', 'EXCEEDS_REMAINING', 'NOTHING_TO_REFUND', 'CREDITS_ALREADY_USED', 'NOT_REFUNDABLE'].includes(e.code)) return res.status(409).json({ error: e.code, message: e.message });
      next(e);
    }
  });

  r.post('/api/admin/orders/:id/resend', async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const { data: order } = await supabase.from('orders').select('*').eq('id', req.params.id).maybeSingle();
      const { data: rep } = order ? await supabase.from('reports').select('*').eq('order_id', order.id).maybeSingle() : { data: null };
      if (!order || !rep) return res.status(404).json({ error: 'Rapport introuvable.' });
      await audit(req, 'resend', order.id, null);
      await deliverSafe(order, rep, { force: true });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Relance de la génération d'une commande bloquée.
  r.post('/api/admin/orders/:id/retry', async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const { data: o } = await supabase.from('orders').select('id,status,kind').eq('id', req.params.id).maybeSingle();
      if (!o || o.kind === 'pack') return res.status(404).json({ error: 'Introuvable.' });
      if (!['pending', 'generating'].includes(o.status)) return res.status(409).json({ error: 'NOT_RETRYABLE' });
      await audit(req, 'retry', o.id, null);
      await supabase.from('orders').update({ status: 'pending', updated_at: nowIso() }).eq('id', o.id);
      runOrder(o.id).catch((e) => console.error('retry :', e.message));
      res.status(202).json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/users', async (req, res, next) => {
    try {
      const email = String(req.query.email || '').trim().toLowerCase();
      if (!email) return res.status(400).json({ error: 'EMAIL_REQUIRED' });
      const { data } = await supabase.from('users').select('id,email,phone,role,credits_balance,company_name,company_siret,company_vat,created_at').eq('email', email).maybeSingle();
      if (!data) return res.status(404).json({ error: 'Introuvable.' });
      res.json(data);
    } catch (e) { next(e); }
  });

  // Ajustement de crédits (geste commercial ou correction). Un identifiant d'opération unique évite tout doublon.
  r.post('/api/admin/users/:id/credits', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const delta = Number(req.body && req.body.delta), reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 1000) return res.status(400).json({ error: 'DELTA_INVALID' });
      if (reason.length < 3) return res.status(400).json({ error: 'REASON_REQUIRED' });
      const opId = String((req.body && req.body.opId) || crypto.randomUUID()).slice(0, 80);
      await audit(req, 'credits', req.params.id, { delta, reason, opId });
      const { data, error } = await supabase.rpc('admin_adjust_credits', { p_user: req.params.id, p_delta: delta, p_ref: 'admin:' + opId });
      if (error) { if (error.code === '23514') return res.status(409).json({ error: 'INSUFFICIENT_BALANCE' }); throw error; }
      if (data !== null) {                                                  // pas de doublon d'e-mail si l'opération était déjà appliquée
        const { data: usr } = await supabase.from('users').select('email').eq('id', req.params.id).maybeSingle();
        if (usr) mailer.send({ key: 'credits_adj:' + opId, kind: 'credits_adjusted', to: usr.email, tpl: T.creditsAdjusted({ delta, balance: data, reason }), userId: req.params.id });
      }
      res.json({ ok: true, balance: data, duplicate: data === null, opId });
    } catch (e) { next(e); }
  });

  // Passage en compte Pro, après vérification du SIRET par vous.
  r.post('/api/admin/users/:id/role', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const role = req.body && req.body.role;
      if (!['b2c', 'pro'].includes(role)) return res.status(400).json({ error: 'ROLE_INVALID' });
      await audit(req, 'role', req.params.id, { role });
      const { data: before } = await supabase.from('users').select('email,role').eq('id', req.params.id).maybeSingle();
      const { error } = await supabase.from('users').update({ role }).eq('id', req.params.id);
      if (error) throw error;
      if (role === 'pro' && before && before.role !== 'pro') mailer.send({ key: 'pro_activated:' + req.params.id, kind: 'pro_activated', to: before.email, tpl: T.proActivated(), userId: req.params.id });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/tickets', async (req, res, next) => {
    try {
      let q = supabase.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(100);
      q = q.eq('status', ['open', 'pending', 'closed'].includes(req.query.status) ? req.query.status : 'open');
      const { data, error } = await q; if (error) throw error;
      res.json({ tickets: data });
    } catch (e) { next(e); }
  });
  r.patch('/api/admin/tickets/:id', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id) || !['open', 'pending', 'closed'].includes(req.body && req.body.status)) return res.status(400).json({ error: 'INVALID' });
      await audit(req, 'ticket', req.params.id, { status: req.body.status });
      const { data: tk } = await supabase.from('support_tickets').select('email,subject,status').eq('id', req.params.id).maybeSingle();
      const { error } = await supabase.from('support_tickets').update({ status: req.body.status, updated_at: nowIso() }).eq('id', req.params.id);
      if (error) throw error;
      if (tk && req.body.status === 'closed' && tk.status !== 'closed') mailer.send({ key: 'ticket_closed:' + req.params.id, kind: 'ticket_closed', to: tk.email, tpl: T.ticketClosed({ subject: tk.subject, reference: req.params.id.slice(0, 8).toUpperCase() }) });
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  r.get('/api/admin/report-errors', async (req, res, next) => {
    try {
      const { data, error } = await supabase.from('report_errors').select('id,report_id,error_type,details,status,created_at').eq('status', ['open', 'fixed', 'rejected'].includes(req.query.status) ? req.query.status : 'open').order('created_at', { ascending: false }).limit(100);
      if (error) throw error;
      res.json({ errors: data });
    } catch (e) { next(e); }
  });
  r.patch('/api/admin/report-errors/:id', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id) || !['open', 'fixed', 'rejected'].includes(req.body && req.body.status)) return res.status(400).json({ error: 'INVALID' });
      await audit(req, 'report-error', req.params.id, { status: req.body.status });
      const { error } = await supabase.from('report_errors').update({ status: req.body.status }).eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
