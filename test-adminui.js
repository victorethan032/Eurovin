'use strict';
// Console d'administration (nouveautés) dans un vrai navigateur : compte personnel, rôles, graphiques, promo, textes d'e-mails, recherche, brouillon du site.
const start = require('./testkit/harness');
const { chromium } = require('playwright');
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };

(async () => {
  const KEY = 'a'.repeat(40);
  const h = await start({ env: { ADMIN_EMAIL: 'admin@x.fr', SELLER_NAME: 'Test SAS', SELLER_SIREN: '732829320', SELLER_ADDRESS: '1 rue X, 75001 Paris', SELLER_VAT: 'FR40732829320', SELLER_EMAIL: 'c@x.fr', SELLER_LEGAL_FORM: 'SAS' } });
  const B = h.base;
  const api = (m, p, body) => fetch(B + p, { method: m, headers: { 'content-type': 'application/json', 'x-admin-key': KEY }, body: body === undefined ? undefined : JSON.stringify(body) }).then((r) => r.json());
  const vwr = await api('POST', '/api/admin/team', { email: 'lecteur@x.fr', role: 'viewer', name: 'Léa' });
  h.supabase.db.orders.push({ id: '11111111-1111-4111-8111-111111111111', kind: 'report', vin: 'WBA8E9C50GK111111', plan: 'essentiel', status: 'paid', buyer_email: 'client@x.fr', amount_ttc_cents: 799, created_at: new Date().toISOString() });

  const day0 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
  h.supabase.db.funnel_daily.push({ day: day0, step: 'lookup', brand: 'BMW', n: 9 }, { day: day0, step: 'lookup', brand: 'Peugeot', n: 6 }, { day: day0, step: 'checkout', brand: 'BMW', n: 3 }, { day: day0, step: 'opened', brand: 'BMW', n: 1 });
  h.supabase.db.users.push({ id: '22222222-2222-4222-8222-222222222222', email: 'pro@garage.fr', role: 'pro', credits_balance: 12, company_name: 'Garage Test', created_at: new Date().toISOString() });
  h.supabase.db.orders.push({ id: '33333333-3333-4333-8333-333333333333', kind: 'pack', user_id: '22222222-2222-4222-8222-222222222222', status: 'delivered', buyer_email: 'pro@garage.fr', amount_ttc_cents: 5880, amount_tax_cents: 980, refunded_cents: 0, created_at: new Date().toISOString() });
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'fr-FR' });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (40[0-9]|50[0-9])/.test(m.text())) errs.push('console: ' + m.text()); });
  const tabs = () => page.locator('#tabs button').allInnerTexts();
  const tab = async (name) => { await page.locator('#tabs button', { hasText: name }).click(); await page.waitForTimeout(400); };
  try {
    // --- clé de secours : propriétaire, tous les onglets ---
    await page.goto(B + '/admin'); await page.waitForSelector('#flogin');
    ok(await page.locator('#facc').isVisible(), 'connexion par compte personnel affichée');
    await page.fill('#akey', KEY); await page.fill('#aname', 'Victor'); await page.click('#flogin button');
    await page.waitForSelector('#app:not(.hide)');
    let t = await tabs();
    ok(['Codes promo', 'Textes e-mails', 'Équipe', 'Site'].every((x) => t.includes(x)) && !t.includes('Mon compte'), 'propriétaire (clé) : tous les onglets sauf Mon compte');
    await page.waitForTimeout(500);
    ok(/Chiffre d’affaires|Qualité des rapports|Marge/i.test(await page.locator('#view').innerText()), 'tableau de bord : graphiques / qualité / marge');
    ok(await page.locator('#view svg').count() > 0, 'tableau de bord : graphique SVG');
    ok((await page.locator('#chcard').innerText()).includes('net TTC par jour'), 'graphique : TTC par défaut');
    await page.locator('#chmode [data-m=ht]').click();
    ok((await page.locator('#chcard').innerText()).includes('hors taxes par jour') && (await page.locator('#chcard h3').innerText()).includes('hors taxes') && (await page.locator('#chmode [data-m=ht]').getAttribute('aria-pressed')) === 'true', 'graphique : bascule vers le hors taxes');
    await page.locator('#chmode [data-m=ttc]').click();
    ok((await page.locator('#chcard h3').innerText()).includes('TTC'), 'graphique : retour au TTC');

    // --- nouvelles cartes : comparaison, objectif, entonnoir, marques, crédits Pro, TVA, santé technique ---
    const dv = await page.locator('#view').innerText();
    ok(dv.includes('jours précédents') && dv.includes('Objectif du mois') && dv.includes('Entonnoir de conversion') && dv.includes('Marques recherchées sans achat') && dv.includes('Clients Pro : usage des crédits') && dv.includes('TVA et encaissements') && dv.includes('Santé technique') && dv.includes('Alertes rappel') && dv.includes('Désactivées'), 'tableau de bord : toutes les nouvelles cartes affichées (alertes rappel désactivées par défaut)');
    ok(dv.includes('VIN saisi') && dv.includes('Peugeot') && dv.includes('Garage Test') && dv.includes('Jamais utilisé'), 'entonnoir, marques et crédits Pro alimentés par les données');
    await page.fill('#gv', '1500,00'); await page.click('#fgoal button'); await page.waitForFunction(() => document.getElementById('goalcard').innerText.includes('Au rythme actuel'), null, { timeout: 5000 });
    ok((await page.locator('#goalcard').innerText()).includes('Au rythme actuel'), 'objectif : enregistré, avancement et projection affichés');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#rcc')]);
    ok(/^recapitulatif-\d{4}-\d{2}\.csv$/.test(dl.suggestedFilename()), 'récapitulatif : téléchargement du CSV');
    const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('#rcp')]);
    ok(dl2.suggestedFilename().endsWith('.pdf'), 'récapitulatif : téléchargement du PDF');

    // --- ce qui se vend / ne se vend pas ---
    ok((await page.locator('#slcard h3').innerText()).includes('Ce qui se vend'), 'ventes : « ce qui se vend » par défaut');
    await page.locator('#slmode [data-m=unsold]').click();
    const ut = await page.locator('#slcard').innerText();
    ok((await page.locator('#slcard h3').innerText()).includes('ne se vend pas') && ut.includes('Pack 100 crédits') && ut.includes('Aucune vente') && ut.includes('Taux d’abandon'), 'invendus : offres sans vente et abandons listés');
    await page.locator('#slmode [data-m=sell]').click(); ok((await page.locator('#slcard h3').innerText()).includes('Ce qui se vend'), 'ventes : retour à « ce qui se vend »');

    // --- marge : estimée / réelle, et saisie des charges ---
    ok((await page.locator('#mgcard h3').innerText()).includes('estimée'), 'marge : estimée par défaut');
    await page.locator('#mgmode [data-m=real]').click();
    ok((await page.locator('#mgcard h3').innerText()).includes('réelle') && (await page.locator('#mgcard').innerText()).includes('Charges saisies') && (await page.locator('#mgmode [data-m=real]').getAttribute('aria-pressed')) === 'true', 'marge : bascule vers la marge réelle');
    await page.locator('#mgmode [data-m=est]').click(); ok((await page.locator('#mgcard h3').innerText()).includes('estimée'), 'marge : retour à l’estimation');

    // --- recherche globale ---
    await page.fill('#gq', 'client@x.fr'); await page.click('#gs button'); await page.waitForSelector('#gsr [data-open]');
    ok((await page.locator('#gsr').innerText()).includes('client@x.fr'), 'recherche : résultat trouvé');
    await page.locator('#gsr [data-open]').first().click(); await page.waitForTimeout(600);
    ok((await page.locator('#view').innerText()).toLowerCase().includes('client@x.fr') || (await page.locator('#view').innerText()).includes('WBA8E9C50GK111111'), 'recherche : ouvre la fiche');

    // --- codes promo ---
    await tab('Codes promo'); await page.waitForSelector('#view form');
    await page.fill('#prc', 'bienvenue10'); await page.fill('#prv', '10'); await page.fill('#prm', '5'); await page.click('#fpr button');
    await page.waitForFunction(() => document.getElementById('view').innerText.includes('BIENVENUE10'), null, { timeout: 5000 });
    ok((await page.locator('#view tbody').innerText()).includes('10 %') && (await page.locator('#view tbody').innerText()).includes('0 / 5'), 'promo : code créé (10 %, 5 utilisations max)');
    await page.locator('[data-pid]').first().click(); await page.waitForFunction(() => document.getElementById('view').innerText.includes('Désactivé'), null, { timeout: 5000 });
    ok(true, 'promo : code désactivé');
    await page.fill('#prc', 'x'); await page.fill('#prv', '10'); await page.click('#fpr button'); await page.waitForFunction(() => document.getElementById('prmsg').textContent.includes('invalide'));
    ok(true, 'promo : code invalide refusé');

    // --- charges réelles (Paramètres) ---
    await tab('Paramètres'); await page.waitForSelector('#fexp');
    await page.fill('#xl', 'Facture fournisseur'); await page.selectOption('#xc', 'donnees'); await page.fill('#xa', '50,00'); await page.click('#fexp button');
    await page.waitForFunction(() => { const t = document.querySelector('#fexp ~ .tw tbody'); return t && t.innerText.includes('Facture fournisseur'); }, null, { timeout: 5000 });
    ok((await page.locator('#fexp ~ .tw tbody').innerText()).includes('50,00'), 'charges : ajoutée dans Paramètres');
    await tab('Tableau de bord'); await page.waitForSelector('#mgmode'); await page.locator('#mgmode [data-m=real]').click();
    ok((await page.locator('#mgcard').innerText()).includes('Données véhicule') && (await page.locator('#mgcard').innerText()).includes('50,00'), 'marge réelle : la charge saisie est déduite');
    await tab('Paramètres'); await page.waitForSelector('#fexp'); await page.locator('[data-xid]').first().click(); await page.locator('[data-xid]').first().click();
    await page.waitForFunction(() => { const t = document.querySelector('#fexp ~ .tw tbody'); return t && !t.innerText.includes('Facture fournisseur'); }, null, { timeout: 5000 });
    ok(true, 'charges : supprimée (double confirmation)');

    // --- textes e-mails ---
    await tab('Textes e-mails'); await page.waitForTimeout(400);
    ok((await page.locator('#view').innerText()).length > 100, 'écran textes e-mails');

    // --- équipe ---
    await tab('Équipe'); await page.waitForTimeout(400);
    ok((await page.locator('#view').innerText()).includes('lecteur@x.fr'), 'équipe : membre listé');

    // --- site : brouillon ---
    await tab('Site'); await page.waitForTimeout(500);
    ok(/brouillon|Brouillon/.test(await page.locator('#view').innerText()), 'site : brouillon disponible');

    // --- compte personnel (lecteur) : mot de passe provisoire => seul « Mon compte » ---
    await page.locator('#lo').click(); await page.waitForSelector('#facc');
    await page.fill('#aem', 'lecteur@x.fr'); await page.fill('#apw', 'mauvais-mot-de-passe'); await page.click('#facc button');
    await page.waitForFunction(() => document.getElementById('amsg').textContent.includes('incorrects'));
    ok(true, 'compte : mauvais mot de passe refusé');
    await page.fill('#apw', vwr.tempPassword); await page.click('#facc button'); await page.waitForSelector('#app:not(.hide)');
    t = await tabs(); ok(t.length === 1 && t[0] === 'Mon compte', 'mot de passe provisoire : seul l’onglet Mon compte');
    ok(await page.locator('#gs').isHidden(), 'recherche masquée tant que le compte est restreint');
    await page.waitForSelector('#fpw');
    await page.fill('#pw0', vwr.tempPassword); await page.fill('#pw1', 'Nouveau-mot-de-passe-2026'); await page.fill('#pw2', 'Nouveau-mot-de-passe-2026'); await page.locator('#fpw button').click();
    await page.waitForFunction(() => document.querySelectorAll('#tabs button').length > 1, null, { timeout: 8000 }).catch(() => {});
    t = await tabs();
    if (t.length === 1) { // la session a pu être fermée par le changement de mot de passe : reconnexion
      await page.waitForSelector('#facc:visible', { timeout: 3000 }).catch(() => {});
      if (await page.locator('#facc').isVisible()) { await page.fill('#aem', 'lecteur@x.fr'); await page.fill('#apw', 'Nouveau-mot-de-passe-2026'); await page.click('#facc button'); await page.waitForSelector('#app:not(.hide)'); t = await tabs(); }
    }
    ok(t.includes('Tableau de bord') && t.includes('Mon compte') && t.includes('Commandes'), 'lecteur : onglets de consultation et Mon compte : ' + t.join(','));
    ok(!t.includes('Équipe'), 'lecteur : pas d’onglet Équipe');
    await page.locator('#lo').click(); await page.waitForSelector('#facc');
    ok(errs.length === 0, 'aucune erreur de console : ' + errs.join(' | '));
  } catch (e) { await page.screenshot({ path: '/tmp/adminui-fail.png' }).catch(() => {}); console.error(e.message, errs); await browser.close(); await h.close(); process.exit(1); }
  await browser.close(); await h.close();
  console.log('admin UI : ' + pass + ' vérifications OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
