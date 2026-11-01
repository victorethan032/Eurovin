'use strict';
const { Doc, COL } = require('./pdf');
const I = require('./invoicing');
const eur = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const dfr = (d) => new Date(d).toLocaleDateString('fr-FR');
const pct = (r) => `${String(r).replace('.', ',')} %`;
const sellerFromEnv = I.sellerFromEnv;

const sellerLines = (s) => {
  const L = [{ text: `${s.name || '[Vendeur à compléter]'}${s.legalForm && !String(s.name || '').toUpperCase().includes(String(s.legalForm).toUpperCase()) ? ' ' + s.legalForm : ''}`, bold: true }];
  if (s.capital) L.push({ text: `Capital de ${s.capital}` });
  L.push({ text: s.address || '[adresse à compléter]' });
  L.push({ text: `SIREN ${s.siren || '[à compléter]'}${s.rcs ? ' · ' + (/^RCS\b/i.test(s.rcs) ? '' : 'RCS ') + s.rcs : ''}` });
  if (s.vat) L.push({ text: `N° TVA intracommunautaire : ${s.vat}` });
  if (s.email) L.push({ text: s.email });
  return L;
};
const buyerLines = (d) => {
  const a = d.buyer_address || {}, L = [{ text: 'Facturé à', bold: true }];
  L.push({ text: d.buyer_name || d.buyer_email, bold: true });
  if (a.line1) L.push({ text: a.line1 }); if (a.line2) L.push({ text: a.line2 });
  const cityLine = [a.postal_code, a.city].filter(Boolean).join(' '); if (cityLine) L.push({ text: cityLine });
  if (a.country) L.push({ text: a.country });
  if (d.buyer_siren) L.push({ text: `SIREN ${d.buyer_siren}` });
  if (d.buyer_vat) L.push({ text: `N° TVA : ${d.buyer_vat}` });
  L.push({ text: d.buyer_email });
  return L;
};
const W = [215, 40, 80, 60, 100], AL = ['l', 'r', 'r', 'r', 'r'];   // total = 495

function table(doc, lines, sign = 1) {
  doc.trow(['Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'], W, AL, { bold: true, color: COL.mut, size: 8 });
  for (const l of lines) doc.trow([l.label, String(l.qty), eur(sign * l.unit_ht_cents), pct(l.vat_rate), eur(sign * l.ht_cents)], W, AL);
}
function totals(doc, ht, tax, ttc, rate, labelTtc) {
  doc.gap(6);
  doc.row('Total HT', eur(ht)); doc.row(`TVA ${pct(rate)}`, eur(tax)); doc.row(labelTtc, eur(ttc), { bold: true, size: 12 });
}

/** inv = ligne de la table invoices ; seller = copie du vendeur (celle de la facture a priorité sur l'environnement). */
async function buildInvoicePdf(inv, seller) {
  const S = inv.seller || seller || {};
  const doc = await Doc.create(`Facture ${inv.number}`, `Facture ${inv.number}`);
  doc.text('FACTURE', { size: 20, bold: true, align: 'right', gap: 2 });
  doc.text(`N° ${inv.number}`, { bold: true, align: 'right', gap: 0 });
  doc.text(`Date d’émission : ${dfr(inv.issued_at)}`, { align: 'right', size: 9, gap: 0 });
  if (inv.service_date) doc.text(`Date de la prestation : ${dfr(inv.service_date)}`, { align: 'right', size: 9, gap: 8 });
  doc.twoCols(sellerLines(S), buyerLines(inv));
  doc.hr();
  doc.text(`Nature de l’opération : ${inv.operation_nature === 'goods' ? 'livraison de biens' : 'prestation de services'} (accès numérique à un rapport ou crédits de rapports)`, { size: 9, gap: 6 });
  table(doc, I.linesOf(inv));
  const rate = inv.vat_rate != null ? Number(inv.vat_rate) : I.vatRate(inv.amount_ht_cents, inv.amount_tax_cents);
  totals(doc, inv.amount_ht_cents, inv.amount_tax_cents, inv.amount_ttc_cents, rate, 'Total TTC');
  doc.gap(6);
  const paid = inv.paid_at ? `Facture acquittée le ${dfr(inv.paid_at)} par paiement en ligne (Stripe). Reste à payer : ${eur(0)}.` : '';
  if (paid) doc.text(paid, { size: 9, bold: true });
  if (inv.due_date) doc.text(`Date d’échéance : ${dfr(inv.due_date)}`, { size: 9 });
  if (inv.vat_mention) doc.text(inv.vat_mention, { size: 9 });
  if (inv.payment_terms) doc.text(inv.payment_terms, { size: 8, color: COL.mut });
  doc.gap(4);
  doc.text('Service numérique fourni immédiatement à la demande expresse du client, qui a reconnu renoncer à son droit de rétractation.', { size: 8, color: COL.mut });
  return doc.save();
}

/** note = ligne de la table credit_notes ; inv = facture d'origine (peut être null). */
async function buildCreditNotePdf(note, inv, seller) {
  const S = note.seller || (inv && inv.seller) || seller || {};
  const doc = await Doc.create(`Avoir ${note.number}`, `Avoir ${note.number}`);
  doc.text('AVOIR', { size: 20, bold: true, align: 'right', gap: 2 });
  doc.text(`N° ${note.number}`, { bold: true, align: 'right', gap: 0 });
  doc.text(`Date d’émission : ${dfr(note.issued_at)}`, { align: 'right', size: 9, gap: 0 });
  if (inv) doc.text(`Annule et remplace en partie ou en totalité la facture n° ${inv.number}`, { align: 'right', size: 9, gap: 8 });
  doc.twoCols(sellerLines(S), buyerLines({ ...note, buyer_vat: note.buyer_vat }));
  doc.hr();
  doc.text(`Motif : ${note.reason || 'Remboursement'}`, { size: 9, gap: 6 });
  const rate = note.vat_rate != null ? Number(note.vat_rate) : I.vatRate(note.amount_ht_cents, note.amount_tax_cents);
  doc.trow(['Désignation', 'Qté', 'PU HT', 'TVA', 'Total HT'], W, AL, { bold: true, color: COL.mut, size: 8 });
  doc.trow([`Remboursement${inv && inv.description ? ' : ' + inv.description : ''}`, '1', eur(note.amount_ht_cents), pct(rate), eur(note.amount_ht_cents)], W, AL);
  totals(doc, note.amount_ht_cents, note.amount_tax_cents, note.amount_ttc_cents, rate, 'Total TTC remboursé');
  doc.gap(6);
  if (note.vat_mention) doc.text(note.vat_mention, { size: 9 });
  doc.text('Montant remboursé sur le moyen de paiement utilisé pour la commande.', { size: 8, color: COL.mut });
  return doc.save();
}
module.exports = { buildInvoicePdf, buildCreditNotePdf, sellerFromEnv };
