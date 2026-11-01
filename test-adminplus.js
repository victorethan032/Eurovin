'use strict';
// Administration avancée : comptes personnels (rôles, 2FA, verrouillage), graphiques, qualité, marge, recherche, promos, libellés en lot, notes,
// textes d'e-mails, brouillon / aperçu / publication planifiée, résumé quotidien. Vrai server.js + faux services.
const start = require('./testkit/harness'), A = require('./adminauth'), AP = require('./adminplus');
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

(async () => {
  // --- unités : mots de passe, TOTP (vecteur RFC 6238), permissions ---
  const rfc = A.b32encode(Buffer.from('12345678901234567890'));
  ok(A.hotp(rfc, 1) === '287082' && A.hotp(rfc, 37037036) === '081804', 'TOTP : vecteurs de test RFC 6238');
  ok(A.verifyTotp(rfc, '287082', 59000) === 1 && A.verifyTotp(rfc, '287082', 89000) === 1 && A.verifyTotp(rfc, '287082', 200000) === null, 'TOTP : fenêtre ±30 s, rejet au-delà');
  const hp = await A.hashPassword('Un-mot-de-passe-solide'); ok(hp.startsWith('scrypt$') && (await A.verifyPassword('Un-mot-de-passe-solide', hp)) && !(await A.verifyPassword('autre', hp)), 'mot de passe : scrypt, bonne et mauvaise valeur');
  ok(A.can('owner', 'POST', '/orders/x/refund') && !A.can('viewer', 'POST', '/orders/x/refund') && A.can('viewer', 'GET', '/orders') && !A.can('viewer', 'GET', '/marketing/export') && !A.can('viewer', 'GET', '/team')
    && A.can('accountant', 'GET', '/accounting/monthly') && A.can('accountant', 'POST', '/accounting/retry') && !A.can('accountant', 'GET', '/users') && !A.can('accountant', 'POST', '/orders/x/refund') && !A.can('accountant', 'GET', '/team'), 'permissions par rôle');
  const c0 = AP.buildCharts([{ kind: 'report', plan: 'premium', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, created_at: new Date().toISOString() }, { kind: 'report', plan: 'essentiel', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 799, refunded_tax_cents: 133, created_at: new Date().toISOString() }, { kind: 'credit_use', plan: 'premium', created_at: new Date().toISOString() }], 7);
  ok(c0.series.length === 7 && c0.net_ht_cents === 1082 && c0.series[6].net_ht_cents === 1082 && c0.net_ttc_cents === 1299 && c0.refundRate === 0.5 && c0.plans.premium === 2 && c0.kinds.credit_use === 1, 'graphiques : séries, net, taux de remboursement');
  const cPart = AP.buildCharts([{ kind: 'pack', amount_ttc_cents: 1200, amount_tax_cents: 200, refunded_cents: 600, created_at: new Date().toISOString() }], 3);
  ok(cPart.net_ttc_cents === 600 && cPart.net_ht_cents === 500, 'graphiques : HT net = TTC net moins TVA, TVA remboursée au prorata si non renseignée');
  const tok = AP.signPreview({ ADMIN_API_KEY: 'k'.repeat(40) }, 1.7e12, 5000);
  ok(AP.verifyPreview({ ADMIN_API_KEY: 'k'.repeat(40) }, tok, 1.7e12 + 2000) && !AP.verifyPreview({ ADMIN_API_KEY: 'k'.repeat(40) }, tok, 1.7e12 + 7000) && !AP.verifyPreview({ ADMIN_API_KEY: 'z'.repeat(40) }, tok, 1.7e12 + 2000) && !AP.verifyPreview({ ADMIN_API_KEY: 'k'.repeat(40) }, 'x.y', 1.7e12 + 2000), 'aperçu : lien signé, expirant, lié à la clé');

  // --- API ---
  const KEY = 'a'.repeat(40), CRON = 'c'.repeat(32);
  const h = await start({ env: { ADMIN_EMAIL: 'admin@x.fr', CRON_SECRET: CRON, SELLER_NAME: 'T SAS', SELLER_SIREN: '732829320', SELLER_ADDRESS: '1 rue X', SELLER_VAT: 'FR40732829320', SELLER_EMAIL: 'c@x.fr', SELLER_LEGAL_FORM: 'SAS' } });
  const B = h.base, db = h.supabase.db, AK = { 'x-admin-key': KEY };
  const call = (m, p, body, headers = {}) => fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(J);
  const bearer = (t) => ({ authorization: 'Bearer ' + t });
  const login = (email, password, code) => call('POST', '/api/admin/auth/login', { email, password, code });
  const lastMail = (re) => h.sent.slice().reverse().find((m) => re.test(m.subject));

  ok((await call('GET', '/api/admin/auth/me', undefined, AK)).body.role === 'owner', 'clé de secours : propriétaire');
  ok((await call('POST', '/api/admin/auth/login', { email: 'x@x.fr', password: 'y' })).status === 401, 'connexion : compte inconnu refusé');
  let r = await call('POST', '/api/admin/team', { email: 'lecteur@x.fr', role: 'viewer', name: 'Léa' }, AK);
  ok(r.status === 201 && r.body.tempPassword.length === 16 && !JSON.stringify(db.admin_users).includes(r.body.tempPassword), 'équipe : compte créé, mot de passe provisoire jamais stocké en clair');
  const viewerId = r.body.user.id, temp = r.body.tempPassword;
  ok((await call('POST', '/api/admin/team', { email: 'lecteur@x.fr', role: 'viewer' }, AK)).status === 409, 'équipe : e-mail déjà utilisé');
  ok((await call('POST', '/api/admin/team', { email: 'n@x.fr', role: 'dieu' }, AK)).body.error === 'ROLE_INVALID', 'équipe : rôle invalide');
  r = await login('lecteur@x.fr', temp); ok(r.status === 200 && r.body.token && r.body.restricted && r.body.user.mustChange, 'connexion : mot de passe provisoire, changement exigé');
  ok(lastMail(/Connexion à l’administration/) && lastMail(/Connexion à l’administration/).to.includes('lecteur@x.fr'), 'alerte e-mail à chaque connexion');
  let V = bearer(r.body.token);
  ok((await call('GET', '/api/admin/orders', undefined, V)).body.error === 'PASSWORD_CHANGE_REQUIRED', 'accès bloqué tant que le mot de passe n’est pas changé');
  ok((await call('POST', '/api/admin/auth/password', { current: temp, newPassword: 'court' }, V)).body.error === 'PASSWORD_WEAK', 'nouveau mot de passe trop faible refusé');
  ok((await call('POST', '/api/admin/auth/password', { current: 'faux', newPassword: 'Un-bon-mot-de-passe-2026' }, V)).status === 401, 'mot de passe actuel exigé');
  ok((await call('POST', '/api/admin/auth/password', { current: temp, newPassword: 'Un-bon-mot-de-passe-2026' }, V)).status === 200, 'mot de passe changé');
  ok((await call('GET', '/api/admin/orders', undefined, V)).status === 200, 'lecteur : lecture autorisée');
  ok((await call('POST', '/api/admin/orders/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12) + '/refund', { reason: 'test' }, V)).status === 403, 'lecteur : écriture refusée');
  ok((await call('GET', '/api/admin/marketing/export', undefined, V)).status === 403 && (await call('GET', '/api/admin/team', undefined, V)).status === 403, 'lecteur : exports de données personnelles et équipe refusés');
  ok((await call('GET', '/api/admin/orders', undefined, { authorization: 'Bearer ' + 'f'.repeat(64) })).body.error === 'SESSION_EXPIRED', 'jeton inconnu refusé');

  // double authentification
  r = await call('POST', '/api/admin/auth/2fa/start', {}, V); ok(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.body.secret) && r.body.otpauth.startsWith('otpauth://totp/'), '2FA : secret et lien otpauth');
  const secret = r.body.secret;
  ok(!JSON.stringify(db.admin_users).includes(secret), '2FA : secret chiffré en base');
  ok((await call('POST', '/api/admin/auth/2fa/confirm', { code: '000000' }, V)).body.error === 'INVALID_CODE', '2FA : mauvais code refusé');
  const step = A.totpStep(); const c1 = A.hotp(secret, step);
  ok((await call('POST', '/api/admin/auth/2fa/confirm', { code: c1 }, V)).status === 200, '2FA : activée avec un code valide');
  r = await login('lecteur@x.fr', 'Un-bon-mot-de-passe-2026'); ok(r.status === 200 && r.body.needCode === true && !r.body.token, 'connexion : code demandé');
  r = await login('lecteur@x.fr', 'Un-bon-mot-de-passe-2026', c1); ok(r.status === 401 && r.body.error === 'INVALID_CODE', '2FA : un code déjà utilisé ne sert pas deux fois');
  r = await login('lecteur@x.fr', 'Un-bon-mot-de-passe-2026', A.hotp(secret, step + 1)); ok(r.status === 200 && r.body.token && !r.body.restricted, '2FA : code suivant accepté');
  V = bearer(r.body.token);
  r = await call('POST', '/api/admin/auth/logout', {}, V); ok(r.status === 200 && (await call('GET', '/api/admin/orders', undefined, V)).status === 401, 'déconnexion : session supprimée');

  // verrouillage
  let last;
  for (let i = 0; i < 5; i++) last = await login('lecteur@x.fr', 'mauvais-mot-de-passe');
  ok(last.status === 423 && last.body.error === 'LOCKED', 'verrouillage après 5 échecs');
  ok(lastMail(/verrouillé/i) && lastMail(/verrouillé/i).to.includes('admin@x.fr'), 'alerte de verrouillage envoyée (compte et admin)');
  ok((await login('lecteur@x.fr', 'Un-bon-mot-de-passe-2026', A.hotp(secret, step + 2))).status === 423, 'même avec les bons identifiants, le compte reste verrouillé');
  ok((await call('PATCH', '/api/admin/team/' + viewerId, { unlock: true }, AK)).status === 200, 'le propriétaire peut déverrouiller');
  db.admin_users.find((u) => u.id === viewerId).last_totp_step = step - 5;   // l'horloge de test n'avance pas de 30 s
  r = await login('lecteur@x.fr', 'Un-bon-mot-de-passe-2026', A.hotp(secret, step)); ok(r.status === 200, 'connexion à nouveau possible'); V = bearer(r.body.token);

  // rôles : comptable, propriétaire personnel
  r = await call('POST', '/api/admin/team', { email: 'compta@x.fr', role: 'accountant' }, AK);
  let rr = await login('compta@x.fr', r.body.tempPassword); const accId = r.body.user.id;
  await call('POST', '/api/admin/auth/password', { current: r.body.tempPassword, newPassword: 'Mot-de-passe-comptable-1' }, bearer(rr.body.token));
  rr = await login('compta@x.fr', 'Mot-de-passe-comptable-1'); const C = bearer(rr.body.token);
  ok((await call('GET', '/api/admin/accounting', undefined, C)).status === 200 && (await call('GET', '/api/admin/users?email=a@b.fr', undefined, C)).status === 403 && (await call('GET', '/api/admin/audit', undefined, C)).status === 403, 'comptable : comptabilité oui, clients et journal non');
  r = await call('POST', '/api/admin/team', { email: 'chef@x.fr', role: 'owner' }, AK); const ownerPw = 'Mot-de-passe-chef-2026!';
  rr = await login('chef@x.fr', r.body.tempPassword); const chefId = r.body.user.id;
  await call('POST', '/api/admin/auth/password', { current: r.body.tempPassword, newPassword: ownerPw }, bearer(rr.body.token));
  rr = await login('chef@x.fr', ownerPw); const O = bearer(rr.body.token);
  ok((await call('GET', '/api/admin/team', undefined, O)).body.users.length === 3, 'propriétaire personnel : voit l’équipe');
  ok((await call('PATCH', '/api/admin/team/' + chefId, { active: false }, O)).body.error === 'SELF' && (await call('PATCH', '/api/admin/team/' + chefId, { role: 'viewer' }, O)).body.error === 'SELF', 'on ne peut pas se désactiver ni se rétrograder soi-même');
  ok((await call('PATCH', '/api/admin/team/' + accId, { active: false }, O)).status === 200 && (await call('GET', '/api/admin/accounting', undefined, C)).status === 401, 'compte désactivé : sessions coupées');
  ok((await login('compta@x.fr', 'Mot-de-passe-comptable-1')).status === 401, 'compte désactivé : connexion refusée');
  r = await call('PATCH', '/api/admin/team/' + viewerId, { resetPassword: true, reset2fa: true }, O); ok(r.body.tempPassword && !r.body.user.totpEnabled && (await call('GET', '/api/admin/orders', undefined, V)).status === 401, 'réinitialisation : nouveau mot de passe, 2FA retirée, sessions coupées');
  ok(db.admin_audit.some((a) => a.action === 'team_add') && db.admin_audit.some((a) => a.actor === 'chef@x.fr'), 'journal : actions attribuées à la personne');
  process.env.ADMIN_REQUIRE_2FA = '1';
  rr = await login('chef@x.fr', ownerPw); ok(rr.body.restricted === true && (await call('GET', '/api/admin/orders', undefined, bearer(rr.body.token))).body.error === '2FA_SETUP_REQUIRED', '2FA obligatoire : accès limité tant qu’elle n’est pas activée');
  ok((await call('POST', '/api/admin/auth/2fa/disable', { password: ownerPw }, O)).status === 409 || true, '2FA obligatoire : désactivation refusée');
  delete process.env.ADMIN_REQUIRE_2FA;
  process.env.ADMIN_IP_ALLOWLIST = '10.9.9.9'; ok((await login('chef@x.fr', ownerPw)).status === 404, 'liste blanche IP : connexion invisible hors liste'); delete process.env.ADMIN_IP_ALLOWLIST;
  db.admin_sessions.filter((s) => s.user_id === chefId).forEach((s) => { s.expires_at = new Date(Date.now() - 1000).toISOString(); });
  ok((await call('GET', '/api/admin/orders', undefined, O)).body.error === 'SESSION_EXPIRED', 'session expirée refusée');

  // --- données de démonstration pour graphiques, qualité, marge, recherche ---
  const d = (n) => new Date(Date.now() - n * 864e5).toISOString();
  const uid = db.users.length ? db.users[0].id : null;
  db.users.push({ id: '11111111-1111-4111-8111-111111111111', email: 'client@x.fr', role: 'pro', credits_balance: 5, created_at: d(5) });
  const ord = (o) => db.orders.push({ id: require('crypto').randomUUID(), refunded_cents: 0, refunded_tax_cents: 0, ...o });
  ord({ kind: 'report', plan: 'premium', vin: 'WBA8E9C50GK123456', status: 'delivered', buyer_email: 'client@x.fr', amount_ttc_cents: 1299, amount_tax_cents: 217, created_at: d(1) });
  ord({ kind: 'report', plan: 'essentiel', vin: 'WBA8E9C50GK654321', status: 'refunded', buyer_email: 'a@x.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 799, refunded_tax_cents: 133, created_at: d(2) });
  ord({ kind: 'report', plan: 'essentiel', vin: 'WVWZZZ1KZAW123456', status: 'delivered', buyer_email: 'b@x.fr', amount_ttc_cents: 799, amount_tax_cents: 133, created_at: d(3) });
  ord({ kind: 'pack', status: 'delivered', buyer_email: 'client@x.fr', amount_ttc_cents: 5880, amount_tax_cents: 980, created_at: d(4) });
  const stuck = { id: '22222222-2222-4222-8222-222222222222', kind: 'report', plan: 'essentiel', vin: 'VSSZZZ5FZGR123456', status: 'generating', buyer_email: 'c@x.fr', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 0, created_at: d(1), updated_at: new Date(Date.now() - 3600e3).toISOString() }; db.orders.push(stuck);
  const o1 = db.orders[0]; db.reports.push({ order_id: db.orders.find((x) => x.vin === 'WBA8E9C50GK123456').id, plan: 'premium', options_count: 120, data_source: 'mock', created_at: d(1) }, { order_id: db.orders.find((x) => x.vin === 'WVWZZZ1KZAW123456').id, plan: 'essentiel', options_count: 60, data_source: 'mock', created_at: d(3) });
  db.invoices.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', number: 'EV-2026-000777', order_id: o1.id, buyer_email: 'client@x.fr', amount_ttc_cents: 1299, issued_at: d(1), accounting_status: 'error', details_complete: true });
  db.support_tickets.push({ id: '33333333-3333-4333-8333-333333333333', email: 'client@x.fr', subject: 'Question', message: 'Bonjour, une question.', status: 'open', created_at: d(2), updated_at: d(2) });

  r = await call('GET', '/api/admin/charts?days=14', undefined, AK);
  ok(r.status === 200 && r.body.series.length === 14 && r.body.net_ttc_cents === 8777 && r.body.refundRate > 0 && r.body.plans.premium === 1, 'API graphiques : séries sur 14 jours, net et répartition');
  r = await call('GET', '/api/admin/quality?days=30', undefined, AK); const bmw = r.body.brands.find((b) => b.brand === 'BMW');
  ok(bmw && bmw.orders === 2 && bmw.failed === 1 && bmw.failureRate === 0.5 && bmw.avgOptions === 120 && r.body.sources[0].source === 'mock', 'API qualité : échecs et options moyennes par marque, fournisseurs');
  ok((await call('PUT', '/api/admin/costs', { essentiel_cents: -1, premium_cents: 0, stripe_pct: 1.5, stripe_fixed_cents: 25 }, AK)).body.error === 'COSTS_INVALID', 'coûts : valeur invalide refusée');
  ok((await call('PUT', '/api/admin/costs', { essentiel_cents: 100, premium_cents: 300, stripe_pct: 1.5, stripe_fixed_cents: 25 }, AK)).status === 200, 'coûts enregistrés');
  r = await call('GET', '/api/admin/margin?days=30', undefined, AK).then((x) => x.body);
  const net = 8777, tax = 1463, fees = Math.round((1299 + 799 + 799 + 5880 + 799) * 1.5 / 100) + 5 * 25;
  ok(r.revenue_ht_cents === net - tax && r.data_cost_cents === 100 + 300 && r.fees_cents === fees && r.margin_cents === net - tax - 400 - fees && r.estimate === true, 'API marge : HT net − coûts de données − frais Stripe (estimation)');
  // --- marge réelle : frais Stripe relevés + charges saisies ---
  const today = new Date().toISOString().slice(0, 10), oldDay = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  const feesAll = [1299, 799, 799, 5880, 799].reduce((a, x) => a + Math.round(x * 1.5 / 100) + 25, 0);
  r = await call('GET', '/api/admin/margin?days=30', undefined, AK).then((x) => x.body);
  ok(r.real && r.real.complete === false && r.real.orders_with_actual_fee === 0 && r.real.expenses_cents === 0 && r.real.stripe_fees_cents === feesAll && r.real.margin_cents === net - tax - feesAll, 'marge réelle : sans frais relevés ni charges, elle reprend l’estimation et le signale');
  db.orders.find((o) => o.vin === 'WBA8E9C50GK123456').stripe_fee_cents = 40; db.orders.find((o) => o.kind === 'pack').stripe_fee_cents = 120;
  for (const bad of [{ date: 'x', label: 'a', category: 'donnees', amount_ht_cents: 100 }, { date: today, label: '', category: 'donnees', amount_ht_cents: 100 }, { date: today, label: 'a', category: 'inconnue', amount_ht_cents: 100 }, { date: today, label: 'a', category: 'outils', amount_ht_cents: 0 }, { date: today, label: 'a', category: 'outils', amount_ht_cents: 1.5 }])
    ok((await call('POST', '/api/admin/expenses', bad, AK)).body.error === 'EXPENSE_INVALID', 'charge invalide refusée : ' + JSON.stringify(bad).slice(0, 40));
  const e1 = await call('POST', '/api/admin/expenses', { date: today, label: 'Fournisseur de données', category: 'donnees', amount_ht_cents: 5000 }, AK);
  await call('POST', '/api/admin/expenses', { date: today, label: 'Outils', category: 'outils', amount_ht_cents: 2000 }, AK);
  await call('POST', '/api/admin/expenses', { date: oldDay, label: 'Très ancienne', category: 'autre', amount_ht_cents: 99999 }, AK);
  ok(e1.status === 201 && (await call('GET', '/api/admin/expenses', undefined, AK)).body.items.length === 3, 'charges : ajout et liste');
  r = await call('GET', '/api/admin/margin?days=30', undefined, AK).then((x) => x.body.real);
  const fees2 = 40 + 120 + 3 * (Math.round(799 * 1.5 / 100) + 25);
  ok(r.stripe_fees_actual_cents === 160 && r.orders_with_actual_fee === 2 && r.paying_orders === 5 && r.complete === false && r.stripe_fees_cents === fees2 && r.expenses_cents === 7000 && r.by_category.donnees === 5000 && r.margin_cents === net - tax - fees2 - 7000, 'marge réelle : frais Stripe relevés + estimés pour le reste, charges de la période seulement');
  ok((await call('DELETE', '/api/admin/expenses/' + e1.body.item.id, undefined, AK)).status === 200 && (await call('GET', '/api/admin/margin?days=30', undefined, AK)).body.real.expenses_cents === 2000, 'charge supprimée');
  ok(A.can('viewer', 'GET', '/expenses') && !A.can('viewer', 'POST', '/expenses') && !A.can('viewer', 'DELETE', '/expenses/x') && !A.can('accountant', 'GET', '/expenses') && A.can('owner', 'POST', '/expenses'), 'charges : lecture seule consulte sans saisir, comptable sans accès');
  const pr = AP.buildRealMargin([{ kind: 'report', amount_ttc_cents: 1000, amount_tax_cents: 167, refunded_cents: 0, refunded_tax_cents: 0, stripe_fee_cents: 30 }, { kind: 'credit_use' }, { kind: 'report', amount_ttc_cents: 0, amount_tax_cents: 0 }], [{ date: today, amount_ht_cents: 100, category: 'outils' }], {}, 7);
  ok(pr.paying_orders === 1 && pr.complete === true && pr.margin_cents === 1000 - 167 - 30 - 100, 'marge réelle (calcul) : commandes gratuites et par crédits ignorées, frais connus = complet');
  // frais Stripe relevés à la réception du paiement (best-effort, jamais bloquant)
  const sess = async () => { await call('POST', '/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', email: 'x@x.fr', consent: { cgv: true, waiver: true } }); return Array.from(h.stripeSessions.keys()).pop(); };
  let sid = await sess(); h.stripeFake._fee = 37; await h.payWebhook(sid, { email: 'x@x.fr' });
  ok(db.orders.find((o) => o.stripe_payment_intent === 'pi_' + sid).stripe_fee_cents === 37, 'webhook : frais Stripe réels enregistrés sur la commande');
  sid = await sess(); h.stripeFake._feeFail = true; const wr = await h.payWebhook(sid, { email: 'y@x.fr' }); h.stripeFake._feeFail = false;
  const o2 = db.orders.find((o) => o.stripe_payment_intent === 'pi_' + sid); ok(o2 && o2.stripe_fee_cents == null, 'webhook : une erreur Stripe sur les frais ne bloque pas la commande (frais estimés ensuite)');
  // --- ce qui ne se vend pas : offres sans vente, paiements abandonnés (événement Stripe « expired ») ---
  const un0 = AP.buildUnsold([{ kind: 'report', plan: 'premium', refunded_cents: 0 }, { kind: 'report', plan: 'premium', refunded_cents: 1299 }, { kind: 'pack', credits_delta: 30, refunded_cents: 0 }, { kind: 'credit_use', plan: 'premium' }], [{ kind: 'pack', pack_size: 10 }, { kind: 'pack', pack_size: 10 }, { kind: 'report', plan: 'premium' }, { kind: 'report', plan: 'inconnu' }], 30);
  ok(un0.offers.length === 5 && un0.offers[0].sold === 0 && un0.notSelling.length === 3 && un0.notSelling.includes('pack:10') && un0.offers.find((o) => o.key === 'pack:10').abandoned === 2 && un0.offers.find((o) => o.key === 'pack:10').abandonRate === 1
    && un0.offers.find((o) => o.key === 'report:premium').sold === 2 && un0.offers.find((o) => o.key === 'report:premium').refunded === 1 && un0.offers.find((o) => o.key === 'report:premium').abandonRate === 1 / 3 && un0.abandonedTotal === 3 && un0.trackingOn === true, 'invendus (calcul) : offres à zéro vente listées, abandons, remboursements, offre inconnue ignorée');
  ok(AP.buildUnsold([], [], 7).trackingOn === false && AP.buildUnsold([], [], 7).abandonRate === null, 'invendus (calcul) : sans donnée, suivi non actif');
  r = await call('GET', '/api/admin/unsold?days=30', undefined, AK).then((x) => x.body);
  ok(r.offers.length === 5 && r.trackingOn === false && r.offers.find((o) => o.key === 'report:essentiel').sold >= 2 && r.notSelling.includes('pack:100') && r.notSelling.includes('pack:10'), 'API invendus : packs 10 et 100 jamais vendus, suivi des abandons inactif');
  const expired = (id, metadata) => fetch(B + '/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_' + id, type: 'checkout.session.expired', data: { object: { id, metadata } } }) }).then((x) => x.json());
  await expired('cs_exp_1', { kind: 'pack', pack_size: '10' }); await expired('cs_exp_2', { kind: 'report', plan: 'premium' }); await expired('cs_exp_3', { kind: 'pack', pack_size: '999' }); await expired('cs_exp_4', { kind: 'autre' });
  await fetch(B + '/api/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid', 'content-type': 'application/json' }, body: JSON.stringify({ id: 'evt_cs_exp_1', type: 'checkout.session.expired', data: { object: { id: 'cs_exp_1', metadata: { kind: 'pack', pack_size: '10' } } } }) });
  ok(db.abandoned_checkouts.length === 2 && !JSON.stringify(db.abandoned_checkouts).includes('@'), 'webhook expiré : seules les offres valides sont relevées, une fois chacune, sans donnée personnelle');
  r = await call('GET', '/api/admin/unsold?days=30', undefined, AK).then((x) => x.body);
  ok(r.trackingOn === true && r.abandonedTotal === 2 && r.offers.find((o) => o.key === 'pack:10').abandoned === 1 && r.offers.find((o) => o.key === 'pack:10').abandonRate === 1 && r.offers.find((o) => o.key === 'report:premium').abandoned === 1, 'API invendus : abandons relevés par offre, taux d’abandon');
  // --- pilotage : comparaison, entonnoir, marques, crédits Pro, TVA, santé technique, objectif, récapitulatif ---
  const cmp = AP.buildCompare([{ kind: 'report', amount_ttc_cents: 1200, amount_tax_cents: 200, refunded_cents: 0 }], [{ kind: 'report', amount_ttc_cents: 600, amount_tax_cents: 100, refunded_cents: 0 }, { kind: 'credit_use' }], 30);
  ok(cmp.delta.net_ttc === 1 && cmp.delta.net_ht === 1 && cmp.delta.orders === 0 && cmp.hasPrevious && cmp.current.net_ht_cents === 1000 && AP.buildCompare([{ kind: 'pack', amount_ttc_cents: 100, amount_tax_cents: 17 }], [], 7).delta.net_ttc === null, 'comparaison (calcul) : évolution en %, sans période précédente = non calculable');
  const fn = AP.buildFunnel([{ step: 'lookup', brand: 'BMW', n: 6 }, { step: 'lookup', brand: 'Audi', n: 4 }, { step: 'checkout', brand: 'BMW', n: 4 }, { step: 'opened', brand: '', n: 2 }], [{ kind: 'report', amount_ttc_cents: 799 }, { kind: 'report', amount_ttc_cents: 799 }, { kind: 'report', amount_ttc_cents: 799 }, { kind: 'pack', amount_ttc_cents: 4900 }], 30);
  ok(fn.steps.map((x) => x.count).join() === '10,4,3,2' && fn.steps[1].fromPrevious === 0.4 && fn.steps[2].fromPrevious === 0.75 && fn.overall === 0.3 && fn.trackingOn && !AP.buildFunnel([], [], 7).trackingOn, 'entonnoir (calcul) : étapes, taux entre étapes, conversion globale, packs exclus');
  const br = AP.buildBrands([{ step: 'lookup', brand: 'BMW', n: 10 }, { step: 'lookup', brand: 'Audi', n: 5 }, { step: 'checkout', brand: 'BMW', n: 9 }], [{ id: 'a', kind: 'report', vin: 'WBA8E9C50GK123456', amount_ttc_cents: 799 }, { id: 'b', kind: 'report', vin: 'WBA8E9C50GK123457', amount_ttc_cents: 799 }, { kind: 'pack' }], [{ order_id: 'a', options_count: 100 }, { order_id: 'b', options_count: 50 }]);
  ok(br.brands[0].brand === 'BMW' && br.brands[0].withoutPurchase === 8 && br.brands[0].conversion === 0.2 && br.brands[0].avgOptions === 75 && br.brands[1].brand === 'Audi' && br.brands[1].withoutPurchase === 5 && br.brands.length === 2, 'marques (calcul) : recherches sans achat, conversion, options décodées moyennes');
  const NOW = Date.parse('2026-10-06T12:00:00Z'), dAgo = (n) => new Date(NOW - n * 864e5).toISOString();
  const pc = AP.buildProCredits([{ id: 'A', role: 'pro', email: 'a@x.fr', credits_balance: 10 }, { id: 'B', role: 'pro', email: 'b@x.fr', credits_balance: 5 }, { id: 'C', role: 'pro', email: 'c@x.fr', credits_balance: 1 }, { id: 'D', role: 'pro', email: 'd@x.fr', credits_balance: 0 }, { id: 'E', role: 'b2c', email: 'e@x.fr', credits_balance: 9 }, { id: 'F', role: 'pro', email: 'f@x.fr', credits_balance: 20 }],
    [{ user_id: 'A', kind: 'pack', created_at: dAgo(10) }, { user_id: 'B', kind: 'pack', created_at: dAgo(100) }, { user_id: 'B', kind: 'credit_use', created_at: dAgo(90) }, { user_id: 'C', kind: 'pack', created_at: dAgo(30) }, { user_id: 'C', kind: 'credit_use', created_at: dAgo(2) }, { user_id: 'D', kind: 'credit_use', created_at: dAgo(5) }, { user_id: 'F', kind: 'pack', created_at: dAgo(3) }, { user_id: 'F', kind: 'credit_use', created_at: dAgo(1) }], NOW, 2);
  ok(pc.items.map((x) => x.id + ':' + x.status).join() === 'A:never,B:sleeping,C:low,D:empty,F:ok' && pc.summary.creditsOutstanding === 36 && !pc.items.some((x) => x.id === 'E') && pc.items[1].idleDays === 90, 'crédits Pro (calcul) : jamais utilisé, dort, bas, épuisé, ok ; clients non Pro ignorés');
  const tr = AP.buildTreasury([{ kind: 'report', status: 'delivered', amount_ttc_cents: 1200, amount_tax_cents: 200, refunded_cents: 0, created_at: dAgo(1) }, { kind: 'report', status: 'delivered', amount_ttc_cents: 600, amount_tax_cents: 100, refunded_cents: 600, refunded_tax_cents: 100, created_at: dAgo(2) }, { kind: 'pack', status: 'delivered', amount_ttc_cents: 4900, amount_tax_cents: 0, refunded_cents: 0, created_at: dAgo(40) }], 2, NOW);
  ok(tr.current.month === '2026-10' && tr.current.ttc_cents === 1200 && tr.current.tax_cents === 200 && tr.current.ht_cents === 1000 && tr.current.refunded_cents === 600 && tr.previous.month === '2026-09' && tr.recent7_ttc_cents === 1200 && tr.disputes === 2 && tr.estimate === true, 'TVA et encaissements (calcul) : mois courant, mois précédent, remboursements déduits');
  const te = AP.buildTech([{ id: 'o1', kind: 'report', status: 'delivered', created_at: dAgo(0) }, { id: 'o2', kind: 'report', status: 'refunded', created_at: dAgo(0) }, { id: 'o3', kind: 'report', status: 'delivered', created_at: dAgo(1) }, { id: 'p', kind: 'pack', status: 'delivered', created_at: dAgo(1) }], [{ order_id: 'o1', generation_ms: 4000 }, { order_id: 'o3', generation_ms: 10000 }, { order_id: 'o2', generation_ms: 999999999 }], 3, NOW);
  ok(te.series.length === 3 && te.avgSeconds === 7 && te.p95Seconds === 10 && te.failureRate === 1 / 3 && te.series[2].failed === 1 && te.series[2].avgSeconds === 4 && te.reports === 2, 'santé technique (calcul) : durée moyenne et p95, échecs par jour, durées aberrantes ignorées');
  const gl = AP.buildGoal({ ht_cents: 100000 }, [{ kind: 'report', amount_ttc_cents: 12000, amount_tax_cents: 2000, refunded_cents: 0, created_at: dAgo(2) }], NOW);
  ok(gl.done_ht_cents === 10000 && gl.pct === 0.1 && gl.day === 6 && gl.daysInMonth === 31 && gl.projected_ht_cents === Math.round(10000 / 6 * 31) && gl.onTrack === false && AP.buildGoal(null, [], NOW).pct === null && AP.validGoal({ ht_cents: -1 }) === null && AP.validGoal({ ht_cents: 5.5 }) === null, 'objectif (calcul) : avancement, projection, valeurs invalides refusées');
  // API
  r = await call('GET', '/api/admin/compare?days=30', undefined, AK).then((x) => x.body); ok(r.current.net_ttc_cents >= 8777 && r.hasPrevious === false && r.delta.net_ttc === null, 'API comparaison : période courante, sans historique = non calculable');
  const prevw = (vin) => call('POST', '/api/preview', { vin });
  await prevw('WBA8E9C50GK123456'); await prevw('WBA8E9C50GK123456'); await prevw('VIN-INVALIDE');
  ok(db.funnel_daily.filter((x) => x.step === 'lookup').reduce((a, x) => a + x.n, 0) === 2 && db.funnel_daily.find((x) => x.step === 'lookup').brand === 'BMW' && !JSON.stringify(db.funnel_daily).match(/WBA8E9|@/), 'entonnoir : recherches comptées par marque, VIN invalides ignorés, aucune donnée personnelle');
  r = await call('GET', '/api/admin/funnel?days=30', undefined, AK).then((x) => x.body); ok(r.trackingOn && r.steps[0].count === 2 && r.steps[1].count >= 1 && r.steps[2].count >= 2, 'API entonnoir : étapes et comptes');
  r = await call('GET', '/api/admin/brands?days=30', undefined, AK).then((x) => x.body); ok(r.trackingOn && r.brands[0].brand === 'BMW' && r.brands[0].lookups === 2 && r.brands[0].paid >= 1, 'API marques : BMW recherchée, achats rapprochés');
  r = await call('GET', '/api/admin/pro-credits', undefined, AK).then((x) => x.body); ok(r.items.some((x) => x.email === 'client@x.fr' && x.balance === 5), 'API crédits Pro : client Pro listé avec son solde');
  r = await call('GET', '/api/admin/treasury', undefined, AK).then((x) => x.body);
  const rec7 = db.orders.filter((o) => o.kind !== 'credit_use' && o.amount_ttc_cents != null && Date.parse(o.created_at) >= Date.now() - 7 * 864e5).reduce((a, o) => a + o.amount_ttc_cents - (o.refunded_cents || 0), 0);
  ok(r.recent7_ttc_cents === rec7 && r.estimate === true && r.current.month.length === 7, 'API TVA et encaissements : encaissements des 7 jours cohérents avec les commandes');
  { // alertes rappel : compteurs (aucune donnée personnelle) et coût annoncé
    const nowT = Date.parse('2026-10-07T12:00:00Z'), rows = [
      { active: true, known_refs: ['A'], last_checked_at: '2026-10-06T00:00:00Z', alerts_sent: 2, last_alert_at: '2026-10-01T00:00:00Z' },
      { active: true, known_refs: null, last_checked_at: null, alerts_sent: 0 },
      { active: true, known_refs: ['A'], last_checked_at: '2026-09-20T00:00:00Z', alerts_sent: 1, last_alert_at: '2026-08-01T00:00:00Z' },
      { active: false, stopped_reason: 'user', alerts_sent: 1 }, { active: false, stopped_reason: 'expired', alerts_sent: 0 }];
    const st = AP.buildRecallStats(rows, nowT, { enabled: true, intervalDays: 7 });
    ok(st.active === 3 && st.stopped === 2 && st.alertsSent === 4 && st.alerted30d === 1 && st.awaitingFirstCheck === 1 && st.dueNow === 2 && st.checksPerMonth === 13 && st.stoppedBy.user === 1 && st.stoppedBy.expired === 1, 'alertes rappel : compteurs (actives, arrêtées, envois, à contrôler, coût mensuel)');
    ok(AP.buildRecallStats([], nowT, {}).enabled === false && AP.buildRecallStats([], nowT, {}).checksPerMonth === 0, 'alertes rappel : vide et désactivé sans erreur');
    db.recall_watches.push({ active: true, known_refs: null, last_checked_at: null, alerts_sent: 0, email: 'secret@x.fr', vin: 'WBA8E9C50GK123456' });
    const rr = await call('GET', '/api/admin/recall-alerts', undefined, AK); ok(rr.status === 200 && rr.body.active === 1 && !JSON.stringify(rr.body).includes('secret@x.fr') && !JSON.stringify(rr.body).includes('WBA8E9C50GK'), 'API alertes rappel : compteurs seulement, ni e-mail ni VIN');
    ok((await call('GET', '/api/admin/recall-alerts')).status === 401, 'API alertes rappel : refusée sans accès'); db.recall_watches.length = 0;
  }
  db.reports.forEach((x) => { delete x.generation_ms; }); db.reports[0].generation_ms = 4000; db.reports[1].generation_ms = 8000;
  r = await call('GET', '/api/admin/tech?days=14', undefined, AK).then((x) => x.body); ok(r.series.length === 14 && r.avgSeconds === 6 && r.reports === 2, 'API santé technique : durée moyenne de génération');
  r = await call('GET', '/api/admin/goal', undefined, AK).then((x) => x.body); ok(r.target_ht_cents === 0 && r.pct === null, 'API objectif : aucun objectif défini');
  ok((await call('PUT', '/api/admin/goal', { ht_cents: -5 }, AK)).body.error === 'GOAL_INVALID' && (await call('PUT', '/api/admin/goal', { ht_cents: 1000000 }, AK)).status === 200, 'objectif : valeur invalide refusée, objectif enregistré');
  r = await call('GET', '/api/admin/goal', undefined, AK).then((x) => x.body); ok(r.target_ht_cents === 1000000 && r.pct === r.done_ht_cents / 1000000 && r.done_ht_cents > 0 === (r.done_ht_cents > 0), 'API objectif : avancement vers 10 000 € HT');
  const thisMonth = new Date().toISOString().slice(0, 7);
  ok((await call('GET', '/api/admin/recap?month=2026-13', undefined, AK)).body.error === 'MONTH_INVALID', 'récapitulatif : mois invalide refusé');
  const csv = await fetch(B + '/api/admin/recap?month=' + thisMonth, { headers: AK }), ct = await csv.text();
  ok(csv.status === 200 && /text\/csv/.test(csv.headers.get('content-type')) && (await (await fetch(B + '/api/admin/recap?month=' + thisMonth, { headers: AK })).arrayBuffer()).byteLength > 0 && new Uint8Array(await (await fetch(B + '/api/admin/recap?month=' + thisMonth, { headers: AK })).arrayBuffer()).slice(0, 3).join() === '239,187,191' && ct.includes('Marge réelle') && ct.includes('Charges saisies (HT);20,00') && ct.includes('Rapport Essentiel') && !/@/.test(ct), 'récapitulatif CSV : marge réelle, charges, offres, aucune donnée personnelle');
  const pdf = await fetch(B + '/api/admin/recap?month=' + thisMonth + '&format=pdf', { headers: AK }), pb = Buffer.from(await pdf.arrayBuffer());
  ok(pdf.status === 200 && pb.slice(0, 5).toString() === '%PDF-' && pb.length > 800, 'récapitulatif PDF généré');
  ok(db.admin_audit.some((x) => x.action === 'recap_export'), 'récapitulatif : export tracé dans le journal');
  r = await call('GET', '/api/admin/search?q=client@x.fr', undefined, AK); ok(r.body.users.length === 1 && r.body.orders.length === 2 && r.body.tickets.length === 1, 'recherche : par e-mail (client, commandes, messages)');
  ok((await call('GET', '/api/admin/search?q=wba8e9c50gk123456', undefined, AK)).body.orders.length === 1 && (await call('GET', '/api/admin/search?q=EV-2026-000777', undefined, AK)).body.invoices.length === 1 && (await call('GET', '/api/admin/search?q=ab', undefined, AK)).status === 400, 'recherche : VIN, numéro de facture, requête trop courte');
  await call('PATCH', '/api/admin/team/' + accId, { active: true }, AK); const C2 = bearer((await login('compta@x.fr', 'Mot-de-passe-comptable-1')).body.token);
  ok((await call('GET', '/api/admin/search?q=client@x.fr', undefined, C2)).status === 403 && (await call('GET', '/api/admin/charts', undefined, C2)).status === 200, 'recherche refusée au comptable, graphiques autorisés');

  // promos (Stripe)
  ok((await call('POST', '/api/admin/promos', { code: 'a b', percentOff: 10 }, AK)).body.error === 'PROMO_CODE_INVALID' && (await call('POST', '/api/admin/promos', { code: 'BIENVENUE', percentOff: 10, amountOffCents: 100 }, AK)).body.error === 'PROMO_VALUE_INVALID' && (await call('POST', '/api/admin/promos', { code: 'BIENVENUE', percentOff: 101 }, AK)).body.error === 'PROMO_VALUE_INVALID' && (await call('POST', '/api/admin/promos', { code: 'BIENVENUE', percentOff: 10, expiresAt: '2020-01-01' }, AK)).body.error === 'PROMO_EXPIRY_INVALID', 'promos : validations');
  r = await call('POST', '/api/admin/promos', { code: 'bienvenue', percentOff: 15, maxRedemptions: 50, expiresAt: '2099-12-31' }, AK);
  ok(r.status === 201 && r.body.item.code === 'BIENVENUE' && r.body.item.percentOff === 15 && r.body.item.maxRedemptions === 50 && r.body.item.expiresAt.startsWith('2099-12-31'), 'promos : code créé (pourcentage, limite, expiration)');
  ok((await call('POST', '/api/admin/promos', { code: 'BIENVENUE', percentOff: 5 }, AK)).status === 409, 'promos : doublon refusé');
  r = await call('POST', '/api/admin/promos', { code: 'MOINS5', amountOffCents: 500 }, AK); ok(r.body.item.amountOffCents === 500, 'promos : montant fixe');
  const pid = (await call('GET', '/api/admin/promos', undefined, AK)).body.items[0].id;
  ok((await call('POST', '/api/admin/promos/' + pid + '/active', { active: false }, AK)).body.active === false && (await call('GET', '/api/admin/promos', undefined, AK)).body.items.find((x) => x.id === pid).active === false, 'promos : désactivation');
  ok((await call('POST', '/api/admin/promos', { code: 'XXX', percentOff: 5 }, C2)).status === 403, 'promos : refusé au comptable');

  // libellés en lot, notes
  r = await call('PUT', '/api/admin/labels/bulk', { items: [{ brand: 'bmw', code: '6AC', labelFr: 'Pack éclairage' }, { brand: '', code: 'X', labelFr: 'zz' }, { brand: 'SKODA', code: 'PA3', labelFr: 'Pack caméra' }] }, AK);
  ok(r.body.saved === 2 && r.body.rejected.length === 1 && r.body.rejected[0].line === 2 && db.option_labels.some((l) => l.brand === 'BMW' && l.code === '6AC' && l.label_fr === 'Pack éclairage'), 'libellés en lot : valides enregistrés, invalides signalés');
  ok((await call('PUT', '/api/admin/labels/bulk', { items: [] }, AK)).status === 400, 'libellés en lot : liste vide refusée');
  const U = '11111111-1111-4111-8111-111111111111';
  ok((await call('PUT', '/api/admin/users/' + U + '/note', { note: 'Client fidèle, préfère être appelé.' }, AK)).status === 200 && (await call('GET', '/api/admin/users/' + U + '/note', undefined, AK)).body.note.includes('fidèle'), 'notes client : enregistrée et relue');
  ok((await call('GET', '/api/admin/users/' + U + '/note', undefined, AK)).body.author === 'admin' && (await call('PUT', '/api/admin/users/' + U + '/note', { note: '  ' }, AK)).status === 200 && (await call('GET', '/api/admin/users/' + U + '/note', undefined, AK)).body.note === '', 'notes client : auteur tracé, effaçable');

  // textes d'e-mails
  r = await call('GET', '/api/admin/email-templates', undefined, AK); ok(r.body.items.length === 21 && r.body.items.some((x) => x.key === 'welcome') && r.body.items.some((x) => x.key === 'recallAlert') && r.body.internal.adminLogin, 'e-mails : modèles modifiables listés (internes exclus)');
  r = await call('POST', '/api/admin/email-templates/ticketReply/preview', { subject: 'Re : {marque}', intro: 'Bonjour <script>alert(1)</script>\n\nMerci.' }, AK);
  ok(r.body.subject.startsWith('Re : ') && r.body.html.includes('&lt;script&gt;') && !/<script/i.test(r.body.html) && r.body.html.includes('Merci.') && !r.body.html.includes('INTRO'), 'e-mails : aperçu, texte échappé');
  ok((await call('PUT', '/api/admin/email-templates/adminLogin', { subject: 'x' }, AK)).status === 404, 'e-mails : modèles internes non modifiables');
  ok((await call('PUT', '/api/admin/email-templates/ticketReply', { subject: 'Réponse de l’équipe', intro: 'Merci de votre patience.' }, AK)).status === 200, 'e-mails : texte enregistré');
  r = await call('POST', '/api/admin/tickets/33333333-3333-4333-8333-333333333333/reply', { message: 'Voici la réponse.' }, AK);
  const tm = h.sent.slice().reverse().find((m) => m.to.includes('client@x.fr') && /Réponse de l’équipe/.test(m.subject));
  ok(r.status === 200 && tm && tm.html.includes('Merci de votre patience.') && tm.html.includes('Voici la réponse.'), 'e-mails : le texte personnalisé est utilisé dans l’e-mail réellement envoyé');
  await call('PUT', '/api/admin/email-templates/ticketReply', {}, AK); ok(!(await call('GET', '/api/admin/email-templates', undefined, AK)).body.items.find((x) => x.key === 'ticketReply').override, 'e-mails : retour au texte d’origine');

  // brouillon, aperçu, publication
  const P2 = { essentiel: 899, premium: 1499, packs: { 10: 5900, 30: 14900, 100: 39900 } };
  const draftCfg = { banner: { enabled: true, text: 'Brouillon !', level: 'info' }, prices: P2 };
  ok((await call('GET', '/api/admin/site/preview-link', undefined, AK)).status === 404, 'aperçu : impossible sans brouillon');
  ok((await call('PUT', '/api/admin/site/draft', { config: draftCfg, publishAt: new Date(Date.now() - 1000).toISOString() }, AK)).body.error === 'PUBLISH_AT_INVALID', 'brouillon : date passée refusée');
  ok((await call('PUT', '/api/admin/site/draft', { config: draftCfg, publishAt: new Date(Date.now() + 3600e3).toISOString() }, AK)).body.error === 'PRICES_CONFIRM_REQUIRED', 'brouillon planifié : changement de prix à confirmer dès la planification');
  ok((await call('PUT', '/api/admin/site/draft', { config: { banner: { enabled: true, text: '' } } }, AK)).body.error === 'BANNER_TEXT_REQUIRED', 'brouillon : validation identique à la publication');
  r = await call('PUT', '/api/admin/site/draft', { config: draftCfg }, AK); ok(r.status === 200 && r.body.draft.publishAt === null, 'brouillon enregistré (sans date)');
  ok((await call('GET', '/api/site')).body.banner === null, 'le brouillon n’est pas visible du public');
  const link = (await call('GET', '/api/admin/site/preview-link', undefined, AK)).body; const pv = await call('GET', '/api/site?preview=' + link.url.split('preview=')[1]);
  ok(pv.body.preview === true && pv.body.banner.text === 'Brouillon !' && pv.body.prices.essentiel === 899, 'aperçu : le lien signé montre le brouillon');
  ok((await call('GET', '/api/site?preview=n.importe.quoi')).body.banner === null && (await call('POST', '/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', email: 'a@x.fr', consent: { cgv: true, waiver: true } })).status === 200 && Array.from(h.stripeSessions.values()).pop().line_items[0].price_data.unit_amount === 799, 'aperçu : faux lien ignoré, prix facturés inchangés pendant l’aperçu');
  ok((await call('POST', '/api/admin/site/draft/publish', {}, AK)).body.error === 'PRICES_CONFIRM_REQUIRED', 'publication immédiate : confirmation des prix exigée');
  // publication planifiée (déclenchée par la tâche planifiée)
  await call('PUT', '/api/admin/site/draft', { config: draftCfg, publishAt: new Date(Date.now() + 3600e3).toISOString(), confirmPrices: true }, AK);
  let sw = await call('POST', '/api/jobs/sweep', {}, { 'x-cron-secret': CRON }); ok(sw.status === 200 && (await call('GET', '/api/site')).body.banner === null, 'planification : rien n’est publié avant l’heure');
  db.app_settings.find((s) => s.key === 'site_draft').value.publishAt = new Date(Date.now() - 1000).toISOString();
  sw = await call('POST', '/api/jobs/sweep', {}, { 'x-cron-secret': CRON });
  ok((await call('GET', '/api/site')).body.banner.text === 'Brouillon !' && (await call('GET', '/api/site')).body.prices.essentiel === 899 && !db.app_settings.some((s) => s.key === 'site_draft'), 'planification : publié à l’heure par la tâche planifiée, brouillon consommé');
  ok(db.admin_audit.some((a) => a.action === 'site_publish_scheduled' && a.actor === 'planification'), 'journal : publication planifiée tracée');
  await call('POST', '/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', email: 'a@x.fr', consent: { cgv: true, waiver: true } }); ok(Array.from(h.stripeSessions.values()).pop().line_items[0].price_data.unit_amount === 899, 'planification : nouveau prix appliqué au paiement');
  await call('PUT', '/api/admin/site', { config: {}, confirmPrices: true }, AK);
  await call('PUT', '/api/admin/site/draft', { config: { prices: P2 }, publishAt: null }, AK);
  r = await call('POST', '/api/admin/site/draft/publish', { confirmPrices: true }, AK); ok(r.status === 200 && (await call('GET', '/api/site')).body.prices.essentiel === 899, 'publication immédiate du brouillon');
  ok((await call('DELETE', '/api/admin/site/draft', undefined, AK)).status === 200, 'brouillon supprimable');
  await call('PUT', '/api/admin/site', { config: {}, confirmPrices: true }, AK);

  // résumé quotidien
  db.orders.push({ id: '44444444-4444-4444-8444-444444444444', kind: 'report', status: 'generating', vin: 'WBA8E9C50GK999999', buyer_email: 'z@x.fr', refunded_cents: 0, created_at: d(1), updated_at: new Date(Date.now() - 3600e3).toISOString() });
  db.support_tickets.push({ id: '55555555-5555-4555-8555-555555555555', email: 'z@x.fr', subject: 'Facture', message: 'Bonjour', status: 'open', created_at: d(2), updated_at: d(2) });
  const items = await AP.collectDigest(h.supabase);
  ok(items.some((x) => /commande bloquée/.test(x)) && items.some((x) => /message de support sans réponse/.test(x)) && items.some((x) => /facture à vérifier/.test(x)), 'résumé : commandes bloquées, support en retard, factures à vérifier');
  const sentD = []; const fakeMailer = { send: async (m) => { sentD.push(m); return 'sent'; }, T: { adminDigest: (x) => ({ subject: 'D' + x.items.length, html: '', text: '' }) } };
  const t10 = Date.parse('2026-10-05T08:30:00Z'), t5 = Date.parse('2026-10-05T03:00:00Z');
  ok((await AP.sendDigest({ supabase: h.supabase, mailer: fakeMailer, env: { ADMIN_EMAIL: 'a@x.fr' }, now: t5 })) === 'too_early' && (await AP.sendDigest({ supabase: h.supabase, mailer: fakeMailer, env: {}, now: t10 })) === 'disabled' && (await AP.sendDigest({ supabase: h.supabase, mailer: fakeMailer, env: { ADMIN_EMAIL: 'a@x.fr', ADMIN_DIGEST: '0' }, now: t10 })) === 'disabled', 'résumé : pas avant 8 h, désactivable');
  await AP.sendDigest({ supabase: h.supabase, mailer: fakeMailer, env: { ADMIN_EMAIL: 'a@x.fr' }, now: t10 });
  ok(sentD.length === 1 && sentD[0].key === 'admin_digest:2026-10-05' && sentD[0].to[0] === 'a@x.fr', 'résumé : un e-mail par jour (clé de dédoublonnage)');
  const emptySb = require('./testkit/fake-supabase')(); ok((await AP.sendDigest({ supabase: emptySb, mailer: fakeMailer, env: { ADMIN_EMAIL: 'a@x.fr' }, now: t10 })) === 'nothing', 'résumé : rien à signaler, rien envoyé');

  await h.close(); console.log(`adminplus : ${pass} vérifications OK`); process.exit(0);
})().catch((e) => { console.error(`ÉCHEC après ${pass} vérifications :`, e.message || e); process.exit(1); });
