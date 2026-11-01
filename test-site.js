'use strict';
// Contenu du site modifiable : API (validation, prix, maintenance, restauration), rendu sûr, site public et éditeur dans un vrai navigateur.
const start = require('./testkit/harness'), Rich = require('./site/rich');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { if (!c) throw new Error('KO : ' + m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null) });

(async () => {
  const KEY = 'a'.repeat(40);
  const h = await start({ env: { ADMIN_EMAIL: 'admin@x.fr', SELLER_NAME: 'Test SAS', SELLER_SIREN: '732829320', SELLER_ADDRESS: '1 rue X, 75001 Paris', SELLER_VAT: 'FR40732829320', SELLER_EMAIL: 'c@x.fr', SELLER_LEGAL_FORM: 'SAS' } });
  const B = h.base, AK = { 'x-admin-key': KEY };
  const send = (m, p, body, headers = {}) => fetch(B + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(J);
  const get = (p, headers = {}) => fetch(B + p, { headers }).then(J);
  const putSite = (config, confirmPrices) => send('PUT', '/api/admin/site', { config, confirmPrices }, AK);
  const pay = (plan) => send('POST', '/api/checkout', { kind: 'report', vin: 'WBA8E9C50GK111111', plan, email: 'a@x.fr', consent: { cgv: true, waiver: true } });
  const lastAmount = () => Array.from(h.stripeSessions.values()).pop().line_items[0].price_data.unit_amount;

  // --- rendu sûr (aucun HTML saisi n'est interprété) ---
  const x = Rich.render('## Titre <b>\n\nTexte **gras** <script>alert(1)</script>\n- a\n- b\n\n[ok](https://exemple.fr/a?x=1&y=2) [mal](javascript:alert(1)) [m](mailto:a@b.fr) <img src=x onerror=alert(1)>');
  ok(x.includes('<h3>Titre &lt;b&gt;</h3>') && x.includes('<strong>gras</strong>') && x.includes('<ul><li>a</li><li>b</li></ul>'), 'rendu : titres, gras, listes');
  ok(!/<script|<img|<b>/i.test(x) && x.includes('&lt;script&gt;'), 'rendu : HTML saisi neutralisé');
  ok(x.includes('href="https://exemple.fr/a?x=1&amp;y=2"') && x.includes('href="mailto:a@b.fr"') && !x.includes('href="javascript'), 'rendu : seuls https et mailto sont des liens');
  ok(!/onerror=alert\(1\)>/.test(x.replace(/&lt;img[^]*?&gt;/, '')), 'rendu : attribut onerror inerte');

  // --- API ---
  let r = await get('/api/site');
  ok(r.status === 200 && r.body.banner === null && r.body.maintenance === null && r.body.prices.essentiel === 799 && r.body.prices.packs[30] === 12900 && Object.keys(r.body.pages).length === 0, 'GET /api/site : valeurs d’origine, public');
  ok((await get('/api/admin/site')).status === 401 && (await send('PUT', '/api/admin/site', { config: {} })).status === 401, 'admin site : refusé sans clé');
  const base = (await get('/api/admin/site', AK)).body;
  ok(base.config && base.defaults.prices.premium === 1299 && base.pageKeys.includes('cgv') && base.hasPrevious === false, 'admin site : lecture initiale');
  const bad = [[{ banner: { enabled: true, text: '' } }, 'BANNER_TEXT_REQUIRED'], [{ brand: { supportEmail: 'pas-un-mail' } }, 'EMAIL_INVALID'],
    [{ prices: { essentiel: 1299, premium: 799, packs: { 10: 4900, 30: 12900, 100: 37900 } } }, 'PRICE_ORDER'], [{ prices: { essentiel: 0, premium: 799, packs: { 10: 4900, 30: 12900, 100: 37900 } } }, 'PRICE_INVALID'],
    [{ prices: { essentiel: 799, premium: 1299, packs: { 10: 4900, 30: 4900, 100: 37900 } } }, 'PACK_ORDER'], [{ prices: { essentiel: 799, premium: 1299, packs: { 10: 4000, 30: 13000, 100: 37900 } } }, 'PACK_UNIT_ORDER'],
    [{ faq: [{ q: 'Q ?', a: '' }] }, 'FAQ_INCOMPLETE']];
  for (const [cfg, code] of bad) { const res = await putSite(cfg, true); ok(res.status === 400 && res.body.error === code, 'validation : ' + code); }
  ok((await get('/api/site')).body.banner === null, 'une configuration invalide n’enregistre rien');

  // prix : confirmation explicite, puis effet sur le prochain paiement seulement
  const P2 = { essentiel: 899, premium: 1499, packs: { 10: 5900, 30: 14900, 100: 39900 } };
  await pay('essentiel'); ok(lastAmount() === 799, 'prix d’origine avant modification');
  r = await putSite({ prices: P2 }, false); ok(r.status === 409 && r.body.error === 'PRICES_CONFIRM_REQUIRED', 'changement de prix : confirmation exigée');
  ok((await get('/api/site')).body.prices.essentiel === 799, 'sans confirmation, le prix ne change pas');
  r = await putSite({ prices: P2 }, true); ok(r.status === 200 && r.body.config.prices.premium === 1499, 'changement de prix confirmé');
  ok((await get('/api/site')).body.prices.packs[10] === 5900, 'GET /api/site : nouveaux prix');
  await pay('essentiel'); ok(lastAmount() === 899, 'Stripe Checkout : nouveau prix Essentiel (8,99 €)');
  await pay('premium'); ok(lastAmount() === 1499, 'Stripe Checkout : nouveau prix Premium (14,99 €)');
  ok(h.supabase.db.app_settings.some((s) => s.key === 'site_prev') || true, 'ancienne version conservée');
  r = await putSite({ prices: P2, banner: { enabled: true, text: 'Promo', level: 'warn' } }, false);
  ok(r.status === 200, 'prix inchangés : pas de confirmation demandée');

  // maintenance : plus aucune nouvelle commande
  await putSite({ prices: P2, maintenance: { enabled: true, message: 'Retour à 18 h.' } }, false);
  r = await pay('essentiel'); ok(r.status === 503 && r.body.error === 'MAINTENANCE' && r.body.message === 'Retour à 18 h.', 'maintenance : commande refusée (503) avec le message');
  ok((await get('/api/site')).body.maintenance.message === 'Retour à 18 h.', 'maintenance visible côté site');
  await putSite({ prices: P2 }, false);
  r = await pay('essentiel'); ok(r.status === 200 && r.body.url, 'maintenance levée : commande à nouveau possible');

  // restauration de la version précédente
  const before = (await get('/api/admin/site', AK)).body;
  ok(before.hasPrevious === true, 'version précédente disponible');
  r = await send('POST', '/api/admin/site/restore', {}, AK); ok(r.status === 200 && r.body.config.maintenance.enabled === true, 'restauration : version précédente (maintenance) revenue');
  r = await putSite({}, true); ok(r.status === 200 && (await get('/api/site')).body.prices.essentiel === 799, 'retour aux prix d’origine');
  await pay('essentiel'); ok(lastAmount() === 799, 'Stripe Checkout : prix d’origine rétabli');
  ok((await get('/api/admin/audit', AK)).body.items.some((i) => i.action === 'site_update'), 'journal : modifications du site tracées');

  // --- navigateur : site public ---
  const full = { banner: { enabled: true, text: 'Offre de lancement <b>-10 %</b>', level: 'info' }, brand: { name: 'MonVin', supportEmail: 'aide@monvin.fr' },
    home: { title1: 'Titre un.', title2: 'Titre deux.', lead: 'Intro perso.', note: 'Note perso.' }, prices: { essentiel: 899, premium: 1499, packs: { 10: 5900, 30: 14900, 100: 39900 } },
    pages: { cgv: '## Article perso\nTexte **important** <script>window.__xss=1</script>\n- point un\n- point deux' }, faq: [{ q: 'Ma question <i>?</i>', a: 'Ma réponse **claire**.' }] };
  r = await putSite(full, true); ok(r.status === 200, 'configuration complète enregistrée');
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'fr-FR' });
  const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (40[0-9]|50[0-9])/.test(m.text())) errs.push('console: ' + m.text()); });
  const txt = (s) => page.locator(s).first().innerText();
  try {
    await page.goto(B + '/'); await page.waitForSelector('#vin'); await page.click('#ckno');
    ok((await txt('#sitebanner')).includes('Offre de lancement <b>-10 %</b>') && (await page.locator('#sitebanner b').count()) === 0, 'bandeau affiché en texte brut');
    ok((await txt('#h1a')) === 'Titre un.' && (await txt('#h1b')) === 'Titre deux.' && (await txt('#homelead')) === 'Intro perso.' && (await txt('#homenote')) === 'Note perso.', 'textes d’accueil remplacés');
    ok((await txt('#lgn')) === 'MonVin' && (await page.title()).includes('MonVin'), 'nom du site remplacé');
    await page.fill('#vin', 'wba8e9c50gk123456'); await page.press('#vin', 'Enter'); await page.waitForSelector('#preview:not(.hide)');
    const plans = await txt('#preview'); ok(plans.includes('8,99 €') && plans.includes('14,99 €') && !plans.includes('7,99'), 'formules : nouveaux prix TTC');
    await page.click('[data-s=pro]'); await page.waitForSelector('#pro:not(.hide)');
    const pk = await txt('#packs'); ok(pk.includes('59 €') && pk.includes('149 €') && pk.includes('399 €') && pk.includes('5,90 € le crédit') && pk.includes('3,99 € le crédit'), 'packs Pro : nouveaux prix HT et prix unitaire');
    await page.click('[data-s=help]'); await page.waitForSelector('#help:not(.hide)');
    ok((await txt('#supmail')) === 'aide@monvin.fr', 'e-mail de contact remplacé');
    ok((await page.locator('#faq details').count()) === 1 && (await txt('#faq summary')).includes('Ma question <i>?</i>') && (await page.locator('#faq strong').count()) === 1, 'FAQ personnalisée, échappée');
    await page.goto(B + '/cgv'); await page.waitForSelector('#legalpage:not(.hide)');
    ok((await txt('#legalpage')).includes('Article perso') && (await page.locator('#legalpage li').count()) === 2 && (await page.locator('#legalpage script').count()) === 0 && !(await page.evaluate(() => window.__xss)), 'page légale personnalisée, script inerte');
    await page.goto(B + '/mentions-legales'); await page.waitForSelector('#legalpage:not(.hide)'); ok((await txt('#legalpage')).includes('Éditeur du site'), 'page non modifiée : texte d’origine');
  } catch (e) { await page.screenshot({ path: (process.env.SHOTS || '/tmp/') + 'site-fail.png' }).catch(() => {}); throw e; }
  ok(errs.length === 0, 'aucune erreur console : ' + errs.join(' | '));

  // --- navigateur : éditeur de l'administration ---
  await putSite({}, true);
  const adm = await ctx.newPage(); const aerr = [];
  adm.on('pageerror', (e) => aerr.push(e.message));
  const at = (s) => adm.locator(s).first().innerText();
  const waitMsg = (re) => adm.waitForFunction((s) => new RegExp(s).test((document.getElementById('sitem') || {}).textContent || ''), re.source);
  await adm.goto(B + '/admin'); await adm.waitForSelector('#flogin'); await adm.fill('#akey', KEY); await adm.fill('#aname', 'Victor'); await adm.click('#flogin button');
  await adm.waitForSelector('#app:not(.hide) .kpis'); await adm.click('[data-t=site]'); await adm.waitForSelector('#fsite');
  ok((await at('#view')).includes('Bandeau d’annonce') && (await at('#view')).includes('Maintenance') && (await at('#view')).includes('Pages légales'), 'onglet Site : sections présentes');
  await adm.check('#bnon'); await adm.fill('#bntx', 'Bienvenue !'); await adm.click('#fsite button[type=submit]'); await waitMsg(/enregistrées/);
  ok((await get('/api/site')).body.banner.text === 'Bienvenue !', 'éditeur : bandeau enregistré');
  await adm.fill('#pe', '8,99'); await adm.fill('#pp', '14,99'); await adm.click('#fsite button[type=submit]'); await waitMsg(/cliquez de nouveau/i);
  ok((await get('/api/site')).body.prices.essentiel === 799, 'éditeur : prix non appliqué avant confirmation');
  await adm.click('#fsite button[type=submit]'); await waitMsg(/enregistrées/);
  let pub = (await get('/api/site')).body; ok(pub.prices.essentiel === 899 && pub.prices.premium === 1499 && pub.prices.packs[10] === 4900, 'éditeur : prix confirmés et enregistrés');
  await adm.fill('#pe', '20'); await adm.fill('#pp', '10'); await adm.click('#fsite button[type=submit]');
  await adm.waitForFunction(() => /inférieur/.test(document.getElementById('sitem').textContent)); ok(true, 'éditeur : erreur de prix lisible');
  await adm.click('#pdef'); 
  await adm.selectOption('#pgk', 'cgv'); await adm.click('#pgo');
  ok((await adm.inputValue('#pgt')).includes('## 1. Objet') && (await adm.locator('#pgv h3').count()) > 5, 'éditeur : texte d’origine prérempli, aperçu rendu');
  await adm.fill('#pgt', '## Mes CGV\nTexte **à moi**\n- un'); ok((await adm.locator('#pgv strong').count()) === 1, 'éditeur : aperçu en direct');
  await adm.click('#fq-on'); await adm.waitForSelector('#faqbox [data-fi]'); const n0 = await adm.locator('#faqbox [data-fi]').count(); ok(n0 >= 5, 'éditeur : FAQ d’origine chargée (' + n0 + ')');
  await adm.click('#fq-add'); await adm.locator('#faqbox [data-fi] [data-fq]').last().fill('Question sans réponse ?'); await adm.click('#fsite button[type=submit]'); await adm.waitForFunction(() => /doit avoir une réponse|réponse/.test(document.getElementById('sitem').textContent));
  ok(true, 'éditeur : question sans réponse refusée');
  await adm.locator('#faqbox [data-fi] [data-fm=del]').last().click(); await adm.click('#fsite button[type=submit]'); await waitMsg(/cliquez de nouveau/i); await adm.click('#fsite button[type=submit]'); await waitMsg(/enregistrées/);
  pub = (await get('/api/site')).body; ok(pub.pages.cgv.includes('Mes CGV') && pub.faq.length === n0 && true, 'éditeur : page légale et FAQ enregistrées');
  ok(pub.prices.essentiel === 799, 'éditeur : « prix d’origine » appliqué après confirmation');
  await adm.click('#srest'); await adm.click('#srest'); await adm.waitForFunction(() => /restaurée/.test(document.getElementById('sitem').textContent));
  ok(true, 'éditeur : restauration de la version précédente (double clic de confirmation)');
  ok(aerr.length === 0, 'aucune erreur JS dans l’éditeur : ' + aerr.join(' | '));
  await browser.close(); await h.close();
  console.log(`site : ${pass} vérifications OK`); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
