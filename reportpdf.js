'use strict';
const { Doc, COL } = require('./pdf');
const eur = (c) => `${(c / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const eurN = (n) => `${Math.round(n).toLocaleString('fr-FR')} €`;
const dfr = (d) => (d ? new Date(d).toLocaleDateString('fr-FR') : '—');
const KIND = { accident: 'Accident', flood: 'Inondation', fire: 'Incendie', hail: 'Grêle', theft_damage: 'Dommages liés à un vol', other: 'Autre sinistre' };
const TRI = (s, what) => ({
  found: null,
  none_found: `Aucun ${what} trouvé dans les sources consultées`,
  unavailable: 'Information non disponible pour ce véhicule',
}[s]);

/** pub = résultat de publicReport() côté serveur. Les rapports d'avant la v2 (pub.report == null) n'ont pas de PDF. */
async function buildReportPdf(pub, seller) {
  const r = pub.report;
  if (!r) throw new Error('RAPPORT_ANCIEN_FORMAT');
  const v = r.vehicle || {};
  const doc = await Doc.create(`Rapport EuroVin ${r.vin}`, `Rapport ${pub.reference}`);
  doc.text('EuroVin', { size: 11, bold: true, color: COL.ac, gap: 0 });
  doc.text(`Rapport ${r.plan === 'premium' ? 'Premium' : 'Essentiel'} · ${pub.reference}`, { size: 9, color: COL.mut, gap: 8 });
  doc.h1([v.make, v.model, v.trim].filter(Boolean).join(' ') || 'Véhicule');
  doc.text(`VIN ${r.vin}${v.year ? ' · ' + v.year : ''}${v.engine ? ' · ' + v.engine : ''}`, { color: COL.mut });
  doc.text(`Généré le ${dfr(r.generatedAt || pub.createdAt)} · Lien valable jusqu’au ${dfr(pub.expiresAt)}`, { size: 9, color: COL.mut });
  if (r.notices && r.notices.length) { doc.gap(6); doc.box(['À savoir', ...r.notices.map((n) => '• ' + n)], { bg: rgbWarn() }); }

  // Options
  const o = r.options;
  doc.h2(`Options d’usine (${o.count})`);
  if (o.pricedCount) doc.box([`Valeur catalogue des options installées : ${eur(o.totalCents)}`, 'Prix catalogue d’origine, à neuf. Ce n’est pas la valeur de revente.']);
  const cats = new Map();
  for (const it of o.items) { const c = it.category || 'Autres options'; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(it); }
  for (const [c, items] of cats) {
    const sum = items.reduce((s, x) => s + (x.priceCents || 0), 0);
    doc.row(c, sum ? eur(sum) : '', { bold: true, color: COL.mut, size: 9 });
    for (const it of items) doc.row(`${it.code}  ${it.label}`, it.priceCents != null ? eur(it.priceCents) : 'prix indisponible', { indent: 6, rule: true, rcolor: it.priceCents != null ? COL.ink : COL.mut });
  }

  // Fiche technique
  if (r.techSheet && r.techSheet.sections.length) {
    doc.h2('Fiche technique');
    for (const s of r.techSheet.sections) { doc.text(s.title, { bold: true, size: 9, color: COL.mut, gap: 1 }); for (const x of s.rows) doc.row(x.k, x.v, { indent: 6, rule: true }); doc.gap(4); }
  }

  // Rappels
  if (r.recalls) {
    doc.h2('Campagnes de rappel constructeur');
    if (r.recalls.status === 'found') {
      doc.text(`${r.recalls.items.length} campagne(s) trouvée(s)${r.recalls.todo ? `, dont ${r.recalls.todo} à réaliser. Contactez un concessionnaire de la marque.` : ', toutes réalisées.'}`, { color: r.recalls.todo ? COL.warn : COL.ok });
      for (const x of r.recalls.items) doc.row(`${x.date}  ${x.title}${x.ref ? ' (réf. ' + x.ref + ')' : ''}`, x.done ? 'Réalisée' : 'À réaliser', { indent: 6, rule: true, rcolor: x.done ? COL.ok : COL.warn });
    } else doc.text(r.recalls.status === 'none_found' ? 'Aucune campagne trouvée dans les sources consultées.' : 'Information non disponible pour ce véhicule.');
  }

  // Provenance
  if (r.provenance) {
    const p = r.provenance;
    doc.h2('Provenance et historique');
    if (p.status !== 'ok') doc.text('Information non disponible pour ce véhicule.');
    else {
      for (const e of p.events) doc.row(`${e.date}  ${e.title}`, e.place || '', { indent: 6, rule: true });
      doc.gap(4);
      const line = (name, t, what) => { const m = TRI(t.status, what); doc.row(name, m || (t.text || 'Signalement trouvé'), { indent: 6, rule: true, rcolor: t.status === 'found' ? COL.warn : COL.ink }); };
      line('Vol', p.theft, 'signalement'); line('Gage', p.lien, 'gage');
      if (p.damage.status === 'found') { doc.row('Sinistres', `${p.damage.items.length} trouvé(s)`, { indent: 6, bold: true, rcolor: COL.warn }); for (const d of p.damage.items) doc.row(`${d.date}  ${KIND[d.kind]}${d.text ? ' : ' + d.text : ''}`, d.country || '', { indent: 14, rule: true }); }
      else line('Sinistres', p.damage, 'sinistre');
      if (p.source) doc.text(`Source : ${p.source}${p.asOf ? ', données au ' + dfr(p.asOf) : ''}. Un historique « vide » ne prouve pas l’absence d’événement : la couverture varie selon les pays.`, { size: 8, color: COL.mut });
    }
  }

  // Comparatif
  if (r.comparison) {
    const c = r.comparison;
    doc.h2('Comparatif avec la finition');
    if (c.status !== 'ok') doc.text('Comparatif non disponible : catalogue de la finition incomplet.');
    else {
      doc.text(`Équipé à ${c.equippedPct} %${c.weightedByPrice ? ' (pondéré par le prix catalogue)' : ''} : ${c.presentCount} option(s) présente(s), ${c.missingCount} non incluse(s).`, { bold: true });
      for (const m of c.missing) doc.row(`${m.code}  ${m.label}`, m.priceCents != null ? 'catalogue ' + eur(m.priceCents) : '', { indent: 6, rule: true, color: COL.mut });
    }
  }

  // Cotation (uniquement si disponible)
  if (r.valuation && r.valuation.status === 'ok') {
    const val = r.valuation;
    doc.h2('Cotation indicative');
    doc.row('Vente rapide', eurN(val.low)); doc.row('Marché', eurN(val.mid), { bold: true }); doc.row('Haute fourchette', eurN(val.high));
    if (r.explanation) doc.text(r.explanation, { size: 9, color: COL.mut });
  } else if (r.valuation && r.valuation.status === 'not_estimable') { doc.h2('Cotation indicative'); doc.text('Non estimable : pas assez d’annonces comparables. Nous préférons ne rien afficher plutôt qu’un prix peu fiable.'); }

  // Sources et mentions
  doc.h2('Sources');
  for (const s of r.sources) doc.row(`${s.name} : ${s.role}`, s.asOf ? 'données au ' + dfr(s.asOf) : '', { size: 9, rule: true });
  doc.gap(8);
  doc.text('Document informatif fondé sur des données de tiers, non contractuel. Il ne constitue ni une expertise, ni une inspection, ni une garantie de l’état ou du prix du véhicule.', { size: 8, color: COL.mut });
  if (seller && seller.name) doc.text(`${seller.name}${seller.legalForm ? ' ' + seller.legalForm : ''}${seller.email ? ' · ' + seller.email : ''}`, { size: 8, color: COL.mut });
  return doc.save();
}
function rgbWarn() { return require('pdf-lib').rgb(1, 0.96, 0.88); }
module.exports = { buildReportPdf };
