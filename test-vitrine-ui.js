'use strict';
// Vitrine, côté navigateur (démo) : accueil enrichi, rapport d'exemple, « En un coup d'œil », page vendeur, aucun débordement sur téléphone.
const { execFileSync } = require('child_process'), path = require('path');
const { chromium } = require('playwright');
const file = (process.env.SHOTS || '/tmp/') + 'vitrine-demo.html';
execFileSync('node', [path.join(__dirname, 'build-demo.js'), file], { stdio: 'ignore' });
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  try {
    for (const [w, hh, mobile] of [[390, 844, true], [360, 740, true], [1280, 800, false]]) {
      const ctx = await b.newContext({ viewport: { width: w, height: hh }, isMobile: mobile, hasTouch: mobile }), page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      const txt = (s) => page.locator(s).innerText(), ovf = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.goto('file://' + file); await page.waitForSelector('#ckbar:not(.hide)'); await page.click('#ckno');
      const home = await txt('#home');
      ok(home.includes('Comment ça marche') && home.includes('Collez le VIN') && home.includes('Deux formules, un prix clair') && home.includes('Paiement sécurisé') && home.includes('Remboursé si insuffisant'), `${w}px accueil : étapes, comparatif et confiance`);
      ok((await page.locator('[data-pr=essentiel]').innerText()) === '7,99 € TTC' && (await page.locator('[data-pr=premium]').innerText()) === '12,99 € TTC', `${w}px accueil : prix du comparatif = prix de la configuration`);
      ok((await page.locator('.cmp .cr').count()) === 6 && (await page.locator('.cmp .n0').count()) === 2, `${w}px comparatif : 5 lignes, 2 « non inclus » pour l’Essentiel`);
      ok(await page.locator('[data-pr=premium]').isVisible() && await page.locator('[data-pr=essentiel]').isVisible(), `${w}px comparatif : les deux prix sont visibles à l’écran`);
      ok((await ovf()) <= 0, `${w}px accueil : aucun défilement horizontal (${await ovf()} px)`);
      // exemple
      await page.click('#ex'); await page.waitForSelector('#report:not(.hide) .glance');
      let t = await txt('#report');
      ok(t.includes('Exemple fictif') && t.includes('En un coup d’œil') && t.includes('Options décodées') && t.includes('Rappels constructeur') && t.includes('Provenance') && t.includes('Équipement vs catalogue'), `${w}px exemple : bannière fictive et résumé`);
      ok((await page.locator('#dlpdf, #shr, #slr, #rer').count()) === 0 && !t.includes('Lien valable'), `${w}px exemple : pas de PDF, partage, page vendeur ni signalement`);
      ok((await ovf()) <= 0, `${w}px exemple : aucun défilement horizontal (${await ovf()} px)`);
      await page.click('[data-gl=t]'); ok((await page.locator('[data-seg=tab][data-k=t]').getAttribute('aria-selected')) === 'true', `${w}px résumé : un clic ouvre l’onglet correspondant`);
      await page.click('#sc2'); await page.waitForSelector('#home:not(.hide)'); ok(true, `${w}px exemple : « Saisir mon VIN » ramène à l’accueil`);
      // achat -> rapport réel : résumé + page vendeur
      await page.fill('#vin', 'WP0ZZZ99ZTS392124'); await page.click('#go'); await page.waitForSelector('#preview:not(.hide)'); await page.click('#pay');
      await page.fill('#cem', 'a@b.fr'); await page.check('#ccgv'); await page.check('#cwv'); await page.click('#cgo'); await page.waitForSelector('#report:not(.hide) .glance', { timeout: 20000 });
      t = await txt('#report'); ok(t.includes('En un coup d’œil') && (await page.locator('#slr').count()) === 1 && t.includes('Comparatif'), `${w}px rapport : résumé et bouton Page vendeur`);
      await page.click('#slr'); await page.waitForSelector('#slon'); ok((await txt('#shbox')).includes('Le VIN est masqué'), `${w}px page vendeur : explication affichée`);
      await page.click('#slon'); await page.waitForSelector('#shl'); const link = await page.inputValue('#shl'); ok(/#\/rapport\/[a-f0-9]{48}$/.test(link) && (await page.locator('a[href="/badge-eurovin.png"]').count()) === 1, `${w}px page vendeur : lien distinct et badge`);
      await page.click('#shx'); const hash = link.slice(link.indexOf('#')); await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForSelector('.samp'); const pp = page; const pt = await pp.locator('#report').innerText();
      ok(pt.includes('Rapport partagé par le vendeur') && pt.includes('WP0ZZZ99ZTS••••••') && !pt.includes('392124') && !pt.includes('Comparatif') && pt.includes('Provenance') && (await pp.locator('#dlpdf, #shr, #slr, #rer').count()) === 0, `${w}px page publique : VIN masqué, lecture seule, sans comparatif`);
      ok((await pp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 0, `${w}px page publique : aucun défilement horizontal`);
      await page.evaluate(() => history.back()); await page.waitForSelector('#slr'); await page.click('#slr'); await page.waitForSelector('#slo'); await page.click('#slo'); await page.waitForSelector('#slon'); await page.click('#shx');
      await page.evaluate((h) => { location.hash = h; }, hash); await page.waitForFunction(() => /Page introuvable/.test(document.getElementById('report').innerText)); ok((await page.locator('#report').innerText()).includes('Page introuvable'), `${w}px page vendeur retirée : lien inactif`);
      ok(errs.length === 0, `${w}px : aucune erreur JavaScript (${errs[0]})`);
      await ctx.close();
    }
    console.log(`vitrine-ui : ${pass} vérifications OK`);
  } finally { await b.close(); }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
