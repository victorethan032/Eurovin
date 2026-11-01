'use strict';
// E-mails de service (modèles, envoi dédoublonné), bienvenue, consentement marketing, désabonnement, export Brevo, relances, export mensuel TVA par pays.
const assert = require('assert'), start = require('./testkit/harness'), makeSupabase = require('./testkit/fake-supabase'), M = require('./mail'), I = require('./invoicing'), createMonthly = require('./monthly');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

(async () => {
  // ---------- modèles (purs) ----------
  const T = M.templates({ appUrl: 'https://eurovin.fr', seller: { name: 'EuroVin SAS', address: '1 rue X, Lyon' } });
  const all = {
    welcome: T.welcome({ marketing: false, unsubUrl: 'u' }), reportPaid: T.reportPaid({ plan: 'premium', vin: 'WBA8E9C50GK123456', ttc: 1299, invoiceNumber: 'EV-2026-000001', cgv: 'v1' }),
    packPaid: T.packPaid({ credits: 10, balance: 10, ttc: 5880, invoiceNumber: 'EV-2026-000002', company: 'Garage' }), reportReady: T.reportReady({ plan: 'essentiel', vin: 'WBA8E9C50GK123456', url: 'https://eurovin.fr/report/x', ttc: 799, cgv: 'v1' }),
    delay: T.delayNotice({ vin: 'V' }), low: T.lowCredits({ balance: 1 }), note: T.creditNote({ amountCents: 1200, number: 'AV-2026-000001' }), cref: T.creditRefund({ plan: 'premium', vin: 'V', credits: 2 }),
    nop: T.refundNoPayment(), pf: T.paymentFailed(), adj: T.creditsAdjusted({ delta: 5, balance: 5, reason: 'Geste' }), pro: T.proActivated(), inc: T.incompleteInvoice({ number: 'EV-1', missing: ['SIREN'] }),
    tr: T.ticketReceived({ subject: 'S', reference: 'ABCD1234' }), tc: T.ticketClosed({ subject: 'S', reference: 'ABCD1234' }), pu: T.profileUpdated({ fields: ['société'] }), mk: T.marketingChanged({ on: true, unsubUrl: 'u' }),
    del: T.accountDeleted(), exp: T.reportExpiring({ vin: 'V', url: 'u', days: 7 }), mon: T.monthlyExport({ month: '2026-09', invoices: 3, notes: 1, anomalies: 0 }),
  };
  ok(Object.values(all).every((t) => t.subject && t.html.includes('<html') && t.text && !/<[a-z]/i.test(t.text)), 'tous les modèles : sujet, HTML et version texte propre');
  ok(Object.values(all).every((t) => /aucune publicité/.test(t.html)), 'bandeau « e-mail de service, aucune publicité » partout');
  ok(!Object.entries(all).some(([k, t]) => k !== 'welcome' && k !== 'mk' && /désabonner|unsubscribe/i.test(t.html)), 'aucun lien de désabonnement dans les e-mails de service (hors accueil / confirmation marketing)');
  const evil = T.reportReady({ plan: 'essentiel', vin: '<script>alert(1)</script>', url: 'https://x"onmouseover="y', ttc: 799, cgv: '<b>' });
  ok(!/<script>/.test(evil.html) && !evil.html.includes('"onmouseover="'), 'données injectées échappées (HTML)');
  ok(all.packPaid.html.includes('HT, la TVA et le TTC') && all.packPaid.html.includes('EV-2026-000002'), 'pack : rappel HT/TVA/TTC et numéro de facture');
  ok(T.welcome({ marketing: true, unsubUrl: 'https://eurovin.fr/desabonnement?t=abc' }).html.includes('desabonnement?t=abc') && /ne recevrez que des e-mails de service/.test(all.welcome.html), 'bienvenue : désabonnement seulement si consentement');
  ok(all.low.subject === 'Il vous reste 1 crédit' && T.lowCredits({ balance: 2 }).subject === 'Il vous reste 2 crédits', 'accords singulier/pluriel');

  // ---------- envoi dédoublonné ----------
  const sb = makeSupabase(), out = []; let failing = false;
  const mailer = M.createMailer({ supabase: sb, resend: { emails: { send: async (m) => { if (failing) throw new Error('down'); out.push(m); } } }, from: 'a@x.fr', appUrl: 'https://x.fr', log: { error() {} } });
  const tpl = { subject: 's', html: '<p>h</p>', text: 'h' };
  ok((await mailer.send({ key: 'k1', kind: 't', to: 'a@b.fr', tpl })) === 'sent' && (await mailer.send({ key: 'k1', kind: 't', to: 'a@b.fr', tpl })) === 'skipped' && out.length === 1, 'même clé : un seul e-mail');
  failing = true; ok((await mailer.send({ key: 'k2', kind: 't', to: 'a@b.fr', tpl })) === 'failed' && sb.db.email_log.find((x) => x.dedupe_key === 'k2').status === 'failed', 'échec Resend : tracé, sans exception');
  failing = false; ok((await mailer.send({ key: 'k2', kind: 't', to: 'a@b.fr', tpl })) === 'sent' && sb.db.email_log.find((x) => x.dedupe_key === 'k2').attempts === 2, 'nouvel essai possible après échec');
  failing = true; for (let i = 0; i < 5; i++) await mailer.send({ key: 'k3', kind: 't', to: 'a@b.fr', tpl }); failing = false;
  ok((await mailer.send({ key: 'k3', kind: 't', to: 'a@b.fr', tpl })) === 'skipped' && sb.db.email_log.find((x) => x.dedupe_key === 'k3').attempts === 3, 'plafond d’essais respecté');
  sb.db.email_log.push({ dedupe_key: 'k4', kind: 't', status: 'sending', attempts: 1, attempted_at: new Date(Date.now() - 3600e3).toISOString() });
  ok((await mailer.send({ key: 'k4', kind: 't', to: 'a@b.fr', tpl })) === 'sent', 'envoi interrompu depuis > 10 min : repris');
  sb.db.email_log.push({ dedupe_key: 'k5', kind: 't', status: 'sending', attempts: 1, attempted_at: new Date().toISOString() });
  ok((await mailer.send({ key: 'k5', kind: 't', to: 'a@b.fr', tpl })) === 'skipped', 'envoi en cours : pas de doublon');
  ok((await mailer.send({ key: 'k6', kind: 't', to: [], tpl })) === 'skipped', 'sans destinataire : ignoré');
  ok(out.every((m) => m.text && m.html), 'HTML + texte envoyés');

  // ---------- export mensuel (unitaire) ----------
  const sb2 = makeSupabase(), sent2 = [];
  const mailer2 = M.createMailer({ supabase: sb2, resend: { emails: { send: async (m) => { sent2.push(m); } } }, from: 'a@x.fr', appUrl: 'https://x.fr' });
  const pm = I.previousMonth(new Date('2026-10-05T10:00:00Z')), b = I.monthBounds(pm);
  sb2.db.invoices.push({ id: 'i1', number: 'EV-2026-000001', issued_at: '2026-09-15T10:00:00Z', buyer_country: 'FR', vat_regime: 'standard', vat_rate: 20, amount_ht_cents: 4900, amount_tax_cents: 980, amount_ttc_cents: 5880, buyer_email: 'a@x.fr', accounting_status: 'synced' },
    { id: 'i2', number: 'EV-2026-000002', issued_at: '2026-09-20T10:00:00Z', buyer_country: 'DE', vat_regime: 'reverse_charge', vat_rate: 0, amount_ht_cents: 4900, amount_tax_cents: 0, amount_ttc_cents: 4900, buyer_email: 'b@x.de', accounting_status: 'needs_review' },
    { id: 'i3', number: 'EV-2026-000003', issued_at: '2026-10-02T10:00:00Z', buyer_country: 'FR', vat_regime: 'standard', vat_rate: 20, amount_ht_cents: 833, amount_tax_cents: 166, amount_ttc_cents: 999, buyer_email: 'c@x.fr' });
  sb2.db.credit_notes.push({ id: 'n1', number: 'AV-2026-000001', invoice_id: 'i1', issued_at: '2026-09-25T10:00:00Z', buyer_country: 'FR', vat_regime: 'standard', vat_rate: 20, amount_ht_cents: 1000, amount_tax_cents: 200, amount_ttc_cents: 1200, buyer_email: 'a@x.fr' });
  const mo = createMonthly({ supabase: sb2, mailer: mailer2, env: { ADMIN_EMAIL: 'admin@x.fr', ACCOUNTANT_EMAIL: 'compta@cabinet.fr, ' } });
  const x = await mo.build('2026-09');
  ok(pm === '2026-09' && x.invoices === 2 && x.notes === 1 && x.anomalies === 1, 'mois de septembre : 2 factures, 1 avoir, 1 anomalie (hors octobre)');
  ok(x.summaryCsv.includes('2026-09;DE;reverse_charge;0;1;0;49,00;0,00;49,00') && x.summaryCsv.includes('2026-09;FR;standard;20;1;1;49,00;9,80;58,80;-10,00;-2,00;-12,00;39,00;7,80;46,80') && x.summaryCsv.includes('TOTAL;;;2;1;98,00;9,80;107,80'), 'synthèse TVA par pays : factures − avoirs = net');
  ok(x.detailCsv.includes('Avoir;AV-2026-000001;2026-09-25;EV-2026-000001'), 'détail : avoir rattaché à sa facture');
  ok(mo.recipients().join() === 'admin@x.fr,compta@cabinet.fr', 'destinataires : admin + comptable');
  ok((await mo.sweepMonthly(new Date('2026-10-01T10:00:00Z'))) === 'too_early' && sent2.length === 0, 'cron le 1er du mois : attend le 2');
  ok((await mo.sweepMonthly(new Date('2026-10-02T10:00:00Z'))) === 'sent' && sent2.length === 1 && sent2[0].attachments.length === 2 && /Export comptable 2026-09/.test(sent2[0].subject), 'cron le 2 : export de septembre envoyé avec 2 CSV');
  ok((await mo.sweepMonthly(new Date('2026-10-20T10:00:00Z'))) === 'skipped' && sent2.length === 1, 'jamais deux fois pour le même mois');
  ok((await mo.build('2026-9')) === null && (await mo.sendMonthly('xx')) === 'bad_month', 'mois invalide refusé');

  // ---------- parcours complet avec le VRAI serveur ----------
  const h = await start({ env: { ADMIN_EMAIL: 'admin@x.fr', ACCOUNTANT_EMAIL: 'compta@cabinet.fr', BREVO_WEBHOOK_SECRET: 'b'.repeat(24), SELLER_NAME: 'EuroVin SAS', SELLER_LEGAL_FORM: 'SAS', SELLER_SIREN: '123456789', SELLER_RCS: 'Lyon', SELLER_ADDRESS: '1 rue X', SELLER_VAT: 'FR12123456789', LOW_CREDITS_THRESHOLD: '2' } });
  const B = h.base, db = h.supabase.db, AK = { 'x-admin-key': 'a'.repeat(40) };
  const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const patch = (p, body, headers = {}) => fetch(B + p, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const get = (p, headers = {}) => fetch(B + p, { headers }).then(J);
  const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } throw new Error('timeout ' + fn.toString().slice(0, 100) + ' | ' + h.sent.map((m) => m.to + ':' + m.subject).join(' / ')); };
  const gt = (p, body) => fetch(h.gotrueUrl + '/auth/v1/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(J);
  const mails = (to, re) => h.sent.filter((m) => m.to.includes(to) && (!re || re.test(m.subject)));
  try {
    // bienvenue + consentement à l'inscription
    const s1 = await gt('signup', { email: 'pro@garage.fr', password: 'motdepasse-long', data: { marketing_optin: true } }); const A = { authorization: 'Bearer ' + s1.body.access_token };
    ok(mails('pro@garage.fr').length === 0, 'aucun e-mail avant la première visite');
    await get('/api/me', A); const w = await waitFor(() => mails('pro@garage.fr', /Bienvenue/)[0]);
    const u1 = db.users.find((u) => u.email === 'pro@garage.fr');
    ok(w.html.includes('/desabonnement?t=' + u1.unsub_token) && u1.marketing_consent === true && u1.marketing_consent_source === 'signup' && u1.marketing_consent_at, 'accueil + consentement marketing enregistré (source : inscription)');
    ok(db.consent_events.some((e) => e.email === 'pro@garage.fr' && e.action === 'grant' && e.source === 'signup'), 'preuve de consentement journalisée');
    await get('/api/me', A); await get('/api/me', A); await sleep(200);
    ok(mails('pro@garage.fr', /Bienvenue/).length === 1, 'un seul e-mail de bienvenue');
    ok(w.text && w.reply_to === undefined && w.from, 'texte brut joint');
    const s2 = await gt('signup', { email: 'simple@x.fr', password: 'motdepasse-long' }); const A2 = { authorization: 'Bearer ' + s2.body.access_token };
    await get('/api/me', A2); const w2 = await waitFor(() => mails('simple@x.fr', /Bienvenue/)[0]);
    ok(w2.html.includes('ne recevrez que des e-mails de service') && db.users.find((u) => u.email === 'simple@x.fr').marketing_consent === false, 'sans case cochée : aucun consentement, e-mails de service seulement');

    // désabonnement
    const tok = u1.unsub_token;
    let r = await fetch(B + '/desabonnement?t=' + tok); const pg = await r.text();
    ok(r.status === 200 && pg.includes('Me désabonner') && pg.includes('p•••@garage.fr') && !pg.includes('pro@garage.fr') && u1.marketing_consent === true, 'GET : page de confirmation, aucun effet');
    ok((await fetch(B + '/desabonnement?t=' + 'z'.repeat(40))).status === 200 && (await fetch(B + '/desabonnement?t=' + 'z'.repeat(40)).then((x) => x.text())).includes('Lien invalide'), 'lien invalide signalé');
    r = await fetch(B + '/desabonnement?t=' + tok, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    ok(r.status === 200 && u1.marketing_consent === false && u1.marketing_unsub_at && db.consent_events.some((e) => e.action === 'withdraw' && e.source === 'unsubscribe_link'), 'POST (un clic) : désabonné + preuve');
    ok((await fetch(B + '/desabonnement?t=' + 'z'.repeat(40), { method: 'POST' })).status === 404, 'POST avec jeton invalide : 404');

    // préférences dans Mon espace
    const pf = await patch('/api/me', { marketing: true }, A);
    ok(pf.status === 200 && u1.marketing_consent === true && u1.marketing_consent_source === 'account', 'réinscription depuis Mon espace');
    await waitFor(() => mails('pro@garage.fr', /inscrit à nos actualités/)[0]);
    await patch('/api/me', { company_name: 'Garage Dupont SARL', company_siret: '73282932000074', company_vat: 'FR40732829320' }, A);
    const pu = await waitFor(() => mails('pro@garage.fr', /informations ont été modifiées/)[0]);
    ok(/société/.test(pu.html) && /SIRET/.test(pu.html) && /n° de TVA/.test(pu.html), 'e-mail récapitulatif de modification de profil');
    const nPu = mails('pro@garage.fr', /informations ont été modifiées/).length;
    await patch('/api/me', { company_name: 'Garage Dupont SARL', company_siret: '73282932000074' }, A); await sleep(200);
    ok(mails('pro@garage.fr', /informations ont été modifiées/).length === nPu, 'aucune modification réelle : aucun e-mail');

    // achat de pack : confirmation + facture
    const sidP = (await post('/api/checkout', { kind: 'pack', packSize: 10, consent: { cgv: true } }, A)).body.url.split('/').pop();
    await h.payWebhook(sidP, { email: 'pro@garage.fr', details: { name: 'Jean', address: { line1: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'FR' } } });
    const pk = await waitFor(() => mails('pro@garage.fr', /10 crédits ajoutés/)[0]);
    ok(pk.attachments.length === 1 && /^Facture_EV-/.test(pk.attachments[0].filename) && pk.html.includes('10 crédits') && pk.html.includes('Garage Dupont SARL'), 'pack : e-mail récapitulatif avec facture (PDF)');
    await h.payWebhook(sidP, { email: 'pro@garage.fr', eventId: 'evt_again' }); await sleep(200);
    ok(mails('pro@garage.fr', /10 crédits ajoutés/).length === 1, 'paiement rejoué : pas de second e-mail');

    // gestes admin
    const uid = u1.id;
    let adj = await post(`/api/admin/users/${uid}/credits`, { delta: -8, reason: 'Correction de test', opId: 'op-1' }, AK);
    ok(adj.status === 200, 'ajustement admin');
    const ma = await waitFor(() => mails('pro@garage.fr', /Ajustement/)[0]);
    ok(/Correction de test/.test(ma.html) && /retiré/.test(ma.html) && /2 crédits/.test(ma.html), 'ajustement de crédits : e-mail avec motif et solde');
    await post(`/api/admin/users/${uid}/credits`, { delta: -8, reason: 'Correction de test', opId: 'op-1' }, AK); await sleep(200);
    ok(mails('pro@garage.fr', /Ajustement/).length === 1, 'même opération rejouée : pas de second e-mail');
    await post(`/api/admin/users/${uid}/role`, { role: 'pro' }, AK); await waitFor(() => mails('pro@garage.fr', /compte Pro est activé/)[0]);
    await post(`/api/admin/users/${uid}/role`, { role: 'pro' }, AK); await sleep(150);
    ok(mails('pro@garage.fr', /compte Pro est activé/).length === 1, 'activation Pro : e-mail une seule fois');

    // alerte solde faible : 2 crédits -> un rapport Essentiel -> 1 crédit
    const rr = await post('/api/reports', { vin: 'WBA8E9C50GK222222', plan: 'essentiel' }, { ...A, 'idempotency-key': 'low-1' });
    ok(rr.status === 202, 'rapport par crédits');
    const lw = await waitFor(() => mails('pro@garage.fr', /Il vous reste 1 crédit/)[0]);
    ok(/Recharger/.test(lw.html), 'alerte Pro : solde faible');
    const rd = await waitFor(() => mails('pro@garage.fr', /Votre rapport — VIN/)[0]);
    ok(/Crédits débités/.test(rd.html) && /Solde restant/.test(rd.html), 'rapport par crédits : récapitulatif du débit et du solde');

    // support
    const tk = await post('/api/support', { email: 'cli@x.fr', subject: db.support_tickets.length ? 'Autre' : 'Autre', message: 'Bonjour, ceci est une question assez longue.' });
    ok(tk.status === 201, 'ticket créé (' + JSON.stringify(tk.body) + ')');
    const rec = await waitFor(() => mails('cli@x.fr', /bien reçu votre message/)[0]);
    ok(rec.html.includes(String(tk.body.ticket).slice(0, 8).toUpperCase()), 'accusé de réception avec référence');
    await patch(`/api/admin/tickets/${tk.body.ticket}`, { status: 'closed' }, AK); await waitFor(() => mails('cli@x.fr', /demande est traitée/)[0]);
    await patch(`/api/admin/tickets/${tk.body.ticket}`, { status: 'closed' }, AK); await sleep(150);
    ok(mails('cli@x.fr', /demande est traitée/).length === 1, 'clôture de ticket : e-mail une seule fois');

    // remboursement d'un rapport payé + avoir
    const sidR = (await post('/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK333333', plan: 'essentiel', email: 'r@x.fr', consent: { cgv: true, waiver: true } })).body.url.split('/').pop();
    await h.payWebhook(sidR, { email: 'r@x.fr' });
    await waitFor(() => mails('r@x.fr', /Votre rapport — VIN/)[0]);
    ok(mails('r@x.fr', /Paiement reçu/).length === 1, 'rapport payé : confirmation de paiement + rapport = 2 e-mails distincts');
    const ord = db.orders.find((o) => o.stripe_session_id === sidR);
    ok((await post(`/api/admin/orders/${ord.id}/refund`, { reason: 'Geste commercial' }, AK)).status === 200, 'remboursement admin');
    const cn = await waitFor(() => mails('r@x.fr', /avoir/i)[0]);
    ok(cn.attachments.length === 1 && /^Avoir_AV-/.test(cn.attachments[0].filename), 'avoir envoyé en PDF');
    const n1 = mails('r@x.fr').length; await post(`/api/admin/orders/${ord.id}/resend`, {}, AK); await waitFor(() => mails('r@x.fr').length > n1);
    ok(mails('r@x.fr', /Votre rapport — VIN/).length === 2, 'renvoi manuel du rapport par l’admin : nouvel e-mail');

    // panne Resend : la commande n'est jamais bloquée, rattrapage au rejeu
    h.flags.mailFail = true;
    const sidF = (await post('/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK444444', plan: 'essentiel', email: 'f@x.fr', consent: { cgv: true, waiver: true } })).body.url.split('/').pop();
    const wf = await h.payWebhook(sidF, { email: 'f@x.fr' });
    ok(db.orders.some((o) => o.stripe_session_id === sidF) && db.invoices.some((i) => i.buyer_email === 'f@x.fr'), 'Resend en panne : commande et facture enregistrées quand même');
    ok(db.email_log.some((e) => /paid:/.test(e.dedupe_key) && e.to_email === 'f@x.fr' && e.status === 'failed'), 'échec tracé dans le journal');
    h.flags.mailFail = false;
    const lf = (await fetch(B + '/api/admin/emails?status=failed', { headers: AK }).then(J)).body;
    ok(lf.items.some((i) => i.to_email === 'f@x.fr'), 'admin : liste des e-mails en échec');
    await h.payWebhook(sidF, { email: 'f@x.fr', eventId: 'evt_retry_f' });
    await waitFor(() => mails('f@x.fr', /Paiement reçu/)[0]);
    ok(true, 'rattrapage : e-mail de paiement envoyé au rejeu du webhook');

    // relances (cron)
    db.orders.push({ id: 'late-1', kind: 'report', status: 'pending', buyer_email: 'late@x.fr', vin: 'WBA8E9C50GK555555', plan: 'essentiel', created_at: new Date(Date.now() - 3600e3).toISOString(), updated_at: new Date().toISOString(), attempts: 0, email_attempts: 0, refunded_cents: 0 });
    db.reports.push({ id: 'rep-exp', order_id: ord.id, vin: 'WBA8E9C50GK333333', access_token: 'e'.repeat(48), expires_at: new Date(Date.now() + 3 * 864e5).toISOString() });
    const sw = await fetch(B + '/api/jobs/sweep', { method: 'POST', headers: { 'x-cron-secret': 'c'.repeat(32) } });
    ok(sw.status === 200, 'cron OK');
    ok(mails('late@x.fr', /plus de temps/).length === 1, 'relance : commande en retard');
    const ex = mails('r@x.fr', /expire dans/)[0];
    ok(ex && ex.html.includes('/report/' + 'e'.repeat(48)), 'relance : rapport bientôt supprimé');
    await fetch(B + '/api/jobs/sweep', { method: 'POST', headers: { 'x-cron-secret': 'c'.repeat(32) } });
    ok(mails('late@x.fr', /plus de temps/).length === 1 && mails('r@x.fr', /expire dans/).length === 1, 'relances jamais envoyées deux fois');

    // export Brevo
    const csv = await fetch(B + '/api/admin/marketing/export', { headers: AK }).then((x) => x.text());
    ok(csv.includes('EMAIL;TYPE;ENTREPRISE;DATE_CONSENTEMENT') && csv.includes('pro@garage.fr;professionnel;Garage Dupont SARL;') && !csv.includes('simple@x.fr'), 'export Brevo : consentants uniquement');
    ok((await fetch(B + '/api/admin/marketing/export').then(J)).status === 401, 'export Brevo protégé');
    ok((await post('/api/webhooks/brevo', { event: 'unsubscribe', email: 'pro@garage.fr' }, { 'x-webhook-secret': 'bad' })).status === 401, 'webhook Brevo : mauvais secret refusé');
    ok((await post('/api/webhooks/brevo', { event: 'unsubscribed', email: 'pro@garage.fr' }, { 'x-webhook-secret': 'b'.repeat(24) })).status === 200 && u1.marketing_consent === false && db.consent_events.some((e) => e.source === 'brevo'), 'webhook Brevo : désabonnement répercuté');
    const csv2 = await fetch(B + '/api/admin/marketing/export', { headers: AK }).then((x) => x.text());
    ok(!csv2.includes('pro@garage.fr'), 'désabonné : retiré de la liste');

    // export mensuel via l'API
    const cur = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    const ms = await fetch(B + '/api/admin/accounting/monthly?month=' + cur, { headers: AK }); const mt = await ms.text();
    ok(ms.status === 200 && mt.includes(`${cur};FR;standard;20;`) && mt.includes('TOTAL'), 'API : synthèse TVA par pays du mois');
    ok((await fetch(B + '/api/admin/accounting/monthly?month=' + cur + '&part=detail', { headers: AK }).then((x) => x.text())).includes('Facture;EV-'), 'API : détail du mois');
    ok((await fetch(B + '/api/admin/accounting/monthly?month=2026-13', { headers: AK })).status === 400, 'API : mois invalide');
    const sm = await post('/api/admin/accounting/monthly/send', { month: cur }, AK);
    const em = h.sent.find((m) => /Export comptable/.test(m.subject));
    ok(sm.body.ok && em && em.to.includes('compta@cabinet.fr') && em.to.includes('admin@x.fr') && em.attachments.length === 2, 'envoi manuel de l’export au comptable');

    // suppression de compte
    const del = await fetch(B + '/api/me', { method: 'DELETE', headers: { 'content-type': 'application/json', ...A2 }, body: JSON.stringify({ confirm: 'SUPPRIMER' }) });
    ok(del.status === 200 && mails('simple@x.fr', /compte a été supprimé/).length === 1, 'suppression de compte : e-mail de confirmation');
  } finally { h.close(); }
  console.log(`e-mails : ${pass} vérifications OK`);
  process.exit(0);
})().catch((e) => { console.error(`ÉCHEC après ${pass} vérifications :`, e); process.exit(1); });
