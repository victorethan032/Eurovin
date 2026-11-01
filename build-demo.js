'use strict';
// Construit la version autonome (un seul fichier HTML) : le VRAI site + un jeu de données d'exemple produit par le VRAI code de rapport.
process.env.ALLOW_MOCK = '1'; process.env.NODE_ENV = 'test'; process.env.PROVIDER_ORDER = 'mock'; process.env.HISTORY_ORDER = 'mock'; process.env.RECALL_ORDER = 'mock';
const fs = require('fs'), path = require('path');
const lib = require('./lib'), prov = require('./providers'), R = require('./report'), { translateOptions } = require('./translate'), { buildReportPdf } = require('./reportpdf'), { buildInvoicePdf } = require('./invoice');
(async () => {
  const VIN = 'WBA8E9C50GK123456';
  const dec = await prov.decodeVin(VIN), hist = await prov.getHistory(VIN), rec = await prov.getRecalls(VIN);
  const tr = translateOptions(dec.options, { brand: 'BMW' }), cat = translateOptions(dec.catalogue, { brand: 'BMW' });
  const mk = (plan) => R.assembleReport({ plan, vin: VIN, decoded: { ...dec, options: tr.items, catalogue: cat.items }, translation: tr, recalls: rec, history: hist });
  const premium = mk('premium'), essentiel = mk('essentiel');
  const pdfReport = (await buildReportPdf({ reference: 'RP-EXEMPLE', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(), report: premium }, { name: 'EuroVin (démonstration)' })).toString('base64');
  const pdfInvoice = (await buildInvoicePdf({ number: 'EV-2026-000001', issued_at: new Date().toISOString(), buyer_email: 'demo@exemple.fr', description: 'Facture d’exemple (démonstration, sans valeur)', amount_ht_cents: 1083, amount_tax_cents: 216, amount_ttc_cents: 1299 }, { name: 'EuroVin (démonstration)' })).toString('base64');
  // --- Coulisses : e-mails de service et factures conformes, produits par le VRAI code ---
  const { templates } = require('./mail'), I = require('./invoicing'), { execFileSync } = require('child_process'), os = require('os');
  const seller = { name: 'EuroVin (démonstration)', legalForm: 'SAS', capital: '1 000 €', siren: '123 456 789', rcs: 'RCS Lyon 123 456 789', address: '1 rue d’exemple, 69001 Lyon', vat: 'FR12123456789', email: 'contact@exemple.fr' };
  const T = templates({ appUrl: 'https://eurovin.example', seller, supportEmail: 'contact@exemple.fr' });
  const E = (label, tpl, attach) => ({ label, subject: tpl.subject, html: tpl.html, attach });
  const emails = [
    E('Bienvenue (avec marketing accepté)', T.welcome({ marketing: true, unsubUrl: 'https://eurovin.example/desabonnement?t=exemple' })),
    E('Bienvenue (service uniquement)', T.welcome({ marketing: false })),
    E('Paiement reçu — rapport', T.reportPaid({ plan: 'premium', vin: VIN, ttc: 1299, invoiceNumber: 'EV-2026-000001', cgv: 'v1' }), 'Facture_EV-2026-000001.pdf'),
    E('Rapport prêt', T.reportReady({ plan: 'premium', vin: VIN, url: 'https://eurovin.example/report/exemple', ttc: 1299, cgv: 'v1' }), 'Rapport_' + VIN + '.pdf'),
    E('Pack de crédits acheté', T.packPaid({ credits: 10, balance: 10, ttc: 5880, invoiceNumber: 'EV-2026-000002', company: 'Garage Dupont SARL' }), 'Facture_EV-2026-000002.pdf'),
    E('Rapport par crédits (récapitulatif)', T.reportReady({ plan: 'premium', vin: VIN, url: 'https://eurovin.example/report/exemple', ttc: null, cgv: 'v1', creditCost: 2, balance: 8 }), 'Rapport_' + VIN + '.pdf'),
    E('Alerte Pro : solde faible', T.lowCredits({ balance: 1 })),
    E('Remboursement et avoir', T.creditNote({ amountCents: 1299, number: 'AV-2026-000001' }), 'Avoir_AV-2026-000001.pdf'),
    E('Crédits recrédités (échec de génération)', T.creditRefund({ plan: 'premium', vin: VIN, credits: 2 })),
    E('Échec de paiement', T.paymentFailed()),
    E('Commande en retard', T.delayNotice({ vin: VIN })),
    E('Alerte rappel (nouvelle campagne)', T.recallAlert({ vin: VIN, items: [{ ref: 'EXEMPLE-01', date: '10/2026', title: 'Campagne d’exemple (démonstration)' }], reportUrl: 'https://eurovin.example/report/exemple', stopUrl: 'https://eurovin.example/rappels/arret?t=exemple', source: 'Source d’exemple', asOf: '07/10/2026' })),
    E('Rapport bientôt supprimé', T.reportExpiring({ vin: VIN, url: 'https://eurovin.example/report/exemple', days: 7 })),
    E('Message support reçu', T.ticketReceived({ subject: 'Question sur une commande', reference: 'A1B2C3D4' })),
    E('Demande support traitée', T.ticketClosed({ subject: 'Question sur une commande', reference: 'A1B2C3D4' })),
    E('Ajustement de crédits (geste commercial)', T.creditsAdjusted({ delta: 5, balance: 5, reason: 'Geste commercial' })),
    E('Compte Pro activé', T.proActivated()),
    E('Facture Pro incomplète', T.incompleteInvoice({ number: 'EV-2026-000002', missing: ['SIREN'] })),
    E('Profil modifié', T.profileUpdated({ fields: ['société', 'SIRET'] })),
    E('Inscription aux actualités confirmée', T.marketingChanged({ on: true, unsubUrl: 'https://eurovin.example/desabonnement?t=exemple' })),
    E('Compte supprimé', T.accountDeleted()),
    E('Alerte de connexion à l’administration', T.adminLogin({ email: 'proprietaire@exemple.fr', ip: '203.0.113.7', at: new Date().toISOString() })),
    E('Compte d’administration verrouillé', T.adminLocked({ email: 'lecteur@exemple.fr', ip: '203.0.113.7' })),
    E('Points à traiter chaque matin (admin)', T.adminDigest({ items: ['2 message(s) support ouvert(s)', '1 commande bloquée depuis plus de 15 minutes', '1 facture en erreur de synchronisation comptable'], date: '2026-10-05' })),
    E('Export comptable mensuel (admin / comptable)', T.monthlyExport({ month: '2026-09', invoices: 42, notes: 3, anomalies: 1 }), 'TVA-par-pays_2026-09.csv, Detail-pieces_2026-09.csv'),
  ];
  const mkInv = (s, m, desc, num) => { const d = I.buildInvoiceDetails({ s, m, seller, paidAtIso: new Date().toISOString(), description: desc }); return { number: num, issued_at: new Date().toISOString(), buyer_email: 'client@exemple.fr', description: desc, amount_ht_cents: d.lines[0].ht_cents, amount_tax_cents: d.lines[0].tax_cents, amount_ttc_cents: d.lines[0].ttc_cents, ...d }; };
  const invFR = mkInv({ amount_total: 5880, total_details: { amount_tax: 980 }, customer_details: { name: 'Jean Dupont', address: { line1: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'FR' }, tax_ids: [{ value: 'FR40732829320' }] } }, { kind: 'pack', company_name: 'Garage Dupont SARL', company_siret: '73282932000074' }, 'Pack 10 crédits', 'EV-2026-000002');
  const invEU = mkInv({ amount_total: 4900, total_details: { amount_tax: 0 }, customer_details: { name: 'Hans Müller', address: { line1: 'Hauptstraße 1', postal_code: '10115', city: 'Berlin', country: 'DE' }, tax_ids: [{ value: 'DE123456789' }] } }, { kind: 'pack', company_name: 'Autohaus Müller GmbH' }, 'Pack 10 crédits', 'EV-2026-000003');
  const invB2C = mkInv({ amount_total: 1299, total_details: { amount_tax: 217 }, customer_details: { name: 'Alice Martin', address: { line1: '3 rue des Fleurs', postal_code: '75001', city: 'Paris', country: 'FR' } } }, { kind: 'report' }, 'Rapport Premium — VIN ' + VIN, 'EV-2026-000001');
  const note = { number: 'AV-2026-000001', issued_at: new Date().toISOString(), buyer_email: 'client@exemple.fr', reason: 'Remboursement partiel', amount_ht_cents: 1000, amount_tax_cents: 200, amount_ttc_cents: 1200, buyer_type: invFR.buyer_type, buyer_name: invFR.buyer_name, buyer_address: invFR.buyer_address, buyer_country: 'FR', buyer_siren: invFR.buyer_siren, buyer_vat: invFR.buyer_vat, vat_rate: 20, vat_regime: 'standard', seller };
  const { buildCreditNotePdf } = require('./invoice'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-'));
  const png = async (name, buf) => { const f = path.join(tmp, name + '.pdf'); fs.writeFileSync(f, buf); execFileSync('pdftoppm', ['-png', '-r', '90', '-singlefile', f, path.join(tmp, name)]); return fs.readFileSync(path.join(tmp, name + '.png')).toString('base64'); };
  const docs = [
    { label: 'Facture Pro — client français', note: 'Pack de crédits : raison sociale, SIREN, n° de TVA, HT / TVA 20 % / TTC, pénalités de retard, indemnité de 40 €. Exploitable par le comptable pour récupérer la TVA.', png: await png('fr', await buildInvoicePdf(invFR, seller)) },
    { label: 'Facture Pro — client UE (autoliquidation)', note: 'Client de l’Union européenne avec n° de TVA : TVA à 0 et mention d’autoliquidation. Texte à faire valider par votre comptable.', png: await png('eu', await buildInvoicePdf(invEU, seller)) },
    { label: 'Facture particulier', note: 'Rapport à l’unité, TVA française incluse, sans mentions B2B.', png: await png('b2c', await buildInvoicePdf(invB2C, seller)) },
    { label: 'Avoir (remboursement partiel)', note: 'Référence à la facture d’origine, montants HT / TVA / TTC remboursés.', png: await png('avoir', await buildCreditNotePdf(note, invFR, seller)) },
  ];
  const adm = [['dashboard', 'Tableau de bord : chiffre d’affaires, alertes à traiter, réglages manquants'], ['commande', 'Commandes : détail, facture, remboursement total ou partiel avec double confirmation'], ['compta', 'Comptabilité : export mensuel TVA par pays, synchronisation Pennylane'], ['parametres', 'Paramètres : profil de l’exploitant (mentions légales des factures), état de la configuration, journal des actions']];
  for (const [k, label] of adm) { const f = path.join(__dirname, 'demo-assets', 'admin-' + k + '.png'); if (fs.existsSync(f)) docs.push({ label: 'Console admin — ' + { dashboard: 'tableau de bord', commande: 'commande', compta: 'comptabilité', parametres: 'paramètres' }[k], note: label + ' (capture de la vraie console /admin, données de test).', png: fs.readFileSync(f).toString('base64'), admin: true }); }
  const pdfInvoice2 = (await buildInvoicePdf(invFR, seller)).toString('base64');
  // --- Administration interactive : la VRAIE page admin + la VRAIE validation (siteconfig.js) sur des données fictives ---
  const S0 = (f) => fs.readFileSync(path.join(__dirname, 'site', f), 'utf8');
  const inl0 = (s) => { if (/<\/script/i.test(s)) throw new Error('</script dans un script inline'); return s; };
  const faq0 = [...S0('index.html').matchAll(/<details><summary>(.*?)<span class="mut"><\/span><\/summary><p>(.*?)<\/p><\/details>/g)].map((m) => ({ q: m[1].replace(/<[^>]+>/g, ''), a: m[2].replace(/<[^>]+>/g, '') }));
  if (faq0.length < 5) throw new Error('FAQ d’origine introuvable dans index.html');
  const shim = `const __m={};(function(module,exports){${fs.readFileSync(path.join(__dirname, 'lib.js'), 'utf8')}\n})(Object.assign(__m.lib={exports:{}}),__m.lib.exports);` +
    `window.SC=(function(){const module={exports:{}};const require=function(){return __m.lib.exports};(function(module,require){${fs.readFileSync(path.join(__dirname, 'siteconfig.js'), 'utf8')}\n})(module,require);return module.exports;})();`;
  const adminDoc = S0('admin.html')
    .replace('<link rel="icon" href="/logo-icone.svg" type="image/svg+xml">', '')
    .replace('<link rel="stylesheet" href="/style.css">', `<style>${S0('style.css')}</style>`)
    .replace('<link rel="stylesheet" href="/admin.css">', `<style>${S0('admin.css')}</style>`)
    .replace('<script src="/legal.js"></script>', `<script>${inl0(S0('legal.js'))}</script>`)
    .replace('<script src="/rich.js"></script>', `<script>${inl0(S0('rich.js'))}</script>`)
    .replace('<script src="/admin-plus.js"></script>', `<script>${inl0(S0('admin-plus.js'))}</script>`)
    .replace('<script src="/admin.js"></script>', `<script>window.EV_ORIG_FAQ=${inl0(JSON.stringify(faq0)).replace(/</g, '\\u003c')};${inl0(shim)}</script><script>${inl0(fs.readFileSync(path.join(__dirname, 'admin-mock.js'), 'utf8'))}</script><script>${inl0(S0('admin.js'))}</script>`);
  if (adminDoc.includes('src="/')) throw new Error('page admin : ressource externe restante');
  fs.writeFileSync(path.join(__dirname, 'admin-demo.html'), adminDoc.replace('<title>Administration — EuroVin</title>', '<title>Administration EuroVin</title>'));
  const data = { adminDoc, emails, docs, sample: require('./sample').sampleReport(), premium, essentiel, wmi: lib.WMI, packs: { 10: 5880, 30: 15480, 100: 45480 }, pdfReport, pdfInvoice: pdfInvoice2 };
  const S = (f) => fs.readFileSync(path.join(__dirname, 'site', f), 'utf8');
  const inl = (s) => { if (/<\/script/i.test(s)) throw new Error('</script dans un script inline'); return s; };
  let html = S('index.html').split('{{APP_URL}}').join('');
  html = html.replace('<link rel="icon" href="/logo-icone.svg" type="image/svg+xml">', `<link rel="icon" href="data:image/svg+xml;base64,${Buffer.from(S('logo-icone.svg')).toString('base64')}">`)
    .replace('<link rel="stylesheet" href="/style.css">', `<style>${S('style.css')}</style>`)
    .replace('<script src="/config.js"></script>', `<script>window.EV_CONFIG={demo:true};window.EV_DEMO_DATA=${inl(JSON.stringify(data).replace(/</g, '\\u003c'))};</script>`)
    .replace('<script src="/legal.js"></script>', `<script>${inl(S('legal.js'))}</script>`)
    .replace('<script src="/rich.js"></script>', `<script>${inl(S('rich.js'))}</script>`)
    .replace('<script src="/mobile.js"></script>', `<script>${inl(S('mobile.js'))}</script>`)
    .replace('<script src="/app.js"></script>', `<script>${inl(S('vinfacts.js'))}</script><script>${inl(S('demo.js'))}</script><script>${inl(S('app.js'))}</script><script>${inl(fs.readFileSync(path.join(__dirname, 'demo-extras.js'), 'utf8'))}</script><script>${inl(fs.readFileSync(path.join(__dirname, 'demo-admin.js'), 'utf8'))}</script>`)
    .replace('<nav class="topnav"', '<span class="chip">Démonstration · données fictives</span><nav class="topnav"')
    .replace('Estimations et informations non contractuelles', 'Version de démonstration : aucune donnée réelle, aucun paiement. Informations non contractuelles');
  if (!html.includes('EV_DEMO_DATA') || !html.includes('Démonstration ·')) throw new Error('remplacements incomplets');
  const out = process.argv[2] || path.join(__dirname, 'eurovin-prototype-integre.html'); fs.writeFileSync(out, html); console.log('écrit', out, (html.length / 1024).toFixed(0), 'Ko');
})().catch((e) => { console.error(e); process.exit(1); });
