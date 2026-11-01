'use strict';
// Adaptation téléphone : aucun défilement horizontal de la page (320 à 430 px), tableaux d'administration en cartes
// étiquetées, champs à 16 px minimum (pas de zoom automatique sur iPhone), cibles tactiles principales >= 44 px.
const { execFileSync } = require('child_process'), path = require('path');
const { chromium } = require('playwright');
const SH = process.env.SHOTS || '/tmp/';
const pub = SH + 'mobile-demo.html';
execFileSync('node', [path.join(__dirname, 'build-demo.js'), pub], { stdio: 'ignore' });
const adm = path.join(__dirname, 'admin-demo.html');
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
// Application installable : manifeste, icônes et service worker
{
  const fs = require('fs'), S = path.join(__dirname, 'site'); const m = JSON.parse(fs.readFileSync(S + '/manifest.webmanifest', 'utf8'));
  ok(m.display === 'standalone' && m.start_url === '/' && m.lang === 'fr' && m.name === 'EuroVin', 'manifeste : nom, langue, démarrage et mode application');
  ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.purpose === 'maskable'), 'manifeste : icônes 192, 512 et maskable');
  const png = (f) => { const b = fs.readFileSync(S + '/' + f); return b.slice(0, 4).toString('hex') === '89504e47' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };
  ok(m.icons.every((i) => { const d = png(i.src.slice(1)); return d && i.sizes === d[0] + 'x' + d[1]; }) && png('apple-touch-icon.png')[0] === 180, 'icônes : fichiers PNG présents, aux tailles annoncées');
  const sw = fs.readFileSync(S + '/sw.js', 'utf8'); new Function(sw);
  ok(/startsWith\('\/api\/'\)/.test(sw) && /report\\\//.test(sw) && !/\/api\//.test(sw.match(/const SHELL = \[[^\]]*\]/)[0]), 'service worker : API et rapports jamais mis en cache');
  const ix = fs.readFileSync(S + '/index.html', 'utf8'); ok(/rel="manifest"/.test(ix) && /apple-touch-icon/.test(ix) && /theme-color/.test(ix) && /\/mobile\.js/.test(ix), 'page : manifeste, icône iPhone, couleur de thème et mobile.js déclarés');
}
(async () => {
  const br = await chromium.launch();
  try {
    for (const W of [320, 360, 390, 430]) {
      const ctx = await br.newContext({ viewport: { width: W, height: 780 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      await page.goto('file://' + pub); await page.waitForSelector('#ckbar:not(.hide)'); ok((await overflow(page)) <= 0, `${W}px : bandeau cookies sans débordement`);
      await page.click('#ckno'); ok((await overflow(page)) <= 0, `${W}px : accueil sans débordement`);
      ok((await page.locator('#vin').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))) >= 16, `${W}px : champ VIN >= 16 px`);
      ok((await page.locator('#go').evaluate((e) => e.getBoundingClientRect().height)) >= 44, `${W}px : bouton de recherche >= 44 px`);
      await page.fill('#vin', 'WP0ZZZ99ZTS392124'); await page.click('#go'); await page.waitForSelector('#preview:not(.hide)'); ok((await overflow(page)) <= 0, `${W}px : aperçu`);
      await page.click('#pay'); ok((await overflow(page)) <= 0, `${W}px : paiement`);
      ok((await page.locator('#cem').evaluate((e) => parseFloat(getComputedStyle(e).fontSize))) >= 16, `${W}px : champ e-mail >= 16 px`);
      await page.fill('#cem', 'a@b.fr'); await page.check('#ccgv'); await page.check('#cwv'); await page.click('#cgo');
      await page.waitForSelector('#report:not(.hide) h2', { timeout: 20000 }); ok((await overflow(page)) <= 0, `${W}px : rapport`);
      await page.click('[data-seg=tab][data-k=c]'); await page.waitForTimeout(700); ok((await overflow(page)) <= 0, `${W}px : comparatif`);
      await page.click('#mtab [data-s=pro]'); await page.waitForTimeout(300); ok((await overflow(page)) <= 0, `${W}px : page Pro`);
      ok((await page.locator('#mtab [data-s=pro]').getAttribute('aria-current')) === 'true', `${W}px : barre du bas, onglet Pro actif`);
      ok(errs.length === 0, `${W}px : aucune erreur JavaScript (${errs[0] || ''})`);
      await ctx.close();
    }
    {
      const c2 = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); const p2 = await c2.newPage(); const e2 = []; p2.on('pageerror', (e) => e2.push(e.message));
      await p2.goto('file://' + pub); await p2.waitForSelector('#ckbar:not(.hide)'); await p2.click('#ckno');
      ok(await p2.locator('#mtab').isVisible() && (await p2.locator('#mtab button').count()) === 5, 'téléphone : barre d\'onglets du bas (5 onglets)');
      ok(!(await p2.locator('.topnav [data-s=pro]').isVisible()), 'téléphone : menu du haut remplacé par la barre du bas');
      await p2.fill('#vin', 'wp0 zzz99-zts392124'); ok((await p2.inputValue('#vin')) === 'WP0ZZZ99ZTS392124', 'téléphone : VIN collé avec espaces et tirets nettoyé et mis en majuscules');
      ok((await p2.textContent('#vinc')).includes('17 / 17'), 'téléphone : compteur 17 / 17');
      await p2.fill('#vin', 'WP0ZZZ99ZTS39212O'); ok((await p2.textContent('#vinc')).includes('interdits'), 'téléphone : lettre O signalée');
      await p2.fill('#vin', 'WP0ZZZ99ZTS392124'); await p2.click('#go'); await p2.waitForSelector('#preview:not(.hide)');
      ok(/Continuer · 12,99 € TTC/.test(await p2.textContent('#pay')), 'téléphone : bouton Continuer avec le prix (Premium)');
      await p2.click('.plan[data-p=essentiel]'); await p2.waitForFunction(() => /7,99/.test(document.getElementById('pay').textContent)); ok(true, 'téléphone : le prix suit le choix du rapport');
      const pos = await p2.locator('#pay').evaluate((e) => getComputedStyle(e).position); ok(pos === 'sticky', 'téléphone : bouton Continuer collé en bas');
      await p2.click('#pay'); await p2.fill('#cem', 'a@b.fr'); await p2.check('#ccgv'); await p2.check('#cwv'); await p2.click('#cgo'); await p2.waitForSelector('#report:not(.hide) h2', { timeout: 20000 });
      ok((await p2.locator('#report .seg').first().evaluate((e) => getComputedStyle(e).position)) === 'sticky', 'téléphone : onglets du rapport collés en haut');
      await p2.click('#shr'); await p2.waitForTimeout(350); const r = await p2.locator('#shbox').evaluate((e) => { const b = e.getBoundingClientRect(); return { bottom: Math.round(b.bottom), w: Math.round(b.width), vh: innerHeight, vw: innerWidth }; });
      ok(r.bottom >= r.vh - 2 && r.w >= r.vw - 2, 'téléphone : fenêtre de partage en feuille plein largeur ancrée en bas');
      await p2.mouse.click(200, 40); await p2.waitForTimeout(200); ok(!(await p2.locator('#shbox').evaluate((e) => e.open)), 'téléphone : toucher le fond ferme la feuille');
      ok(e2.length === 0, 'téléphone : aucune erreur JavaScript (' + (e2[0] || '') + ')'); await c2.close();
      const cd = await br.newContext({ viewport: { width: 1200, height: 800 } }); const pd = await cd.newPage(); await pd.goto('file://' + pub); await pd.waitForSelector('#ckbar:not(.hide)'); await pd.click('#ckno');
      ok(!(await pd.locator('#mtab').isVisible()) && (await pd.locator('.topnav [data-s=pro]').isVisible()), 'ordinateur : navigation du haut inchangée, pas de barre du bas'); await cd.close();
    }
    // Console d'administration
    const ctx = await br.newContext({ viewport: { width: 375, height: 780 }, isMobile: true, hasTouch: true }); const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto('file://' + adm); await page.waitForSelector('#flogin'); ok((await overflow(page)) <= 0, 'admin : connexion sans débordement');
    await page.fill('#akey', 'demo-admin'); await page.fill('#aname', 'Victor'); await page.click('#flogin button'); await page.waitForSelector('.kpis'); await page.waitForTimeout(700);
    ok((await overflow(page)) <= 0, 'admin : tableau de bord sans débordement');
    ok((await page.locator('#view svg').count()) > 0, 'admin : graphiques toujours présents');
    const n = await page.locator('#tabs button').count(); ok(n === 12, 'admin : 12 onglets conservés');
    let cartes = 0;
    for (let i = 0; i < n; i++) {
      await page.locator('#tabs button').nth(i).click(); await page.waitForTimeout(450);
      ok((await overflow(page)) <= 0, `admin : onglet ${i + 1} sans débordement`);
      const t = await page.evaluate(() => { const tds = [...document.querySelectorAll('#view table.tbl tbody td')].filter((d) => !d.hasAttribute('colspan')); return { n: tds.length, labelled: tds.filter((d) => d.getAttribute('data-label') !== null).length, flex: tds.length ? getComputedStyle(tds[0]).display : 'none' }; });
      ok(t.n === t.labelled, `admin : onglet ${i + 1}, chaque cellule porte son libellé`);
      if (t.n) { ok(t.flex === 'flex', `admin : onglet ${i + 1}, tableau affiché en cartes`); cartes++; }
    }
    ok(cartes >= 3, 'admin : au moins 3 écrans avec tableaux en cartes');
    ok((await page.locator('#tabs button').first().evaluate((e) => e.getBoundingClientRect().height)) >= 44, 'admin : onglets >= 44 px');
    ok(errs.length === 0, 'admin : aucune erreur JavaScript (' + (errs[0] || '') + ')');
    console.log('mobile : ' + pass + ' vérifications OK');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  await br.close(); process.exit(process.exitCode || 0);
})();
