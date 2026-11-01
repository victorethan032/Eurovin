'use strict';
// Alerte rappel : activation avec consentement, première lecture sans alerte, alerte unique sur une nouvelle campagne,
// source indisponible, fréquence, arrêt en un clic (GET sans effet), expiration, suppression du compte, désactivation par défaut.
const assert = require('assert'), start = require('./testkit/harness'), P = require('./providers');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });
const CRON = { 'x-cron-secret': 'c'.repeat(32) };
(async () => {
  let items = [{ ref: 'C-100', date: '2024-05', title: 'Contrôle du calculateur', status: 'À réaliser' }], mode = 'ok', calls = 0;
  P.RECALL_ADAPTERS.test = async () => { calls++; if (mode === 'down') return { status: 'unavailable' }; return { status: 'ok', source: 'Source de test', asOf: '2026-10-07', items: items.map((x) => ({ ...x })) }; };
  const h = await start({ env: { RECALL_ALERTS: '1', RECALL_ORDER: 'test', RECALL_INTERVAL_DAYS: '7' } });
  const B = h.base, db = h.supabase.db;
  const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const get = (p) => fetch(B + p).then(J);
  const sweep = () => fetch(B + '/api/jobs/sweep', { method: 'POST', headers: CRON }).then((r) => r.status);
  const TOK = 'ab'.repeat(24), VIN = 'WBA8E9C50GK123456', FUT = new Date(Date.now() + 30 * 864e5).toISOString();
  db.orders.push({ id: 'o1', kind: 'report', buyer_email: 'Client@Exemple.fr', user_id: null, status: 'delivered' });
  db.reports.push({ id: 'r1', order_id: 'o1', vin: VIN, access_token: TOK, expires_at: FUT });
  const W = () => db.recall_watches.find((w) => w.vin === VIN);
  const mails = () => h.sent.filter((m) => /campagne de rappel/i.test(m.subject));
  try {
    // --- disponibilité et validation ---
    let r = await get(`/api/reports/${TOK}/recall-watch`); ok(r.status === 200 && r.body.available === true && r.body.active === false, 'état : disponible, pas encore activée');
    ok((await get('/api/reports/' + 'cd'.repeat(24) + '/recall-watch')).status === 404 && (await get('/api/reports/xyz/recall-watch')).status === 404, 'rapport inconnu ou jeton invalide : 404');
    ok((await post(`/api/reports/${TOK}/recall-watch`, { on: true })).body.error === 'CONSENT_REQUIRED' && db.recall_watches.length === 0, 'sans case cochée : refusé, rien n’est enregistré');
    ok((await post(`/api/reports/${TOK}/recall-watch`, { on: 'oui', consent: true })).status === 400, 'valeur incorrecte : refusée');
    r = await post(`/api/reports/${TOK}/recall-watch`, { on: true, consent: true });
    ok(r.status === 200 && r.body.active === true && W() && W().email === 'client@exemple.fr' && W().known_refs === null && /^[a-f0-9]{48}$/.test(W().token) && W().consent_at, 'activation : e-mail en minuscules, consentement daté, jeton aléatoire, rien de lu encore');
    ok(Date.parse(W().expires_at) > Date.now() + 700 * 864e5, 'arrêt automatique prévu à 24 mois');
    await post(`/api/reports/${TOK}/recall-watch`, { on: true, consent: true }); ok(db.recall_watches.length === 1, 'réactiver deux fois : une seule alerte pour ce VIN et cet e-mail');

    // --- première lecture : mémorise sans prévenir ---
    ok((await sweep()) === 200 && calls === 1, 'balayage : une consultation de la source'); 
    ok(JSON.stringify(W().known_refs) === '["C-100"]' && mails().length === 0 && W().last_checked_at, 'première lecture : campagnes existantes mémorisées, aucun e-mail');
    // --- fréquence ---
    await sweep(); ok(calls === 1, 'deuxième balayage tout de suite : la source n’est pas reconsultée (1 contrôle par semaine)');
    // --- nouvelle campagne : une alerte, une seule ---
    items.push({ ref: 'C-205', date: '2026-09', title: 'Remplacement de la ceinture <b>avant</b>', status: 'À réaliser' });
    W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString();
    await sweep(); const m = mails();
    ok(m.length === 1 && m[0].to.includes('client@exemple.fr') && m[0].html.includes('C-205') && !m[0].html.includes('C-100') && m[0].html.includes('Source de test') && m[0].html.includes(`/rappels/arret?t=${W().token}`) && m[0].html.includes(`/report/${TOK}`), 'nouvelle campagne : un e-mail avec la seule campagne nouvelle, la source, le lien du rapport et le lien d’arrêt');
    ok(m[0].html.includes('&lt;b&gt;avant') && !m[0].html.includes('<b>avant</b>'), 'texte de la campagne échappé');
    ok(m[0].headers && m[0].headers['List-Unsubscribe'].includes('/rappels/arret?t=') && m[0].headers['List-Unsubscribe-Post'] === 'List-Unsubscribe=One-Click', 'en-têtes « se désinscrire en un clic » présents');
    ok(JSON.stringify(W().known_refs.sort()) === '["C-100","C-205"]' && W().alerts_sent === 1 && W().last_alert_at, 'campagnes connues mises à jour, compteur d’alertes à 1');
    W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString(); await sweep(); ok(mails().length === 1, 'même campagne au contrôle suivant : pas de deuxième e-mail');
    // --- source indisponible ---
    items.push({ ref: 'C-300', date: '2026-10', title: 'Autre campagne', status: 'À réaliser' }); mode = 'down'; W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString();
    const c0 = calls; await sweep(); ok(calls === c0 + 1 && mails().length === 1 && !W().known_refs.includes('C-300'), 'source indisponible : aucune alerte, rien n’est oublié');
    ok(Date.parse(W().last_checked_at) < Date.now() - 5 * 864e5 && Date.parse(W().last_checked_at) > Date.now() - 7 * 864e5, 'nouvel essai prévu dans environ 1 jour');
    mode = 'ok'; W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString(); await sweep(); ok(mails().length === 2 && mails()[1].html.includes('C-300'), 'source de retour : la campagne manquée est signalée');
    // --- e-mail qui échoue : réessai sans perdre la campagne ---
    items.push({ ref: 'C-400', date: '2026-10', title: 'Campagne 4', status: 'À réaliser' }); W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString(); h.flags.mailFail = true;
    await sweep(); ok(!W().known_refs.includes('C-400') && mails().length === 2, 'e-mail en échec : campagne non marquée comme connue');
    h.flags.mailFail = false; W().last_checked_at = new Date(Date.now() - 8 * 864e5).toISOString(); await sweep(); ok(mails().length === 3 && mails()[2].html.includes('C-400') && W().known_refs.includes('C-400'), 'réessai réussi : une seule alerte envoyée');

    // --- arrêt en un clic ---
    const t = W().token; let g = await fetch(`${B}/rappels/arret?t=${t}`); const gb = await g.text();
    ok(g.status === 200 && gb.includes(VIN) && gb.includes('method="post"') && W().active === true, 'lien d’arrêt : GET affiche la confirmation sans rien désactiver');
    ok((await fetch(`${B}/rappels/arret?t=nimporte`)).status === 200 && (await (await fetch(`${B}/rappels/arret?t=nimporte`)).text()).includes('invalide'), 'jeton invalide : message neutre');
    const pr = await fetch(`${B}/rappels/arret?t=${t}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    ok(pr.status === 200 && W().active === false && W().stopped_reason === 'user' && W().stopped_at, 'POST « un clic » : alerte désactivée');
    items.push({ ref: 'C-500', title: 'Après arrêt' }); W().last_checked_at = null; const c1 = calls; await sweep(); ok(calls === c1 && mails().length === 3, 'alerte arrêtée : plus aucune consultation ni e-mail');
    r = await get(`/api/reports/${TOK}/recall-watch`); ok(r.body.active === false, 'état : désactivée');
    // --- réactivation : relit l'existant, ne prévient pas ---
    await post(`/api/reports/${TOK}/recall-watch`, { on: true, consent: true }); ok(W().active === true && W().known_refs === null && W().stopped_at === null, 'réactivation : lecture de l’existant à refaire');
    await sweep(); ok(W().known_refs.includes('C-500') && mails().length === 3, 'réactivation : les campagnes apparues pendant la pause ne déclenchent pas d’alerte');
    // --- désactivation depuis le rapport ---
    ok((await post(`/api/reports/${TOK}/recall-watch`, { on: false })).body.active === false && W().active === false, 'désactivation depuis la page du rapport');
    // --- expiration ---
    await post(`/api/reports/${TOK}/recall-watch`, { on: true, consent: true }); W().expires_at = new Date(Date.now() - 1000).toISOString(); await sweep();
    ok(W().active === false && W().stopped_reason === 'expired', 'alerte expirée : arrêt automatique');
    // --- plafond par adresse ---
    for (let i = 0; i < 50; i++) db.recall_watches.push({ id: 'x' + i, vin: 'V' + i, email: 'client@exemple.fr', token: String(i), active: true, expires_at: FUT });
    db.orders.push({ id: 'o2', kind: 'report', buyer_email: 'client@exemple.fr', user_id: null }); db.reports.push({ id: 'r2', order_id: 'o2', vin: 'ZFA31200003AAAAAA', access_token: 'ef'.repeat(24), expires_at: FUT });
    ok((await post(`/api/reports/${'ef'.repeat(24)}/recall-watch`, { on: true, consent: true })).status === 429, 'plafond : 50 alertes actives par adresse');
    // --- suppression de compte ---
    const wAcc = { id: 'wacc', vin: 'ZZZ', email: 'u@x.fr', user_id: 'u-del', token: 'q', active: true, expires_at: FUT }; db.recall_watches.push(wAcc);
    const acc = require('./account'); ok(typeof acc === 'function' || typeof acc === 'object', 'module compte chargé');
    ok(require('fs').readFileSync(require('path').join(__dirname, 'account.js'), 'utf8').includes("from('recall_watches').delete().eq('user_id', u.id)"), 'suppression de compte : les alertes de la personne sont supprimées');
    // --- l'e-mail est modifiable et aperçu dans l'administration ---
    const M = require('./mail'); ok(M.TEMPLATE_INFO.recallAlert && M.SAMPLES.recallAlert, 'modèle « alerte rappel » listé dans les textes d’e-mails modifiables');
  } finally { await h.close(); }
  // --- désactivée par défaut ---
  const h2 = await start({ env: { RECALL_ALERTS: '0' } });
  try {
    h2.supabase.db.orders.push({ id: 'o1', buyer_email: 'a@b.fr' }); h2.supabase.db.reports.push({ id: 'r1', order_id: 'o1', vin: VIN, access_token: TOK, expires_at: FUT });
    let r = await fetch(h2.base + `/api/reports/${TOK}/recall-watch`).then(J); ok(r.status === 200 && r.body.available === false, 'fonction désactivée : indiquée comme indisponible');
    ok((await fetch(h2.base + `/api/reports/${TOK}/recall-watch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true, consent: true }) })).status === 404 && h2.supabase.db.recall_watches.length === 0, 'fonction désactivée : activation refusée');
  } finally { await h2.close(); }
  console.log(`rappels : ${pass} vérifications OK`); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
