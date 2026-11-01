'use strict';
// Console d'administration : API (profil exploitant, santé, réponse support, liste blanche IP) + parcours dans un vrai navigateur.
const assert = require('assert'), start = require('./testkit/harness');
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || '/tmp/claude-0/-home-claude/efce1d84-b761-5ae2-b76d-823b80248780/scratchpad/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

(async () => {
  const KEY = 'a'.repeat(40);
  const h = await start({ env: { ENFORCE_SELLER: '1', SELLER_NAME: '', ADMIN_EMAIL: 'admin@x.fr' } });
  const B = h.base, db = h.supabase.db, AK = { 'x-admin-key': KEY };
  const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const put = (p, body, headers = {}) => fetch(B + p, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const get = (p, headers = {}) => fetch(B + p, { headers }).then(J);
  const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } throw new Error('timeout'); };
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true, locale: 'fr-FR' });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (40[0-9]|50[0-9])/.test(m.text())) errs.push('console: ' + m.text()); });
  const txt = (s) => page.locator(s).first().innerText();
  try {
    // --- page et sécurité d'accès ---
    let r = await fetch(B + '/admin'); const html = await r.text();
    ok(r.status === 200 && html.includes('Administration') && /noindex/.test(r.headers.get('x-robots-tag') || '') && /no-store/.test(r.headers.get('cache-control') || ''), 'page /admin : servie, non indexée, non mise en cache');
    ok((await get('/api/admin/stats')).status === 401 && (await get('/api/admin/settings', { 'x-admin-key': 'x'.repeat(40) })).status === 401, 'API admin : refusée sans bonne clé');
    process.env.ADMIN_IP_ALLOWLIST = '10.9.9.9';
    ok((await get('/api/admin/stats', AK)).status === 404 && (await fetch(B + '/admin')).status === 404, 'liste blanche IP : API et page invisibles hors liste');
    delete process.env.ADMIN_IP_ALLOWLIST;
    ok((await get('/api/admin/stats', AK)).status === 200, 'liste blanche retirée : accès rétabli');

    // --- vente suspendue tant que le profil de l'exploitant est incomplet ---
    const sc = await post('/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', email: 'a@x.fr', consent: { cgv: true, waiver: true } });
    ok(sc.status === 503 && sc.body.error === 'SELLER_INCOMPLETE', 'mentions légales incomplètes : vente suspendue (503)');
    const st0 = (await get('/api/admin/settings', AK)).body;
    ok(st0.enforced && st0.missing.includes('SELLER_NAME') && st0.missing.includes('SELLER_SIREN'), 'profil exploitant : champs manquants listés');
    for (const [bad, code] of [[{ siren: '123456780' }, 'SIREN_INVALID'], [{ siren: '732829320', vat: 'xx' }, 'VAT_INVALID'], [{ siren: '732829320', email: 'pas-un-mail' }, 'EMAIL_INVALID']])
      ok((await put('/api/admin/settings', { seller: { name: 'X', ...bad } }, AK)).body.error === code, 'validation : ' + code);
    const hc = (await get('/api/admin/health', AK)).body;
    ok(hc.checks.find((c) => c.key === 'seller').ok === false && !JSON.stringify(hc).includes(KEY), 'santé : réglage manquant signalé, aucun secret exposé');

    // --- navigateur : connexion ---
    await page.goto(B + '/admin'); await page.waitForSelector('#flogin');
    await page.fill('#akey', 'b'.repeat(40)); await page.click('#flogin button'); await page.waitForFunction(() => /incorrecte/.test(document.getElementById('lmsg').textContent));
    ok(true, 'mauvaise clé refusée dans l’interface');
    await page.fill('#akey', KEY); await page.fill('#aname', 'Victor'); await page.click('#flogin button');
    await page.waitForSelector('#app:not(.hide) .kpis'); ok((await txt('#who')).includes('Victor'), 'connecté, prénom affiché');
    ok((await txt('#view')).includes('réglage(s) obligatoire(s)'), 'tableau de bord : alerte sur les réglages obligatoires');
    await page.screenshot({ path: SHOTS + 'admin-dashboard.png' });

    // --- Paramètres : profil de l'exploitant ---
    await page.click('[data-t=set]'); await page.waitForSelector('#fs'); await page.screenshot({ path: SHOTS + 'admin-parametres.png', fullPage: false });
    await page.fill('#sn', 'EuroVin'); await page.fill('#sl', 'SAS'); await page.fill('#sc', '1 000 €'); await page.fill('#ss', '123456780'); await page.fill('#sr', 'RCS Lyon 732 829 320'); await page.fill('#sa', '1 rue de la République, 69001 Lyon'); await page.fill('#sv', 'FR40732829320'); await page.fill('#se', 'contact@eurovin.fr');
    await page.click('#fs button[type=submit]'); await page.waitForFunction(() => /SIREN invalide/.test(document.getElementById('sm').textContent)); ok(true, 'SIREN invalide refusé dans l’interface');
    await page.fill('#ss', '732829320'); await page.click('#fs button[type=submit]'); await page.waitForSelector('text=Mentions complètes');
    ok(db.app_settings.length === 1 && db.app_settings[0].value.siren === '732829320', 'profil exploitant enregistré en base');
    r = await post('/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', email: 'a@x.fr', consent: { cgv: true, waiver: true } });
    ok(r.status === 200, 'profil complet : la vente reprend');
    ok(db.admin_audit.some((x) => x.action === 'settings_seller' && x.actor === 'Victor' && String(x.payload.siren).startsWith('•••')), 'journal : action tracée, SIREN masqué');
    ok((await page.locator('#view .journal, #view').first().innerText()).includes('settings_seller'), 'journal visible dans l’interface');

    // --- commande, détail, remboursement partiel ---
    const sid = r.body.url.split('/').pop(); await h.payWebhook(sid, { email: 'a@x.fr', details: { name: 'Alice', address: { line1: '3 rue B', postal_code: '75001', city: 'Paris', country: 'FR' } } });
    await waitFor(() => db.orders.find((o) => o.stripe_session_id === sid && o.status === 'delivered'));
    const inv = db.invoices[0]; ok(inv.seller && inv.seller.name === 'EuroVin' && inv.seller.rcs.includes('732 829 320'), 'la facture reprend le profil saisi dans la console');
    await page.click('[data-t=orders]'); await page.fill('#oe', 'a@x.fr'); await page.click('#osr'); await page.waitForSelector('#ol tr[data-id]');
    await page.click('#ol tr[data-id]'); await page.waitForSelector('#odc');
    ok((await txt('#odc')).includes(inv.number) && (await txt('#odc')).includes('7,99'), 'détail : facture et montant');
    await page.screenshot({ path: SHOTS + 'admin-commande.png', fullPage: false });
    await page.fill('#ra', '2,00'); await page.click('[data-a=refund]'); await page.waitForFunction(() => /motif/i.test(document.getElementById('om').textContent)); ok(true, 'motif obligatoire pour rembourser');
    await page.fill('#rr', 'Geste commercial'); await page.click('[data-a=refund]'); ok((await page.locator('[data-a=refund]').innerText()) === 'Confirmer ?', 'double confirmation avant remboursement');
    ok(h.refunds.length === 0, 'rien n’est remboursé avant la confirmation');
    await page.click('[data-a=refund]'); await page.waitForFunction(() => /Avoir AV-/.test(document.getElementById('om').textContent));
    ok(h.refunds.length === 1 && h.refunds[0].amount === 200 && db.credit_notes.length === 1, 'remboursement partiel de 2,00 € + avoir');
    ok(h.sent.some((m) => m.to[0] === 'a@x.fr' && /avoir/i.test(m.subject)), 'client prévenu par e-mail');

    // --- clients : crédits et type de compte ---
    const su = await fetch(h.gotrueUrl + '/auth/v1/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'pro@garage.fr', password: 'motdepasse-long' }) }).then(J);
    Object.assign(db.users.find((u) => u.email === 'pro@garage.fr'), { company_name: 'Garage Dupont', company_siret: '73282932000074' });
    await page.click('[data-t=users]'); await page.fill('#ue', 'inconnu@x.fr'); await page.click('#usr'); await page.waitForFunction(() => /Aucun compte/.test(document.getElementById('um').textContent)); ok(true, 'client inconnu signalé');
    await page.fill('#ue', 'pro@garage.fr'); await page.click('#usr'); await page.waitForSelector('#cd'); ok((await txt('#uc')).includes('Garage Dupont'), 'fiche client');
    await page.fill('#cd', '5'); await page.fill('#cr', 'Geste commercial'); await page.click('[data-a=credits]'); await page.click('[data-a=credits]');
    await page.waitForFunction(() => /prévenu par e-mail/.test(document.getElementById('uam').textContent));
    ok(db.users.find((u) => u.email === 'pro@garage.fr').credits_balance === 5 && h.sent.some((m) => m.to[0] === 'pro@garage.fr' && /crédits? ajouté/.test(m.subject)), '+5 crédits appliqués, client prévenu');
    await page.click('[data-a=role][data-r=pro]'); await page.click('[data-a=role][data-r=pro]'); await page.waitForFunction(() => /Passer en Pro/.test(document.body.innerText) && document.querySelector('[data-a=role][data-r=pro]').disabled);
    ok(db.users.find((u) => u.email === 'pro@garage.fr').role === 'pro' && h.sent.some((m) => /compte Pro est activé/.test(m.subject)), 'passage en Pro + e-mail');

    // --- support : réponse au client ---
    const tk = await post('/api/support', { email: 'cli@x.fr', subject: 'Autre', message: 'Bonjour, ceci est une question assez longue.' }); ok(tk.status === 201, 'ticket créé');
    ok((await post(`/api/admin/tickets/${tk.body.ticket}/reply`, { message: 'x' }, AK)).status === 400, 'réponse trop courte refusée');
    await page.click('[data-t=support]'); await page.waitForSelector('[data-tk]'); ok((await txt('[data-tk]')).includes('cli@x.fr'), 'ticket listé');
    await page.fill('[data-tk] textarea', 'Bonjour, voici notre réponse détaillée.'); await page.click('[data-a=reply]');
    await waitFor(() => h.sent.find((m) => m.to[0] === 'cli@x.fr' && /Réponse à votre demande/.test(m.subject)));
    ok(h.sent.find((m) => m.to[0] === 'cli@x.fr' && /Réponse/.test(m.subject)).html.includes('voici notre réponse détaillée') && db.support_tickets[0].status === 'pending', 'réponse envoyée par e-mail, ticket « en attente »');

    // --- libellés ---
    db.untranslated_labels.push({ brand: 'BMW', code: 'ZZ9', label: 'Sonderausstattung', seen_count: 3 });
    await page.click('[data-t=labels]'); await page.waitForSelector('tr[data-i]'); await page.fill('tr[data-i] input', 'Équipement spécial'); await page.click('[data-a=save]');
    await waitFor(() => db.option_labels.some((x) => x.code === 'ZZ9' && x.label_fr === 'Équipement spécial')); ok(!db.untranslated_labels.some((x) => x.code === 'ZZ9'), 'libellé traduit enregistré et retiré de la file');

    // --- comptabilité : téléchargements ---
    await page.click('[data-t=acct]'); await page.waitForSelector('#mm');
    const cur = new Date().toISOString().slice(0, 7); await page.fill('#mm', cur);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-a=sum]')]); ok(/^TVA-par-pays_\d{4}-\d{2}\.csv$/.test(dl.suggestedFilename()), 'téléchargement de la synthèse TVA par pays');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('[data-a=det]')]); ok(/^Detail-pieces_/.test(dl2.suggestedFilename()), 'téléchargement du détail');
    ok((await txt('#view')).includes(inv.number), 'liste des factures et statut Pennylane'); await page.screenshot({ path: SHOTS + 'admin-compta.png', fullPage: false });

    // --- e-mails et marketing ---
    await page.click('[data-t=mail]'); await page.waitForSelector('[data-a=mk]'); const [dl3] = await Promise.all([page.waitForEvent('download'), page.click('[data-a=mk]')]); ok(/^inscrits-marketing-/.test(dl3.suggestedFilename()), 'liste Brevo téléchargeable');
    await page.click('[data-st=sent]'); await page.waitForSelector('#view td'); ok((await txt('#view')).includes('report_paid') || (await txt('#view')).includes('credit_note'), 'journal des e-mails envoyés');

    // --- déconnexion et responsive ---
    await page.setViewportSize({ width: 390, height: 800 }); await page.click('[data-t=dash]'); await page.waitForSelector('.kpis');
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'mobile : pas de défilement horizontal de la page');
    await page.screenshot({ path: SHOTS + 'admin-mobile.png' });
    await page.setViewportSize({ width: 1200, height: 900 }); await page.click('#lo'); await page.waitForSelector('#flogin:visible'); ok(true, 'déconnexion');
    await page.reload(); await page.waitForSelector('#flogin'); ok(!(await txt('body')).includes('Tableau de bord'), 'après déconnexion et rechargement : retour à la connexion');
    ok(errs.length === 0, 'aucune erreur console : ' + errs.join(' | '));
  } finally { await browser.close(); h.close(); }
  console.log(`admin : ${pass} vérifications OK`);
  process.exit(0);
})().catch((e) => { console.error(`ÉCHEC après ${pass} vérifications :`, e.message || e); process.exit(1); });
