'use strict';
// Test du VRAI server.js (routes, rapport v2, PDF, e-mails, remboursement auto, crédits, admin) avec de faux services.
const assert = require('assert'), start = require('./testkit/harness');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });

(async () => {
  const h = await start();
  const B = h.base, db = h.supabase.db;
  const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const get = (p, headers = {}) => fetch(B + p, { headers }).then(J);
  const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(80); } throw new Error('timeout'); };
  const buy = async (plan, vin, email = 'client@exemple.fr') => {
    const r = await post('/api/checkout', { kind: 'report', vin, plan, email, consent: { cgv: true, waiver: true } });
    ok(r.status === 200 && /\/__stripe\/cs_test_/.test(r.body.url), 'checkout renvoie une URL Stripe');
    const sid = r.body.url.split('/').pop();
    await h.payWebhook(sid, { email });
    return sid;
  };
  try {
    // --- pages et configuration ---
    let r = await fetch(B + '/'); ok(r.status === 200 && (await r.text()).includes('Enfin lisible'), 'accueil servi');
    r = await fetch(B + '/report/' + 'a'.repeat(48)); ok(r.status === 200 && (await r.text()).includes('<html'), 'adresse de rapport -> index.html');
    r = await fetch(B + '/report/zzz'); ok(r.status === 404, 'adresse de rapport invalide -> 404');
    r = await fetch(B + '/config.js'); const cfg = await r.text(); ok(cfg.startsWith('window.EV_CONFIG=') && !cfg.includes('SUPABASE_SERVICE') && cfg.includes('anon'), 'config publique sans clé secrète');
    ok((await get('/health')).body.ok, 'health');
    r = await get('/app.js'); ok(r.status === 200, 'app.js servi');

    // --- aperçu gratuit ---
    ok((await post('/api/preview', { vin: 'WBA8E9C50GK123456' })).body.brand === 'BMW', 'aperçu : marque lue dans le VIN');
    ok((await post('/api/preview', { vin: 'ZHWUC1ZF3LLA12345' })).body.brand === 'Lamborghini', 'aperçu : Lamborghini');
    { const pv = (await post('/api/preview', { vin: 'WBA8E9C50GK123456' })).body; ok(pv.country === 'Allemagne' && pv.modelYear && pv.modelYear.likely === 2016, 'aperçu : pays du constructeur et année indicative lus dans le VIN'); }
    ok((await post('/api/preview', { vin: 'WBA8E9C50GK12345' })).status === 400, 'aperçu : VIN trop court refusé');
    ok((await post('/api/preview', { vin: '1HGCM82633A004352' })).body.error === 'VIN_NON_EU', 'aperçu : VIN hors Europe refusé');

    // --- validation du checkout ---
    ok((await post('/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK123456', plan: 'premium', email: 'a@b.fr', consent: { cgv: true } })).body.error === 'WAIVER_REQUIRED', 'renonciation obligatoire');

    // --- achat Premium complet ---
    const sidP = await buy('premium', 'WBA8E9C50GK123456');
    let st = await waitFor(async () => { const s = (await get('/api/checkout/status?session_id=' + sidP)).body; return s.reportToken ? s : null; });
    ok(st.plan === 'premium', 'statut : rapport prêt avec jeton');
    const tok = st.reportToken;
    const rep = (await get('/api/reports/' + tok)).body;
    const R = rep.report;
    ok(R && R.version === 2 && R.plan === 'premium', 'rapport v2 présent');
    ok(rep.reference.startsWith('RP-'), 'référence');
    ok(R.options.count === 14, '14 options');
    ok(R.options.items.find((o) => o.code === 'C01').label === 'Climatisation automatique', 'traduction DE -> FR (glossaire)');
    ok(R.options.items.find((o) => o.code === 'C14').labelStatus === 'original', 'libellé inconnu conservé et signalé');
    ok(db.untranslated_labels.some((x) => x.code === 'C14'), 'libellé non traduit mis en file de travail');
    ok(R.options.totalCents === R.options.items.reduce((a, o) => a + (o.priceCents || 0), 0) && R.options.unpricedCount === 1, 'total catalogue et option sans prix');
    ok(R.techSheet.sections.length >= 4 && R.techSheet.sections.some((s) => s.rows.some((x) => x.k === 'Puissance' && x.v.includes('190 ch'))), 'fiche technique');
    ok(R.recalls.status === 'found' && R.recalls.items.length === 1, 'rappels');
    ok(R.provenance.status === 'ok' && R.provenance.damage.status === 'none_found', 'provenance Premium');
    ok(R.comparison.status === 'ok' && R.comparison.missingCount > 0 && R.comparison.equippedPct > 0 && R.comparison.equippedPct < 100, 'comparatif');
    ok(R.valuation === null, 'pas de cotation au lancement');
    ok(R.notices.some((n) => /sans prix/.test(n)) && R.notices.some((n) => /langue d’origine/.test(n)), 'avertissements honnêtes');
    ok(!JSON.stringify(rep).includes('client@exemple.fr'), "le rapport public n'expose pas l'e-mail de l'acheteur");
    const pdf = await fetch(B + `/api/reports/${tok}/pdf`); const buf = Buffer.from(await pdf.arrayBuffer());
    ok(pdf.status === 200 && buf.slice(0, 5).toString() === '%PDF-' && buf.length > 3000, 'PDF du rapport valide');
    ok((await fetch(B + '/api/reports/' + 'b'.repeat(48))).status === 404, 'jeton inconnu -> 404');
    const mail = await waitFor(() => h.sent.find((m) => m.to[0] === 'client@exemple.fr' && /Votre rapport/.test(m.subject)));
    ok(mail.attachments.length === 1 && /^Rapport_WBA/.test(mail.attachments[0].filename), 'e-mail « rapport prêt » avec le PDF du rapport');
    const paid = h.sent.find((m) => m.to[0] === 'client@exemple.fr' && /Paiement reçu/.test(m.subject));
    ok(paid && paid.attachments.length === 1 && /^Facture_EV-/.test(paid.attachments[0].filename), 'e-mail « paiement reçu » avec la facture en pièce jointe');
    ok(mail.attachments.every((a) => Buffer.from(a.content).slice(0, 5).toString() === '%PDF-'), 'pièces jointes = vrais PDF');
    ok(mail.html.includes('/report/' + tok), "l'e-mail contient le lien du rapport");

    // --- idempotence du webhook ---
    const n0 = db.orders.length; const dup = await h.payWebhook(sidP, { email: 'client@exemple.fr' });
    ok(dup.duplicate === true && db.orders.length === n0, 'webhook rejoué sans effet');

    // --- Essentiel : pas de provenance ni comparatif ---
    const sidE = await buy('essentiel', 'WBA8E9C50GK654321', 'e@exemple.fr');
    const stE = await waitFor(async () => { const s = (await get('/api/checkout/status?session_id=' + sidE)).body; return s.reportToken ? s : null; });
    const RE = (await get('/api/reports/' + stE.reportToken)).body.report;
    ok(RE.plan === 'essentiel' && RE.provenance === null && RE.comparison === null && RE.recalls.status === 'found', 'Essentiel : options + fiche + rappels seulement');

    // --- statut inconnu / invalide ---
    ok((await get('/api/checkout/status?session_id=nimportequoi')).status === 400, 'session invalide refusée');
    ok((await get('/api/checkout/status?session_id=cs_test_000000zzzzzzzzzz')).body.status === 'waiting_payment', 'session pas encore payée -> attente');

    // --- échec fournisseur => remboursement automatique + avoir ---
    const saved = process.env.PROVIDER_ORDER; process.env.PROVIDER_ORDER = '';
    const sidF = await buy('premium', 'WBA8E9C50GK111111', 'f@exemple.fr');
    await waitFor(() => db.orders.find((o) => o.stripe_session_id === sidF && o.status === 'refunded'));
    process.env.PROVIDER_ORDER = saved;
    ok(h.refunds.length === 1 && h.refunds[0].amount === 1299, 'remboursement Stripe automatique du montant TTC');
    ok(db.credit_notes.length === 1 && /^AV-/.test(db.credit_notes[0].number), 'avoir numéroté émis');
    ok(h.sent.some((m) => m.to[0] === 'f@exemple.fr' && /avoir/i.test(m.subject) && m.attachments[0].content.slice(0, 5).toString() === '%PDF-'), "e-mail d'avoir avec PDF");
    ok((await get('/api/checkout/status?session_id=' + sidF)).body.status === 'refunded', 'statut remboursé visible côté site');

    // --- compte, crédits, espace Pro ---
    const gt = (p, b, m = 'POST', tok2) => fetch(h.gotrueUrl + '/auth/v1/' + p, { method: m, headers: { 'content-type': 'application/json', ...(tok2 ? { authorization: 'Bearer ' + tok2 } : {}) }, body: JSON.stringify(b) }).then(J);
    const su = await gt('signup', { email: 'pro@exemple.fr', password: 'motdepasse-long' }); ok(su.status === 200 && su.body.access_token, 'inscription');
    const T = su.body.access_token, A = { authorization: 'Bearer ' + T };
    ok((await get('/api/me')).status === 401, '/api/me exige une connexion');
    let me = (await get('/api/me', A)).body; ok(me.profile && me.profile.credits_balance === 0, '/api/me');
    ok((await post('/api/reports', { vin: 'WBA8E9C50GK222222', plan: 'essentiel' }, { ...A, 'idempotency-key': 'k1' })).status === 402, 'solde insuffisant -> 402');
    const nc = await post('/api/checkout', { kind: 'pack', packSize: 10, consent: { cgv: true } }, A);
    ok(nc.status === 400 && nc.body.error === 'COMPANY_REQUIRED', 'pack refusé sans raison sociale ni SIRET');
    ok((await fetch(B + '/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ company_name: 'Garage Dupont SARL', company_siret: '732 829 320 00074', company_vat: 'FR40732829320' }) }).then(J)).status === 200, 'profil société enregistré');
    const pk = await post('/api/checkout', { kind: 'pack', packSize: 10, consent: { cgv: true } }, A);
    ok(pk.status === 200, 'pack accepté avec société + SIRET');
    const sidK = pk.body.url.split('/').pop();
    ok(h.stripeSessions.get(sidK).metadata.company_siret === '73282932000074' && h.stripeSessions.get(sidK).metadata.company_name === 'Garage Dupont SARL', 'identité société transmise à Stripe (metadata)');
    await h.payWebhook(sidK, { email: 'pro@exemple.fr', details: { name: 'Jean Dupont', address: { line1: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'FR' } } });
    ok((await get('/api/checkout/status?session_id=' + sidK)).body.status === 'delivered', 'pack livré');
    me = (await get('/api/me', A)).body; ok(me.profile.credits_balance === 10 && me.invoices.length === 1, '10 crédits + facture');
    const cr = await post('/api/reports', { vin: 'WBA8E9C50GK222222', plan: 'premium' }, { ...A, 'idempotency-key': 'k2' });
    ok(cr.status === 202, 'génération par crédits acceptée');
    const cr2 = await post('/api/reports', { vin: 'WBA8E9C50GK222222', plan: 'premium' }, { ...A, 'idempotency-key': 'k2' });
    ok(cr2.body.duplicate === true, 'même clé d’idempotence = pas de double débit');
    const ord = await waitFor(async () => { const o = (await get('/api/orders/' + cr.body.orderId, A)).body; return o.reportToken ? o : null; });
    ok(ord.status === 'ready' || ord.status === 'delivered', 'commande par crédits prête');
    me = (await get('/api/me', A)).body; ok(me.profile.credits_balance === 8, 'solde débité de 2 crédits (Premium)');
    ok(me.reports.length === 1 && me.orders.some((o) => o.kind === 'credit_use'), 'rapport listé dans le compte');
    const ip = await fetch(B + `/api/invoices/${me.invoices[0].number}/pdf`, { headers: A }); ok(ip.status === 200 && Buffer.from(await ip.arrayBuffer()).slice(0, 5).toString() === '%PDF-', 'facture PDF du propriétaire');
    const su2 = await gt('signup', { email: 'autre@exemple.fr', password: 'motdepasse-long' });
    ok((await fetch(B + `/api/invoices/${me.invoices[0].number}/pdf`, { headers: { authorization: 'Bearer ' + su2.body.access_token } })).status === 404, "facture d'un autre client inaccessible");

    // --- support, signalement ---
    ok((await post('/api/support', { email: 'x@y.fr', subject: 'Facture', message: 'Bonjour, ma question est la suivante.' })).status === 201, 'ticket support');
    ok((await post('/api/support', { email: 'x@y.fr', subject: 'Facture', message: 'court' })).status === 400, 'message trop court refusé');
    ok((await post(`/api/reports/${tok}/error`, { type: 'Une option manque', details: 'Le toit ouvrant manque' })).status === 201, "signalement d'erreur");

    // --- admin : libellés ---
    const AD = { 'x-admin-key': 'a'.repeat(40) };
    ok((await get('/api/admin/labels/untranslated')).status === 401, 'admin sans clé refusé');
    const un = (await get('/api/admin/labels/untranslated', AD)).body; ok(un.items.some((x) => x.code === 'C14'), 'file des libellés non traduits');
    const put = await fetch(B + '/api/admin/labels', { method: 'PUT', headers: { 'content-type': 'application/json', ...AD }, body: JSON.stringify({ brand: 'bmw', code: 'C14', labelFr: 'Équipement spécial (validé)' }) }).then(J);
    ok(put.status === 200 && !db.untranslated_labels.some((x) => x.code === 'C14'), 'libellé validé retiré de la file');
    const sidC = await buy('essentiel', 'WBA8E9C50GK333333', 'c@exemple.fr');
    const stC = await waitFor(async () => { const s = (await get('/api/checkout/status?session_id=' + sidC)).body; return s.reportToken ? s : null; });
    const RC = (await get('/api/reports/' + stC.reportToken)).body.report;
    const c14 = RC.options.items.find((o) => o.code === 'C14'); ok(c14.label === 'Équipement spécial (validé)' && c14.labelStatus === 'curated', 'libellé validé appliqué aux rapports suivants');
    console.log(`serveur : ${pass} vérifications OK`);
    h.close(); process.exit(0);
  } catch (e) { console.error('ÉCHEC après', pass, 'vérifications :', e && e.stack || e); h.close(); process.exit(1); }
})();
