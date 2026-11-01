'use strict';
/** Espace client (API) : profil, achats, factures, avoirs, moyens de paiement, export et suppression RGPD, support. */
const express = require('express');
const P = require('./payments');
const lib = require('./lib');

module.exports = function accountRouter(d) {
  const { supabase, stripe, authUser, limiter, appUrl, nowIso, buildInvoicePdf, buildCreditNotePdf, sellerFromEnv, alertAdmin, mailer, setMarketing } = d;
  const crypto = require('crypto');
  const T = mailer.T;
  const r = express.Router();
  const json = express.json({ limit: '10kb' });
  const mustUser = async (req, res) => { const u = await authUser(req); if (!u) res.status(401).json({ error: 'Non authentifié.' }); return u; };
  const pdf = (res, name, buf) => res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }).send(buf);

  // Jeton de désabonnement (créé à la demande si absent) et URL de désabonnement.
  const unsubToken = async (id) => {
    const { data } = await supabase.from('users').select('unsub_token').eq('id', id).maybeSingle();
    if (data && data.unsub_token) return data.unsub_token;
    const t = crypto.randomBytes(24).toString('hex'); await supabase.from('users').update({ unsub_token: t }).eq('id', id); return t;
  };
  // Bienvenue : une seule fois par compte, à la première visite de l'espace client. Le consentement marketing vient de la case cochée à l'inscription.
  async function welcomeOnce(u) {
    const { data: row } = await supabase.from('users').select('welcome_sent_at,marketing_consent').eq('id', u.id).maybeSingle();
    if (!row || row.welcome_sent_at) return;
    const { data: claimed } = await supabase.from('users').update({ welcome_sent_at: nowIso() }).eq('id', u.id).is('welcome_sent_at', null).select();
    if (!claimed || !claimed.length) return;                                              // pris par une autre requête
    const optin = !!(u.user_metadata && u.user_metadata.marketing_optin === true);
    if (optin && !row.marketing_consent) await setMarketing({ email: (u.email || '').toLowerCase() }, true, 'signup');
    const token = await unsubToken(u.id);
    const r = await mailer.send({ key: 'welcome:' + u.id, kind: 'welcome', to: u.email, tpl: T.welcome({ marketing: optin || !!row.marketing_consent, unsubUrl: `${appUrl}/desabonnement?t=${token}` }), userId: u.id });
    if (r === 'failed') await supabase.from('users').update({ welcome_sent_at: null }).eq('id', u.id);   // réessayé à la prochaine visite
  }

  r.get('/api/me', limiter, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      welcomeOnce(u).catch((e) => console.error('Bienvenue :', e.message));
      const [{ data: prof }, { data: orders }, { data: reports }] = await Promise.all([
        supabase.from('users').select('email,phone,role,credits_balance,company_name,company_siret,company_vat,marketing_consent').eq('id', u.id).maybeSingle(),
        supabase.from('orders').select('id,kind,status,vin,plan,credits_delta,amount_ttc_cents,refunded_cents,created_at').eq('user_id', u.id).order('created_at', { ascending: false }).limit(100),
        supabase.from('reports').select('order_id,access_token,vin,plan,created_at,expires_at').eq('user_id', u.id).gt('expires_at', nowIso()).order('created_at', { ascending: false }).limit(100),
      ]);
      const ids = (orders || []).map((o) => o.id);
      const { data: invoices } = ids.length ? await supabase.from('invoices').select('number,order_id,issued_at,amount_ttc_cents').in('order_id', ids) : { data: [] };
      const { data: notes } = ids.length ? await supabase.from('credit_notes').select('number,order_id,issued_at,amount_ttc_cents').in('order_id', ids) : { data: [] };
      res.set('Cache-Control', 'no-store').json({ profile: prof, orders: orders || [], reports: reports || [], invoices: invoices || [], creditNotes: notes || [] });
    } catch (e) { next(e); }
  });

  r.patch('/api/me', limiter, json, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      const body = { ...(req.body || {}) }, hasMk = typeof body.marketing === 'boolean', mk = body.marketing; delete body.marketing;
      const onlyMk = hasMk && !Object.keys(body).length;
      const v = onlyMk ? { ok: true, value: {} } : P.validateProfilePatch(body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const { data: before } = await supabase.from('users').select('phone,company_name,company_siret,company_vat,marketing_consent,email').eq('id', u.id).maybeSingle();
      if (Object.keys(v.value).length) { const { error } = await supabase.from('users').update(v.value).eq('id', u.id); if (error) throw error; }
      const LABEL = { phone: 'téléphone', company_name: 'société', company_siret: 'SIRET', company_vat: 'n° de TVA' };
      const changed = before ? Object.keys(v.value).filter((k) => (before[k] || null) !== (v.value[k] || null)).map((k) => LABEL[k]) : [];
      if (changed.length) mailer.send({ key: `profile:${u.id}:${Date.now()}`, kind: 'profile_updated', to: u.email, tpl: T.profileUpdated({ fields: changed }), userId: u.id });
      if (hasMk && before && !!before.marketing_consent !== mk) {
        await setMarketing({ email: (before.email || u.email).toLowerCase() }, mk, 'account');
        const token = await unsubToken(u.id);
        mailer.send({ key: `marketing:${u.id}:${Date.now()}`, kind: 'marketing_changed', to: u.email, tpl: T.marketingChanged({ on: mk, unsubUrl: `${appUrl}/desabonnement?t=${token}` }), userId: u.id });
      }
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // PDF d'une facture ou d'un avoir : uniquement pour son propriétaire.
  const ownedOrder = async (orderId, userId) => (await supabase.from('orders').select('id').eq('id', orderId).eq('user_id', userId).maybeSingle()).data;
  r.get('/api/invoices/:number/pdf', limiter, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      if (!/^EV-\d{4}-\d{6}$/.test(req.params.number)) return res.status(404).json({ error: 'Introuvable.' });
      const { data: inv } = await supabase.from('invoices').select('*').eq('number', req.params.number).maybeSingle();
      if (!inv || !(await ownedOrder(inv.order_id, u.id))) return res.status(404).json({ error: 'Introuvable.' });
      pdf(res, `Facture_${inv.number}.pdf`, await buildInvoicePdf(inv, sellerFromEnv()));
    } catch (e) { next(e); }
  });
  r.get('/api/credit-notes/:number/pdf', limiter, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      if (!/^AV-\d{4}-\d{6}$/.test(req.params.number)) return res.status(404).json({ error: 'Introuvable.' });
      const { data: n } = await supabase.from('credit_notes').select('*').eq('number', req.params.number).maybeSingle();
      if (!n || !(await ownedOrder(n.order_id, u.id))) return res.status(404).json({ error: 'Introuvable.' });
      const { data: inv } = n.invoice_id ? await supabase.from('invoices').select('number').eq('id', n.invoice_id).maybeSingle() : { data: null };
      pdf(res, `Avoir_${n.number}.pdf`, await buildCreditNotePdf(n, inv, sellerFromEnv()));
    } catch (e) { next(e); }
  });

  // Modifier son moyen de paiement : portail Stripe (aucune donnée de carte ne passe par nos serveurs).
  r.post('/api/billing/portal', limiter, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      const customerId = await d.getOrCreateCustomer(u);
      const s = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: `${appUrl}/mon-espace` });
      res.json({ url: s.url });
    } catch (e) { next(e); }
  });

  // Export RGPD (droit d'accès / portabilité).
  r.get('/api/me/export', limiter, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      const [prof, orders, reports, ledger, tickets] = await Promise.all([
        supabase.from('users').select('email,phone,role,credits_balance,company_name,company_siret,company_vat,created_at').eq('id', u.id).maybeSingle(),
        supabase.from('orders').select('id,kind,status,vin,plan,amount_ttc_cents,refunded_cents,consent,created_at').eq('user_id', u.id),
        supabase.from('reports').select('vin,plan,vehicle,options,valuation,created_at,expires_at').eq('user_id', u.id),
        supabase.from('credit_ledger').select('delta,reason,created_at').eq('user_id', u.id),
        supabase.from('support_tickets').select('subject,message,status,created_at').eq('user_id', u.id),
      ]);
      res.set({ 'Content-Disposition': 'attachment; filename="mes-donnees-eurovin.json"', 'Cache-Control': 'no-store' })
        .json({ exportedAt: nowIso(), profile: prof.data, orders: orders.data, reports: reports.data, creditLedger: ledger.data, supportTickets: tickets.data });
    } catch (e) { next(e); }
  });

  // Suppression du compte : rapports supprimés ; factures, avoirs et commandes conservés 10 ans (obligation comptable), détachés du compte.
  r.delete('/api/me', limiter, json, async (req, res, next) => {
    try {
      const u = await mustUser(req, res); if (!u) return;
      if (!req.body || req.body.confirm !== 'SUPPRIMER') return res.status(400).json({ error: 'CONFIRMATION_REQUIRED' });
      const { data: prof } = await supabase.from('users').select('credits_balance').eq('id', u.id).maybeSingle();
      if (prof && prof.credits_balance > 0 && req.body.acceptLoseCredits !== true) return res.status(409).json({ error: 'CREDITS_REMAIN', credits: prof.credits_balance });
      await mailer.send({ key: 'deleted:' + u.id, kind: 'account_deleted', to: u.email, tpl: T.accountDeleted() });
      await supabase.from('reports').delete().eq('user_id', u.id);
      await supabase.from('recall_watches').delete().eq('user_id', u.id).then(() => {}, () => {});   // alertes rappel : e-mail et VIN supprimés avec le compte
      await supabase.from('orders').update({ user_id: null }).eq('user_id', u.id);
      await supabase.from('support_tickets').update({ user_id: null }).eq('user_id', u.id);
      const { error } = await supabase.auth.admin.deleteUser(u.id);   // supprime aussi la ligne public.users
      if (error) throw error;
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  /* ---- Support et signalements (publics, limités) ---- */
  r.post('/api/support', limiter, json, async (req, res, next) => {
    try {
      const v = P.validateTicket(req.body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      let userId = null;
      if (req.headers.authorization) { const u = await authUser(req); if (u) userId = u.id; }
      const { data, error } = await supabase.from('support_tickets').insert({ ...v.value, user_id: userId }).select('id').single();
      if (error) throw error;
      mailer.send({ key: 'ticket:' + data.id, kind: 'ticket_received', to: v.value.email, tpl: T.ticketReceived({ subject: v.value.subject, reference: String(data.id).slice(0, 8).toUpperCase() }), userId });
      alertAdmin(`Nouveau message support : ${v.value.subject}`, `<p>${v.value.email}</p><p>${String(v.value.message).replace(/</g, '&lt;')}</p>`);
      res.status(201).json({ ok: true, ticket: data.id });
    } catch (e) { next(e); }
  });

  r.post('/api/reports/:token/error', limiter, json, async (req, res, next) => {
    try {
      if (!/^[a-f0-9]{48}$/.test(req.params.token)) return res.status(404).json({ error: 'Introuvable.' });
      const v = P.validateReportError(req.body);
      if (!v.ok) return res.status(400).json({ error: v.error });
      const { data: rep } = await supabase.from('reports').select('id').eq('access_token', req.params.token).gt('expires_at', nowIso()).maybeSingle();
      if (!rep) return res.status(404).json({ error: 'Introuvable.' });
      const { error } = await supabase.from('report_errors').insert({ report_id: rep.id, error_type: v.value.type, details: v.value.details });
      if (error) throw error;
      res.status(201).json({ ok: true });
    } catch (e) { next(e); }
  });

  return r;
};
