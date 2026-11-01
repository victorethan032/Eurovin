'use strict';
// Pages publiques par marque (/marques, /options/<marque>), sitemap.xml et robots.txt.
// HTML rendu côté serveur, sans script, à partir des seuls faits connus du code (préfixes WMI) : aucune affirmation de couverture par marque.
const lib = require('./lib');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SKIP = new Set(['Renault Trucks', 'Iveco', 'MAN', 'Ikarus', 'Piaggio', 'Lada', 'Rover', 'DS / Opel']);
const base = (n) => n.replace(/ \(.*\)$/, '').replace(/^(BMW|Audi|Volkswagen)\b.*$/, '$1');
const slugify = (n) => n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

let cache = null;
function brands() {
  if (cache) return cache;
  const by = new Map();
  for (const [wmi, name] of Object.entries(lib.WMI)) {
    if (SKIP.has(name)) continue;
    const b = base(name); if (SKIP.has(b)) continue;
    if (!by.has(b)) by.set(b, { name: b, slug: slugify(b), wmi: [] });
    by.get(b).wmi.push(wmi);
  }
  cache = [...by.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return cache;
}
const bySlug = (s) => brands().find((b) => b.slug === s) || null;

const page = ({ appUrl, path, title, desc, body, noindex }) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title><meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(appUrl + path)}">${noindex ? '<meta name="robots" content="noindex">' : ''}
<meta property="og:type" content="website"><meta property="og:site_name" content="EuroVin"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(appUrl + path)}"><meta property="og:image" content="${esc(appUrl)}/og-image.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/logo-icone.svg" type="image/svg+xml"><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#fbfbfd">
<link rel="stylesheet" href="/style.css"></head><body>
<header class="nav"><a class="logo" href="/" aria-label="Accueil EuroVin" style="text-decoration:none;color:inherit">EuroVin</a><span><a class="link" href="/marques">Marques</a> <a class="link" href="/exemple">Exemple</a></span></header>
<main class="wrap">${body}</main>
<footer><div class="fl"><a href="/mentions-legales">Mentions légales</a><a href="/cgv">CGV</a><a href="/confidentialite">Confidentialité</a></div></footer></body></html>`;

const form = (label) => `<form class="field" action="/" method="get" style="margin-top:22px"><span class="eu">EU</span><input name="vin" placeholder="Numéro VIN (17 caractères)" aria-label="Numéro VIN" autocomplete="off" spellcheck="false" required minlength="17" pattern="[A-Za-z0-9 ]{17,}" style="flex:1"><button class="go" type="submit" aria-label="${esc(label)}">→</button></form>`;

function renderIndex(appUrl) {
  const body = `<h1>Options d’usine,<br><span style="color:var(--ac)">marque par marque.</span></h1>
<p class="lead">Choisissez la marque de votre véhicule, ou collez directement son VIN : l’aperçu est gratuit.</p>${form('Vérifier ce véhicule')}
<div class="feats" style="grid-template-columns:repeat(auto-fill,minmax(170px,1fr));margin-top:34px">${brands().map((b) => `<a class="card" href="/options/${b.slug}" style="text-decoration:none;color:inherit"><b style="font-size:20px">${esc(b.name)}</b></a>`).join('')}</div>
<p class="mut small" style="margin-top:24px">La liste reprend les constructeurs que nous reconnaissons dans le VIN. La couverture des options varie selon la marque et le millésime.</p>`;
  return page({ appUrl, path: '/marques', title: 'Options d’usine par marque — EuroVin', desc: 'Choisissez la marque de votre véhicule et lisez ses options d’usine en français à partir du VIN.', body });
}
function renderBrand(appUrl, slug) {
  const b = bySlug(slug); if (!b) return null;
  const n = esc(b.name), others = brands().filter((x) => x.slug !== b.slug).slice(0, 12);
  const body = `<h1 style="font-size:clamp(36px,8vw,64px)">Options d’usine ${n} :<br><span style="color:var(--ac)">lisez-les à partir du VIN.</span></h1>
<p class="lead">Collez le VIN de votre ${n} : EuroVin traduit en français les codes d’options d’usine et affiche leur prix catalogue d’origine, quand il est disponible.</p>${form('Vérifier ma ' + b.name)}
<p class="mut small">Aperçu gratuit avant tout paiement. Moins de 10 options lues : remboursement automatique.</p>
<div class="card"><h2 style="font-size:24px;margin:0 0 6px">Ce que contient le rapport</h2><ul class="ck"><li>Options d’usine en français, avec prix catalogue d’origine</li><li>Fiche technique et campagnes de rappel constructeur</li><li>En Premium : historique, sinistres connus et comparatif avec le catalogue de la finition</li></ul><p style="margin:12px 0 0"><a class="link" href="/exemple">Voir un rapport d’exemple (fictif) →</a></p></div>
<div class="card"><h2 style="font-size:24px;margin:0 0 6px">Reconnaître une ${n} dans le VIN</h2><p class="mut" style="margin:0">Le constructeur se lit dans les trois premiers caractères du VIN. Pour ${n}, nous reconnaissons : <b>${b.wmi.map(esc).join(', ')}</b>. Le VIN figure sur la carte grise (champ E), au bas du pare-brise et sur la plaque du montant de porte.</p></div>
<div class="card"><h2 style="font-size:24px;margin:0 0 6px">Couverture : ce que nous ne promettons pas</h2><p class="mut" style="margin:0">La quantité d’options lisibles dépend du millésime et de la finition. Nous n’affirmons pas qu’un modèle donné est complet : le rapport indique ses sources, et signale ce qu’il n’a pas pu établir.</p></div>
<h2 style="font-size:22px;margin-top:40px">Autres marques</h2><p>${others.map((x) => `<a class="link" href="/options/${x.slug}" style="margin-right:14px;display:inline-block">${esc(x.name)}</a>`).join('')}<a class="link" href="/marques">Toutes les marques →</a></p>`;
  return page({ appUrl, path: '/options/' + b.slug, title: `Options d’usine ${b.name} à partir du VIN — EuroVin`, desc: `Lisez en français les options d’usine de votre ${b.name} à partir du VIN : prix catalogue, fiche technique, rappels. Aperçu gratuit.`, body });
}
const sitemap = (appUrl) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${['/', '/exemple', '/marques', '/pro', '/aide', '/a-propos', ...brands().map((b) => '/options/' + b.slug)].map((p) => `<url><loc>${esc(appUrl + p)}</loc></url>`).join('\n')}\n</urlset>\n`;
const robots = (appUrl) => `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /report/\nDisallow: /rapport/\nDisallow: /compte\nDisallow: /commande/\nDisallow: /admin\nSitemap: ${appUrl}/sitemap.xml\n`;
module.exports = { brands, bySlug, renderIndex, renderBrand, sitemap, robots };
