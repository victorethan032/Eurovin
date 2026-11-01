'use strict';
// Facturation conforme (France 2026) + export comptable + synchronisation Pennylane (faux serveur HTTP). Le VRAI server.js tourne avec de faux services.
const assert = require('assert'), fs = require('fs'), start = require('./testkit/harness'), fakePl = require('./testkit/fake-pennylane'), I = require('./invoicing');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0; const ok = (c, m) => { assert.ok(c, m); pass++; };
const J = async (r) => ({ status: r.status, body: await r.json().catch(() => null), text: null });

// ---- règles pures ----
const seller = { name: 'EuroVin SAS', legalForm: 'SAS', capital: '1000', siren: '123456789', rcs: 'Lyon', address: '1 rue X, 69001 Lyon', vat: 'FR12123456789' };
ok(I.sellerMissing(seller).length === 0, 'vendeur complet');
ok(I.sellerMissing({ ...seller, rcs: '', vat: '' }).join() === 'SELLER_RCS,SELLER_VAT', 'mentions vendeur manquantes détectées');
ok(I.sellerMissing({ ...seller, vat: '', franchise: true }).length === 0, 'franchise en base : pas de n° de TVA exigé');
ok(I.vatRate(1083, 216) === 19.9 || I.vatRate(1083, 217) === 20, 'taux déduit des montants');
ok(I.vatRegime({ taxCents: 100, buyerCountry: 'FR' }) === 'standard', 'régime standard');
ok(I.vatRegime({ taxCents: 0, buyerCountry: 'DE', buyerVat: 'DE123456789' }) === 'reverse_charge', 'autoliquidation UE avec n° de TVA');
ok(I.vatRegime({ taxCents: 0, buyerCountry: 'DE', buyerVat: null }) === 'zero_review', 'TVA nulle sans n° de TVA : à valider');
ok(I.vatRegime({ taxCents: 0, buyerCountry: 'FR', franchise: true }) === 'franchise', 'franchise');
const sess = { amount_total: 5880, total_details: { amount_tax: 980 }, customer_details: { name: 'X', address: { line1: '1 rue A', postal_code: '75001', city: 'Paris', country: 'fr' }, tax_ids: [{ value: 'FR40732829320' }] } };
const d = I.buildInvoiceDetails({ s: sess, m: { kind: 'pack', company_name: 'Garage SARL', company_siret: '73282932000074' }, seller, paidAtIso: '2026-10-05T10:00:00Z', description: 'Pack 10 crédits' });
ok(d.buyer_type === 'professionnel' && d.buyer_name === 'Garage SARL' && d.buyer_siren === '732829320' && d.buyer_country === 'FR', 'identité acheteur pro');
ok(d.lines[0].ht_cents === 4900 && d.lines[0].tax_cents === 980 && d.lines[0].ttc_cents === 5880 && d.vat_rate === 20, 'HT + TVA = TTC, taux 20 %');
ok(/pénalités/.test(d.payment_terms) && /40 €/.test(d.payment_terms), 'pénalités de retard et indemnité 40 € (B2B)');
ok(I.missingBuyerFields(d).length === 0 && I.missingBuyerFields({ ...d, buyer_siren: null }).join() === 'SIREN', 'complétude acheteur pro (SIREN)');
const dc = I.buildInvoiceDetails({ s: sess, m: { kind: 'report' }, seller, description: 'Rapport' });
ok(dc.buyer_type === 'particulier' && dc.payment_terms === null && dc.buyer_siren === null, 'particulier : pas de mentions B2B');
ok(I.accountingCsv([{ number: 'EV-1', issued_at: '2026-10-05T10:00:00Z', buyer_name: '=cmd|x', amount_ht_cents: 4900, amount_tax_cents: 980, amount_ttc_cents: 5880, vat_rate: 20, vat_regime: 'standard' }]).includes("'=cmd|x;"), 'CSV : injection de formule neutralisée');
const csvS = I.accountingCsv([{ number: 'EV-1', issued_at: '2026-10-05T10:00:00Z', buyer_name: 'A;B', amount_ht_cents: 4900, amount_tax_cents: 980, amount_ttc_cents: 5880, vat_rate: 20 }], [{ number: 'AV-1', issued_at: '2026-10-06T10:00:00Z', invoice_number: 'EV-1', amount_ht_cents: 1000, amount_tax_cents: 200, amount_ttc_cents: 1200 }]);
ok(csvS.startsWith('﻿') && csvS.includes('"A;B"') && csvS.includes('49,00;9,80;58,80') && csvS.includes('-10,00;-2,00;-12,00'), 'CSV : BOM, virgule décimale, guillemets, avoir en négatif');

(async () => {
  const pl = await fakePl();
  const h = await start({ env: { SELLER_NAME: 'EuroVin SAS', SELLER_LEGAL_FORM: 'SAS', SELLER_CAPITAL: '1000', SELLER_SIREN: '123456789', SELLER_RCS: 'Lyon', SELLER_ADDRESS: '1 rue X, 69001 Lyon', SELLER_VAT: 'FR12123456789', PENNYLANE_API_TOKEN: 'plk_test', PENNYLANE_API_URL: pl.url } });
  const B = h.base, db = h.supabase.db, AK = { 'x-admin-key': 'a'.repeat(40) };
  const post = (p, body, headers = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }).then(J);
  const waitFor = async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(60); } throw new Error('timeout'); };
  const gt = (p, b) => fetch(h.gotrueUrl + '/auth/v1/' + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(J);
  try {
    const su = await gt('signup', { email: 'pro@garage.fr', password: 'motdepasse-long' }); const A = { authorization: 'Bearer ' + su.body.access_token };
    await fetch(B + '/api/me', { method: 'PATCH', headers: { 'content-type': 'application/json', ...A }, body: JSON.stringify({ company_name: 'Garage Dupont SARL', company_siret: '73282932000074', company_vat: 'FR40732829320' }) });
    const sid = (await post('/api/checkout', { kind: 'pack', packSize: 10, consent: { cgv: true } }, A)).body.url.split('/').pop();
    await h.payWebhook(sid, { email: 'pro@garage.fr', details: { name: 'Jean', address: { line1: '12 rue des Lilas', postal_code: '69003', city: 'Lyon', country: 'FR' } } });
    let inv = db.invoices[0];
    ok(inv.buyer_type === 'professionnel' && inv.buyer_siren === '732829320' && inv.buyer_name === 'Garage Dupont SARL' && inv.details_complete === true, 'facture pro : détails stockés');
    ok(inv.seller && inv.seller.siren === '123456789' && inv.lines.length === 1 && inv.vat_rate === 20, 'copie du vendeur et lignes figées sur la facture');
    await waitFor(() => db.invoices[0].accounting_status === 'synced');
    ok(pl.st.customers.length === 1 && pl.st.customers[0].reg_no === '732829320' && pl.st.files === 1 && pl.st.invoices.length === 1, 'Pennylane : client + PDF + facture envoyés');
    const pi = pl.st.invoices[0];
    ok(pi.external_reference === inv.number && pi.invoice_lines[0].vat_rate === 'FR_200' && pi.invoice_lines[0].currency_amount === '58.80' && pi.invoice_lines[0].currency_tax === '9.80', 'Pennylane : référence, code TVA FR_200, montants TTC/TVA');
    ok(pl.st.calls.every((c) => c.auth === 'Bearer plk_test'), 'jeton Pennylane envoyé');
    ok(db.invoices[0].accounting_ref === '9001', 'référence Pennylane mémorisée');

    // client particulier : regroupé sous un seul client
    const buyR = async (email, vin, details, tax) => { const s = (await post('/api/checkout', { kind: 'report', vin, plan: 'essentiel', email, consent: { cgv: true, waiver: true } })).body.url.split('/').pop(); await h.payWebhook(s, { email, details, taxCents: tax }); return s; };
    await buyR('a@x.fr', 'WBA8E9C50GK111111', { name: 'Alice', address: { country: 'FR' } });
    await buyR('b@x.fr', 'WBA8E9C50GK222222', { name: 'Bob', address: { country: 'FR' } });
    await waitFor(() => db.invoices.filter((i) => i.accounting_status === 'synced').length === 3);
    ok(pl.st.customers.length === 2 && db.invoices.filter((i) => i.buyer_type === 'particulier').length === 2, 'particuliers regroupés sous un seul client Pennylane');
    ok(db.invoices[1].payment_terms === null && db.invoices[1].buyer_siren === null, 'facture particulier sans mentions B2B');

    // TVA non standard (client allemand, 0 € de TVA) -> à valider, rien n'est envoyé
    const nb = pl.st.invoices.length;
    await buyR('de@x.de', 'WBA8E9C50GK333333', { name: 'Hans', address: { country: 'DE' } }, 0);
    const dei = await waitFor(() => db.invoices.find((i) => i.buyer_email === 'de@x.de' && i.accounting_status === 'needs_review'));
    ok(dei.vat_regime === 'zero_review' && /TVA à valider/.test(dei.accounting_error) && pl.st.invoices.length === nb, 'TVA à 0 sans n° : mise « à valider », non envoyée à Pennylane');

    // panne Pennylane : la commande n'est jamais bloquée, réessai ensuite
    pl.st.fail = true;
    const sidF = await buyR('c@x.fr', 'WBA8E9C50GK444444', { name: 'Carl', address: { country: 'FR' } });
    const ci = await waitFor(() => db.invoices.find((i) => i.buyer_email === 'c@x.fr' && i.accounting_status === 'error'));
    ok(ci.accounting_attempts === 1 && /500/.test(ci.accounting_error), 'panne Pennylane : erreur enregistrée');
    ok(db.orders.find((o) => o.stripe_session_id === sidF), 'la commande est enregistrée malgré la panne');
    pl.st.fail = false;
    const rt = await post('/api/admin/accounting/retry', { id: ci.id }, AK);
    ok(rt.body.status === 'synced' && ci.accounting_status === 'synced', 'relance admin → synchronisée');
    const nInv = pl.st.invoices.length;
    const sw = await fetch(B + '/api/jobs/sweep', { method: 'POST', headers: { 'x-cron-secret': 'c'.repeat(32) } });
    ok(sw.status === 200 && pl.st.invoices.length === nInv, 'passe cron : aucune facture envoyée deux fois');

    // webhook rejoué : aucun doublon
    await h.payWebhook(sid, { email: 'pro@garage.fr', eventId: 'evt_replay' });
    ok(db.invoices.length === 5 && db.invoices[0].details_complete === true, 'paiement rejoué : pas de doublon');

    // admin : liste + export CSV
    ok((await fetch(B + '/api/admin/accounting').then(J)).status === 401, 'admin comptabilité protégé');
    const lst = (await fetch(B + '/api/admin/accounting?status=needs_review', { headers: AK }).then(J)).body;
    ok(lst.pennylane === true && lst.items.length === 1, 'liste admin filtrée par statut');
    const buf = Buffer.from(await fetch(B + '/api/admin/accounting/export?from=2000-01-01&to=2999-12-31', { headers: AK }).then((r) => r.arrayBuffer())); const csv = buf.toString('utf8');
    ok(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'export CSV avec BOM UTF-8');
    ok(csv.split('\r\n').filter(Boolean).length === 6 && csv.includes('732829320') && csv.includes('Facture;EV-2026-000001'), 'CSV : 5 factures + en-tête, SIREN présent');
  } finally { h.close(); pl.close(); }
  console.log(`facturation : ${pass} vérifications OK`);
  process.exit(0);
})().catch((e) => { console.error(`ÉCHEC après ${pass} vérifications :`, e); process.exit(1); });
