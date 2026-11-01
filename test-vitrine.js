'use strict';
// Vitrine : rapport d'exemple public, page vendeur (lien public séparé), pages par marque, sitemap/robots, aperçus de partage.
const assert = require('assert'), fs = require('fs'), start = require('./testkit/harness'), lib = require('./lib'), BP = require('./brandpages');
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers });
(async () => {
  const h = await start({}); const B = h.base, db = h.supabase.db;
  const post = (p, body) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(J);
  const get = (p) => fetch(B + p).then(J);
  const text = async (p) => { const r = await fetch(B + p); return { status: r.status, text: await r.text(), headers: r.headers }; };
  const TOK = 'ab'.repeat(24), VIN = 'WBA8E9C50GK123456', FUT = new Date(Date.now() + 30 * 864e5).toISOString();
  const S = require('./sample').sampleReport(), R = require('./report');
  const rep = R.assembleReport({ plan: 'premium', vin: VIN, decoded: { source: 'vindata', vehicle: { make: 'BMW', model: '320d', year: 2021 }, options: S.report.options.items, catalogue: S.report.options.items.concat([{ code: 'Z1', label: 'Option absente', priceCents: 1000 }, { code: 'Z2', label: 'a', priceCents: 1 }, { code: 'Z3', label: 'b', priceCents: 1 }, { code: 'Z4', label: 'c', priceCents: 1 }]) },
    recalls: null, history: { status: 'ok', events: [{ date: '2021-03', title: 'Première mise en circulation', place: 'Allemagne' }], theft: { status: 'none_found' }, lien: { status: 'none_found' }, damage: { status: 'none_found' } }, valuation: { status: 'ok', p50: 99999 }, explanation: 'TEXTE-DE-COTATION' });
  db.orders.push({ id: 'o1', kind: 'report', buyer_email: 'acheteur@exemple.fr', status: 'delivered' });
  db.reports.push({ id: 'r1', order_id: 'o1', vin: VIN, plan: 'premium', access_token: TOK, expires_at: FUT, created_at: new Date().toISOString(), report: rep });
  try {
    // --- rapport d'exemple ---
    let r = await get('/api/sample-report');
    ok(r.status === 200 && r.body.sample === true && r.body.reference === 'EXEMPLE' && r.body.report.plan === 'premium' && r.body.report.options.count >= 10, 'exemple : rapport Premium fictif, marqué « sample »');
    ok(r.body.report.vin === 'EXEMPLE0000000000' && !/WBA|BMW/.test(JSON.stringify(r.body)), 'exemple : aucun VIN ni marque réels');
    ok(r.body.report.comparison.status === 'ok' && r.body.report.provenance.status === 'ok' && r.body.report.recalls.status === 'found', 'exemple : comparatif, provenance et rappels présents');
    ok(JSON.stringify(r.body.report.sources).includes('fictives') && r.body.report.notices[0].includes('inventés'), 'exemple : sources et avis disent que tout est fictif');
    ok((await text('/exemple')).text.includes('<html'), '/exemple sert le site');

    // --- page vendeur ---
    ok((await get(`/api/reports/${TOK}/public`)).body.active === false, 'vendeur : inactive par défaut');
    ok((await post(`/api/reports/${TOK}/public`, { on: 'oui' })).status === 400 && (await post(`/api/reports/${'cd'.repeat(24)}/public`, { on: true })).status === 404, 'vendeur : valeur incorrecte 400, rapport inconnu 404');
    r = await post(`/api/reports/${TOK}/public`, { on: true }); const PT = r.body.token;
    ok(r.status === 200 && r.body.active && /^[a-f0-9]{48}$/.test(PT) && PT !== TOK && db.reports[0].public_token === PT, 'vendeur : lien public distinct du lien acheteur');
    ok((await post(`/api/reports/${TOK}/public`, { on: true })).body.token === PT, 'vendeur : réactiver conserve le même lien');
    r = await get('/api/public/' + PT); const raw = JSON.stringify(r.body);
    ok(r.status === 200 && r.body.public === true && r.headers.get('x-robots-tag') === 'noindex, nofollow' && r.headers.get('cache-control') === 'no-store', 'vendeur : lisible, noindex, no-store');
    ok(r.body.report.vin === VIN.slice(0, 11) + '••••••' && !raw.includes(VIN) && !raw.includes(VIN.slice(11)), 'vendeur : VIN masqué (6 derniers caractères) et absent de toute la réponse');
    ok(!raw.includes('TEXTE-DE-COTATION') && !raw.includes('99999') && r.body.report.comparison === null && r.body.report.valuation === null && !raw.includes('acheteur@exemple.fr'), 'vendeur : ni cotation, ni comparatif, ni e-mail de l’acheteur');
    ok(r.body.report.options.count === rep.options.count && r.body.report.provenance.status === 'ok' && r.body.reference === null, 'vendeur : options et provenance présentes, pas de référence interne');
    ok((await get('/api/public/' + TOK)).status === 404, 'vendeur : le lien acheteur ne marche pas comme lien public');
    ok((await get('/api/public/' + 'ef'.repeat(24))).status === 404 && (await get('/api/public/xyz')).status === 404, 'vendeur : jeton inconnu ou invalide : 404');
    const pg = await text('/rapport/' + PT); ok(pg.status === 200 && pg.text.includes('<html') && pg.headers.get('x-robots-tag') === 'noindex, nofollow', '/rapport/<jeton> sert le site en noindex');
    r = await post(`/api/reports/${TOK}/public`, { on: false });
    ok(r.body.active === false && db.reports[0].public_token === null && (await get('/api/public/' + PT)).status === 404, 'vendeur : retrait immédiat, ancien lien en 404');
    const nt = (await post(`/api/reports/${TOK}/public`, { on: true })).body.token; ok(nt !== PT, 'vendeur : après retrait, un nouveau lien est généré (l’ancien ne revient pas)');
    db.reports[0].expires_at = new Date(Date.now() - 1000).toISOString(); ok((await get('/api/public/' + nt)).status === 404, 'vendeur : rapport expiré => page indisponible'); db.reports[0].expires_at = FUT;

    // --- marques, sitemap, robots, partage ---
    ok(BP.brands().length >= 25 && BP.bySlug('bmw').wmi.includes('WBA') && !BP.bySlug('iveco') && !BP.bySlug('renault-trucks'), 'marques : liste dédupliquée, camions exclus');
    ok(new Set(BP.brands().map((b) => b.slug)).size === BP.brands().length && BP.brands().every((b) => /^[a-z0-9-]+$/.test(b.slug)), 'marques : slugs uniques et propres');
    let t = await text('/marques'); ok(t.status === 200 && t.text.includes('/options/bmw') && t.text.includes('/options/mercedes-benz') && !/<script/i.test(t.text), '/marques : liste, aucun script');
    t = await text('/options/bmw');
    ok(t.status === 200 && t.text.includes('WBA, WBS, WBY') && t.text.includes('action="/" method="get"') && t.text.includes('name="vin"') && !/<script/i.test(t.text) && t.text.includes('rel="canonical"') && t.text.includes('og:image'), '/options/bmw : préfixes WMI, formulaire GET vers /?vin=, canonical, aperçu de partage, aucun script');
    ok(!/(\d+\s?%|garanti|100 ?%|complet\b)/i.test(t.text.replace(/Moins de 10 options/, '')) || /ne promettons pas/.test(t.text), '/options/bmw : pas de promesse de couverture');
    ok((await text('/options/inconnu<x>')).status === 404 && (await text('/options/..%2Fserver')).status === 404, '/options/<inconnu> : 404');
    t = await text('/sitemap.xml'); ok(t.status === 200 && /xml/.test(t.headers.get('content-type')) && t.text.includes('/options/bmw') && t.text.includes('/exemple') && !t.text.includes('/report') && !t.text.includes('/rapport'), 'sitemap : pages publiques seulement');
    t = await text('/robots.txt'); ok(/Disallow: \/api\//.test(t.text) && /Disallow: \/report\//.test(t.text) && /Disallow: \/rapport\//.test(t.text) && /Sitemap: .*\/sitemap\.xml/.test(t.text), 'robots : API, rapports et pages vendeur exclus ; sitemap déclaré');
    t = await text('/'); ok(t.text.includes('og:image') && t.text.includes(process.env.APP_URL + '/og-image.png') && !t.text.includes('{{APP_URL}}'), 'accueil : aperçu de partage avec URL absolue');
    ok(fs.statSync(__dirname + '/site/og-image.png').size > 5000 && fs.statSync(__dirname + '/site/badge-eurovin.png').size > 2000, 'images og-image et badge présentes');
    console.log(`test-vitrine : ${pass} vérifications OK`); process.exit(0);
  } finally { await h.close(); }
})().catch((e) => { console.error('ÉCHEC', e); process.exit(1); });
