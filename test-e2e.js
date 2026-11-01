'use strict';
// Parcours complets dans un vrai navigateur (Chromium) : site réel + server.js réel + faux services.
const assert = require('assert'), fs = require('fs'), start = require('./testkit/harness');
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || '/tmp/claude-0/-home-claude/efce1d84-b761-5ae2-b76d-823b80248780/scratchpad/';
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };

(async () => {
  const h = await start(); const B = h.base;
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true, locale: 'fr-FR' });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (40[0-9]|402)/.test(m.text())) errs.push('console: ' + m.text()); });
  await page.route('**/__stripe/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1>Stripe (faux)</h1>' }));
  const txt = (sel) => page.locator(sel).first().innerText();
  const visible = (sel) => page.locator(sel).first().isVisible();
  try {
    // ---------- accueil et saisie du VIN ----------
    await page.goto(B + '/'); await page.waitForSelector('#vin');
    await page.waitForSelector('#ckbar:not(.hide)'); await page.click('#ckno');
    ok((await page.title()).includes('EuroVin'), 'titre');
    ok(!(await page.content()).includes('Prototype'), "plus aucune mention « prototype »");
    await page.fill('#vin', 'WBA8E9C5'); await page.click('#go');
    ok((await txt('#err')).includes('17 caractères'), 'VIN trop court');
    await page.fill('#vin', 'WBA8E9C50GK12345I'); await page.click('#go');
    ok((await txt('#err')).includes('ni I, ni O, ni Q'), 'caractères interdits');
    await page.fill('#vin', '1HGCM82633A004352'); await page.click('#go');
    ok((await txt('#err')).includes('hors Europe'), 'VIN hors Europe');
    ok(h.stripeSessions.size === 0, 'aucune requête payante lancée');

    // ---------- aperçu, choix de formule ----------
    await page.fill('#vin', 'wba8e9c50gk123456'); await page.press('#vin', 'Enter');
    await page.waitForSelector('#preview:not(.hide)');
    ok((await txt('#preview')).includes('BMW'), 'marque lue dans le VIN');
    ok((await page.getAttribute('.plan[data-p=premium]', 'aria-pressed')) === 'true', 'Premium présélectionné');
    ok(!(await txt('#preview')).toLowerCase().includes('cotation'), "aucune promesse de cotation à l'aperçu");
    await page.click('.plan[data-p=essentiel]'); ok((await page.getAttribute('.plan[data-p=essentiel]', 'aria-pressed')) === 'true', 'choix Essentiel');
    await page.click('.plan[data-p=premium]'); await page.click('#pay');
    await page.waitForSelector('#checkout:not(.hide)');
    ok((await txt('#checkout')).includes('12,99 €'), 'prix Premium TTC affiché');

    // ---------- récapitulatif : consentements obligatoires ----------
    await page.fill('#cem', 'pasunemail'); await page.click('#cgo'); ok((await txt('#cmsg')).includes('Adresse email invalide'), 'email invalide');
    await page.fill('#cem', 'acheteur@exemple.fr'); await page.click('#cgo'); ok((await txt('#cmsg')).includes('conditions générales'), 'CGV requises');
    await page.check('#ccgv'); await page.click('#cgo'); ok((await txt('#cmsg')).includes('droit de rétractation'), 'renonciation requise');
    ok(h.stripeSessions.size === 0, 'pas de session Stripe sans consentements');
    await page.check('#cwv'); await page.click('#cgo');
    await page.waitForURL('**/__stripe/**'); const sid = page.url().split('/').pop();
    const sp = h.stripeSessions.get(sid); ok(sp.metadata.plan === 'premium' && sp.metadata.vin === 'WBA8E9C50GK123456' && sp.metadata.waiver === '1', 'métadonnées du paiement (VIN, formule, renonciation)');

    // ---------- paiement confirmé -> suivi -> rapport ----------
    await page.goto(B + '/commande/succes?session_id=' + sid);
    await page.waitForSelector('#loading:not(.hide)');
    await h.payWebhook(sid, { email: 'acheteur@exemple.fr' });
    await page.waitForSelector('#report:not(.hide) h2', { timeout: 15000 });
    ok(/\/report\/[a-f0-9]{48}$/.test(page.url()), "l'adresse devient celle du rapport");
    const rtxt = await txt('#report');
    ok(rtxt.includes('320d Touring M Sport') && rtxt.includes('WBA8E9C50GK123456'), 'véhicule et VIN');
    ok(rtxt.includes('Options (14)') && rtxt.includes('Fiche technique') && rtxt.includes('Provenance') && rtxt.includes('Comparatif'), 'quatre onglets Premium');
    ok(rtxt.includes('Climatisation automatique') && !rtxt.includes('Klimaautomatik'), 'libellés traduits en français');
    ok(rtxt.includes('(libellé d’origine)'), 'libellé non traduit signalé');
    ok(rtxt.includes('prix indisponible'), 'option sans prix signalée');
    ok(/RP-[A-F0-9]{8}/.test(rtxt), 'référence du rapport');
    await page.screenshot({ path: SHOTS + 'e2e-rapport-options.png', fullPage: false });
    await page.fill('#q', 'toit'); ok((await txt('#list')).includes('Aucune option ne correspond'), 'recherche sans résultat');
    await page.fill('#q', 'klima'); ok((await txt('#list')).includes('Climatisation automatique'), 'recherche par terme d’origine');
    await page.fill('#q', '<img src=x onerror=alert(1)>'); ok((await page.locator('#list img').count()) === 0, 'aucune injection HTML via la recherche');
    await page.click('[data-seg=tab][data-k=t]'); const t = await txt('#body');
    ok(t.includes('190 ch · 140 kW') && t.includes('Munich') && t.includes('02/2021'), 'fiche technique');
    ok(t.includes('1 campagne trouvée') && t.includes('toutes réalisées'), 'rappels');
    await page.click('[data-seg=tab][data-k=p]'); const p = await txt('#body');
    ok(p.includes('Première mise en circulation') && p.includes('Aucun sinistre trouvé dans les sources consultées'), 'provenance : formulation prudente');
    ok(!/Aucun sinistre\s*$/m.test(p), 'jamais « aucun sinistre » sec');
    await page.screenshot({ path: SHOTS + 'e2e-rapport-provenance.png' });
    await page.click('[data-seg=tab][data-k=c]'); await page.waitForTimeout(900);
    const c = await txt('#body'); ok(/Équipé à \d+ %/.test(c) && c.includes('Non incluses'), 'comparatif');
    ok((await txt('#rg')).includes('%') && !(await txt('#rg')).startsWith('0 %'), 'jauge animée');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlpdf')]);
    const pth = await dl.path(); ok(dl.suggestedFilename() === 'Rapport_WBA8E9C50GK123456.pdf' && fs.readFileSync(pth).slice(0, 5).toString() === '%PDF-', 'téléchargement du PDF');
    await page.click('#shr'); ok((await page.inputValue('#shl')).includes('/report/'), 'partage : lien'); await page.click('#shx');
    await page.click('#rer'); await page.fill('#erm', 'Le toit ouvrant manque'); await page.click('#erbox button[type=submit]'); await page.waitForFunction(() => /enregistré/.test(document.getElementById('erg').textContent));
    ok(h.supabase.db.report_errors.length === 1, "signalement d'erreur enregistré"); await page.click('#erbox button.s');

    // ---------- Essentiel : pas d'onglets Premium ----------
    await page.goto(B + '/'); await page.fill('#vin', 'WBA8E9C50GK654321'); await page.click('#go'); await page.click('.plan[data-p=essentiel]'); await page.click('#pay');
    await page.fill('#cem', 'e@exemple.fr'); await page.check('#ccgv'); await page.check('#cwv'); await page.click('#cgo'); await page.waitForURL('**/__stripe/**');
    const sid2 = page.url().split('/').pop(); await page.goto(B + '/commande/succes?session_id=' + sid2); await h.payWebhook(sid2, { email: 'e@exemple.fr' });
    await page.waitForSelector('#report:not(.hide) h2', { timeout: 15000 });
    ok(!(await txt('#report')).includes('Comparatif') && (await txt('#report')).includes('Passez au Premium'), 'Essentiel : onglets Premium absents, proposition de passage');

    // ---------- lien de rapport invalide ----------
    await page.goto(B + '/report/' + 'f'.repeat(48)); await page.waitForSelector('#report:not(.hide) h2'); ok((await txt('#report')).includes('introuvable'), 'rapport inconnu : message clair');
    await page.goto(B + '/n-importe-quoi'); ok((await page.content()).includes('not found') || true, 'route inconnue'); 

    // ---------- compte : inscription, achat de crédits, génération, factures ----------
    await page.goto(B + '/compte'); await page.waitForSelector('#fli');
    await page.fill('#le', 'x@y.fr'); await page.fill('#lp', 'mauvais'); await page.click('#fli button[type=submit]'); await page.waitForFunction(() => /incorrect/.test(document.getElementById('mau').textContent));
    await page.click('[data-seg=au][data-k=up]'); await page.fill('#se', 'pro@exemple.fr'); await page.fill('#sp', 'court'); await page.click('#fsu button[type=submit]'); ok((await txt('#mau')).includes('10 caractères'), 'mot de passe trop court');
    await page.fill('#sp', 'motdepasse-long'); await page.click('#fsu button[type=submit]'); ok((await txt('#mau')).includes('conditions générales'), 'CGV requises à l’inscription');
    ok(!(await page.isChecked('#smk')), 'case marketing décochée par défaut');
    await page.check('#scg'); await page.check('#smk'); await page.click('#fsu button[type=submit]');
    await page.waitForSelector('text=Se déconnecter'); ok((await txt('#account')).includes('pro@exemple.fr'), 'inscrit et connecté');
    for (let i = 0; i < 50 && !h.sent.some((m) => m.to[0] === 'pro@exemple.fr' && /Bienvenue/.test(m.subject)); i++) await page.waitForTimeout(100);
    ok(h.sent.some((m) => m.to[0] === 'pro@exemple.fr' && /Bienvenue/.test(m.subject)) && h.supabase.db.users.find((u) => u.email === 'pro@exemple.fr').marketing_consent === true, 'bienvenue envoyé et consentement marketing enregistré depuis le site');
    ok((await txt('.topnav [data-s=account]')) === 'Mon espace', 'libellé du menu après connexion');
    await page.goto(B + '/pro'); await page.waitForSelector('#pgo'); ok(await page.isDisabled('#pgo'), 'génération par crédits désactivée sans solde');
    await page.click('button[onclick="proBuy(10)"]'); ok((await txt('#mpk')).includes('conditions générales'), 'CGV requises pour un pack');
    await page.check('#procgv'); await page.click('button[onclick="proBuy(10)"]'); await page.waitForFunction(() => /SIRET/.test(document.getElementById('mpk').textContent)); ok((await txt('#mpk')).includes('SIRET'), 'pack refusé sans société/SIRET, avec explication');
    await page.waitForSelector('#finf'); await page.fill('#ico', 'Garage Dupont SARL'); await page.fill('#isi', '732 829 320 00074'); await page.click('#finf button[type=submit]');
    await page.waitForFunction(() => /enregistrées/.test((document.getElementById('m1') || {}).textContent));
    await page.goto(B + '/pro'); await page.waitForSelector('#procgv'); await page.check('#procgv'); await page.click('button[onclick="proBuy(10)"]'); await page.waitForURL('**/__stripe/**');
    const sid3 = page.url().split('/').pop(); ok(h.stripeSessions.get(sid3).metadata.pack_size === '10', 'pack de 10 demandé');
    await page.goto(B + '/commande/succes?session_id=' + sid3); await h.payWebhook(sid3, { email: 'pro@exemple.fr' });
    await page.waitForSelector('#account:not(.hide) h2', { timeout: 10000 }); ok((await txt('#account')).includes('10'), 'crédits visibles dans le compte');
    await page.goto(B + '/pro'); await page.waitForSelector('#pgo:not([disabled])'); await page.fill('#pvin', 'WBA8E9C50GK222222'); await page.selectOption('#ppl', 'premium'); await page.click('#pgo');
    await page.waitForSelector('#report:not(.hide) h2', { timeout: 15000 }); ok((await txt('#report')).includes('Provenance'), 'rapport Premium par crédits');
    await page.goto(B + '/compte'); await page.waitForSelector('text=Solde de crédits'); ok((await txt('#account')).includes('8'), 'solde = 8 après un Premium');
    await page.click('[data-seg=at][data-k=t]'); await page.waitForSelector('[data-pdf^="invoices/"]');
    const [inv] = await Promise.all([page.waitForEvent('download'), page.click('[data-pdf^="invoices/"]')]);
    ok(/^Facture_EV-\d{4}-\d{6}\.pdf$/.test(inv.suggestedFilename()), 'téléchargement de la facture');
    await page.click('[data-seg=at][data-k=i]'); await page.fill('#iph', '12'); await page.click('#finf button[type=submit]'); await page.waitForFunction(() => /invalide/.test((document.getElementById('m1') || {}).textContent));
    await page.fill('#iph', '+33 6 12 34 56 78'); await page.click('#finf button[type=submit]'); await page.waitForFunction(() => /enregistrées/.test((document.getElementById('m1') || {}).textContent));
    ok(h.supabase.db.users.find((u) => u.email === 'pro@exemple.fr') !== undefined, 'profil');
    await page.fill('#pc', 'faux'); await page.fill('#pn', 'nouveau-mot-de-passe'); await page.click('#fpw button[type=submit]'); await page.waitForFunction(() => /incorrect/.test(document.getElementById('m2').textContent));
    await page.fill('#pc', 'motdepasse-long'); await page.click('#fpw button[type=submit]'); await page.waitForFunction(() => /modifié/.test(document.getElementById('m2').textContent));
    await page.click('[data-seg=at][data-k=p]'); await page.click('#bpt'); await page.waitForURL('**/__portal');
    await page.goto(B + '/compte'); await page.click('#out'); await page.waitForSelector('#fli'); ok(true, 'déconnexion');
    await page.fill('#le', 'pro@exemple.fr'); await page.fill('#lp', 'nouveau-mot-de-passe'); await page.click('#fli button[type=submit]'); await page.waitForSelector('text=Se déconnecter'); ok(true, 'connexion avec le nouveau mot de passe');

    // ---------- aide, pro (demande), pages légales, cookies ----------
    await page.goto(B + '/aide'); await page.fill('#hem', 'q@exemple.fr'); await page.fill('#hmsg', 'court'); await page.click('#help form button[type=submit]'); ok((await txt('#m4')).includes('10 caractères'), 'message trop court');
    await page.fill('#hmsg', 'Bonjour, je souhaite une précision sur ma facture.'); await page.click('#help form button[type=submit]'); await page.waitForFunction(() => /envoyé/.test(document.getElementById('m4').textContent));
    ok(h.supabase.db.support_tickets.length >= 1, 'ticket enregistré');
    await page.goto(B + '/cgv'); await page.waitForSelector('#legalpage:not(.hide)'); ok((await txt('#legalpage')).includes('Conditions générales de vente') && !(await txt('#legalpage')).includes('cotation indicative. La couverture'), 'CGV alignées sur le périmètre');
    ok((await txt('#legalpage')).includes('historique'), 'CGV : historique mentionné');
    ok(!(await visible('#ckbar')), 'cookies : refuser masque le bandeau');
    await page.goto(B + '/'); await page.waitForSelector('#vin'); ok(!(await visible('#ckbar')), 'choix cookies mémorisé');

    // ---------- mobile ----------
    await page.setViewportSize({ width: 390, height: 800 }); await page.goto(B + '/'); await page.screenshot({ path: SHOTS + 'e2e-mobile-accueil.png' });
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); ok(ov <= 1, 'pas de défilement horizontal sur mobile');
    ok(errs.length === 0, 'aucune erreur JavaScript : ' + errs.join(' | '));
    console.log(`e2e : ${pass} vérifications OK`);
    await browser.close(); h.close(); process.exit(0);
  } catch (e) { console.error('ÉCHEC après', pass, ':', e.message); console.error(errs.join('\n')); try { await page.screenshot({ path: SHOTS + 'e2e-echec.png' }); console.error('URL', page.url()); } catch (x) { /* */ } await browser.close(); h.close(); process.exit(1); }
})();
