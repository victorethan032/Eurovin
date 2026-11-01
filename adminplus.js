'use strict';
/**
 * Fonctions de pilotage de l'administration : graphiques, qualité des rapports, coûts et marge, recherche globale,
 * codes promo (via Stripe), libellés en lot, notes client, textes d'e-mails, brouillon / aperçu / publication planifiée du site.
 */
const crypto = require('crypto');
const lib = require('./lib');
const SC = require('./siteconfig');
const M = require('./mail');

const ymd = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const clampDays = (v, d = 30, max = 365) => Math.min(Math.max(parseInt(v, 10) || d, 1), max);
const UUID = /^[0-9a-f-]{36}$/i;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;

/* ---------- aperçu du brouillon : lien signé à durée limitée ---------- */
const previewSecret = (env) => crypto.createHash('sha256').update('preview|' + (env.ADMIN_ENC_KEY || env.ADMIN_API_KEY || '')).digest();
function signPreview(env, now = Date.now(), ttlMs = 30 * 60e3) {
  const exp = String(now + ttlMs), sig = crypto.createHmac('sha256', previewSecret(env)).update(exp).digest('hex').slice(0, 32);
  return exp + '.' + sig;
}
function verifyPreview(env, token, now = Date.now()) {
  const [exp, sig] = String(token || '').split('.');
  if (!/^\d{10,15}$/.test(exp || '') || !/^[0-9a-f]{32}$/.test(sig || '') || +exp < now) return false;
  const want = crypto.createHmac('sha256', previewSecret(env)).update(exp).digest('hex').slice(0, 32);
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

/* ---------- calculs purs (testables) ---------- */
/* Marge réelle : frais Stripe réellement prélevés + charges saisies (données, outils, hébergement…). Les commandes dont le frais Stripe est inconnu sont estimées avec vos taux et signalées. */
const EXP_CATS = { donnees: 'Données véhicule', outils: 'Outils et logiciels', hebergement: 'Hébergement et e-mails', publicite: 'Publicité', autre: 'Autre' };
function validExpense(b) {
  const o = b && typeof b === 'object' ? b : {}, label = String(o.label || '').trim().slice(0, 80), cents = Number(o.amount_ht_cents);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.date || '')) || Number.isNaN(Date.parse(o.date)) || !label || !(o.category in EXP_CATS) || !Number.isInteger(cents) || cents < 1 || cents > 10000000) return null;
  return { date: o.date, label, category: o.category, amount_ht_cents: cents };
}
function buildRealMargin(orders, expenses, costs, days, now = Date.now(), range = null) {
  const c = { ...COSTS_DEFAULT, ...(costs || {}) }, from = range ? range.from : ymd(now - (days - 1) * 864e5), to = range ? range.to : ymd(now);
  let ttc = 0, tax = 0, known = 0, feeKnown = 0, feeEst = 0, withFee = 0, paying = 0;
  for (const o of orders) {
    if (o.kind === 'credit_use') continue;
    ttc += (o.amount_ttc_cents || 0) - (o.refunded_cents || 0); tax += (o.amount_tax_cents || 0) - (o.refunded_tax_cents || 0);
    if (!(o.amount_ttc_cents > 0)) continue;
    paying++;
    if (Number.isInteger(o.stripe_fee_cents)) { feeKnown += o.stripe_fee_cents; withFee++; } else feeEst += Math.round(o.amount_ttc_cents * c.stripe_pct / 100) + c.stripe_fixed_cents;
  }
  const byCategory = {}; let exp = 0;
  for (const e of expenses || []) if (e.date >= from && e.date <= to) { exp += e.amount_ht_cents; byCategory[e.category] = (byCategory[e.category] || 0) + e.amount_ht_cents; }
  const ht = ttc - tax, fees = feeKnown + feeEst;
  return { revenue_ht_cents: ht, tax_cents: tax, stripe_fees_cents: fees, stripe_fees_actual_cents: feeKnown, stripe_fees_estimated_cents: feeEst, paying_orders: paying, orders_with_actual_fee: withFee, expenses_cents: exp, by_category: byCategory,
    margin_cents: ht - fees - exp, marginRate: ht > 0 ? (ht - fees - exp) / ht : null, complete: withFee === paying, from, to };
}

/* Ce qui se vend / ne se vend pas : ventes, remboursements et paiements abandonnés par offre. Les offres sans aucune vente restent listées (à zéro). */
const OFFERS = [['report:essentiel', 'Rapport Essentiel'], ['report:premium', 'Rapport Premium'], ['pack:10', 'Pack 10 crédits'], ['pack:30', 'Pack 30 crédits'], ['pack:100', 'Pack 100 crédits']];
function buildUnsold(orders, abandoned, days) {
  const by = new Map(OFFERS.map(([key, label]) => [key, { key, label, sold: 0, refunded: 0, abandoned: 0 }]));
  const keyOf = (o) => (o.kind === 'report' ? 'report:' + o.plan : o.kind === 'pack' ? 'pack:' + (o.credits_delta != null ? o.credits_delta : o.pack_size) : null);
  for (const o of orders || []) { const k = keyOf(o), r = by.get(k); if (!r) continue; r.sold++; if (o.refunded_cents > 0) r.refunded++; }
  for (const a of abandoned || []) { const r = by.get(keyOf(a)); if (r) r.abandoned++; }
  const offers = Array.from(by.values()).map((r) => ({ ...r, started: r.sold + r.abandoned, abandonRate: r.sold + r.abandoned ? r.abandoned / (r.sold + r.abandoned) : null, refundRate: r.sold ? r.refunded / r.sold : null }))
    .sort((a, b) => a.sold - b.sold || b.abandoned - a.abandoned || (a.key < b.key ? -1 : 1));
  const abandonedTotal = offers.reduce((s, r) => s + r.abandoned, 0), soldTotal = offers.reduce((s, r) => s + r.sold, 0);
  return { days, offers, notSelling: offers.filter((r) => r.sold === 0).map((r) => r.key), abandonedTotal, soldTotal, abandonRate: soldTotal + abandonedTotal ? abandonedTotal / (soldTotal + abandonedTotal) : null, trackingOn: abandonedTotal > 0 };
}

/* ---------- comparaison, entonnoir, marques, crédits Pro, TVA, santé technique, objectif, récapitulatif ---------- */
const paidOrder = (o) => o.kind !== 'credit_use' && o.amount_ttc_cents != null;
const netTtc = (o) => (o.amount_ttc_cents || 0) - (o.refunded_cents || 0);
const taxNet = (o) => { const tax = o.amount_tax_cents || 0, rt = o.refunded_tax_cents != null ? o.refunded_tax_cents : (o.amount_ttc_cents ? Math.round(tax * (o.refunded_cents || 0) / o.amount_ttc_cents) : 0); return tax - rt; };
const pctDelta = (cur, prev) => (prev > 0 ? (cur - prev) / prev : null);
function periodStats(orders) {
  let ttc = 0, ht = 0, n = 0, ref = 0;
  for (const o of orders || []) { if (!paidOrder(o)) continue; const v = netTtc(o); ttc += v; ht += v - taxNet(o); n++; if (o.refunded_cents > 0) ref++; }
  return { net_ttc_cents: ttc, net_ht_cents: ht, orders: n, refundRate: n ? ref / n : 0, avgBasket_cents: n ? Math.round(ttc / n) : 0 };
}
function buildCompare(cur, prev, days) {
  const c = periodStats(cur), p = periodStats(prev);
  return { days, current: c, previous: p, delta: { net_ttc: pctDelta(c.net_ttc_cents, p.net_ttc_cents), net_ht: pctDelta(c.net_ht_cents, p.net_ht_cents), orders: pctDelta(c.orders, p.orders), avgBasket: pctDelta(c.avgBasket_cents, p.avgBasket_cents), refundRate: c.refundRate - p.refundRate }, hasPrevious: p.orders > 0 };
}
const FUNNEL_STEPS = [['lookup', 'VIN saisi (aperçu)'], ['checkout', 'Paiement commencé'], ['paid', 'Rapport payé'], ['opened', 'Rapport ouvert']];
function buildFunnel(rows, orders, days) {
  const n = { lookup: 0, checkout: 0, opened: 0 };
  for (const r of rows || []) if (r.step in n) n[r.step] += r.n || 0;
  const paid = (orders || []).filter((o) => o.kind === 'report' && o.amount_ttc_cents != null).length;
  const counts = { lookup: n.lookup, checkout: n.checkout, paid, opened: n.opened };
  const steps = FUNNEL_STEPS.map(([key, label], i) => { const prev = i ? counts[FUNNEL_STEPS[i - 1][0]] : null; return { key, label, count: counts[key], fromPrevious: prev ? counts[key] / prev : null }; });
  return { days, steps, overall: n.lookup ? paid / n.lookup : null, trackingOn: n.lookup > 0 || n.checkout > 0 };
}
function buildBrands(rows, orders, reports) {
  const by = new Map(), get = (b) => { if (!by.has(b)) by.set(b, { brand: b, lookups: 0, paid: 0, optSum: 0, optN: 0 }); return by.get(b); };
  for (const r of rows || []) if (r.step === 'lookup') get(r.brand || 'Autre / inconnue').lookups += r.n || 0;
  const rep = new Map((reports || []).map((x) => [x.order_id, x]));
  for (const o of orders || []) { if (o.kind !== 'report' || !o.vin || o.amount_ttc_cents == null) continue; const b = get(lib.brandFromVin(o.vin) || 'Autre / inconnue'); b.paid++; const x = rep.get(o.id); if (x) { b.optSum += x.options_count || 0; b.optN++; } }
  const list = Array.from(by.values()).map((b) => ({ brand: b.brand, lookups: b.lookups, paid: b.paid, withoutPurchase: Math.max(b.lookups - b.paid, 0), conversion: b.lookups ? Math.min(b.paid / b.lookups, 1) : null, avgOptions: b.optN ? Math.round(b.optSum / b.optN) : null }))
    .filter((b) => b.lookups > 0).sort((a, b) => b.withoutPurchase - a.withoutPurchase || a.brand.localeCompare(b.brand));
  return { brands: list.slice(0, 20), trackingOn: list.length > 0 };
}
function buildProCredits(users, orders, now = Date.now(), threshold = 2) {
  const packs = new Map(), uses = new Map();
  for (const o of orders || []) { if (!o.user_id) continue; const t = Date.parse(o.created_at);
    if (o.kind === 'pack') { const x = packs.get(o.user_id) || { n: 0, last: 0 }; x.n++; x.last = Math.max(x.last, t); packs.set(o.user_id, x); }
    else if (o.kind === 'credit_use') { const x = uses.get(o.user_id) || { n: 0, last: 0 }; x.n++; x.last = Math.max(x.last, t); uses.set(o.user_id, x); } }
  const rank = { never: 0, sleeping: 1, low: 2, empty: 3, ok: 4 };
  const items = (users || []).filter((u) => u.role === 'pro').map((u) => {
    const pk = packs.get(u.id) || { n: 0, last: 0 }, us = uses.get(u.id) || { n: 0, last: 0 }, bal = u.credits_balance || 0, idle = us.last ? Math.floor((now - us.last) / 864e5) : null;
    let status = 'ok';
    if (pk.n > 0 && us.n === 0 && bal > 0) status = 'never'; else if (bal > 0 && (idle == null || idle >= 60)) status = 'sleeping'; else if (bal === 0 && us.n > 0) status = 'empty'; else if (bal > 0 && bal <= threshold) status = 'low';
    return { id: u.id, email: u.email, company: u.company_name || null, balance: bal, packs: pk.n, lastPurchase: pk.last ? new Date(pk.last).toISOString() : null, uses: us.n, lastUse: us.last ? new Date(us.last).toISOString() : null, idleDays: idle, status };
  }).sort((a, b) => rank[a.status] - rank[b.status] || b.balance - a.balance).slice(0, 100);
  const count = (k) => items.filter((i) => i.status === k).length;
  return { items, summary: { total: items.length, never: count('never'), sleeping: count('sleeping'), low: count('low'), empty: count('empty'), creditsOutstanding: items.reduce((a, i) => a + i.balance, 0) }, threshold };
}
const monthOf = (iso) => ymd(iso).slice(0, 7);
function buildTreasury(orders, disputes, now = Date.now()) {
  const cur = ymd(now).slice(0, 7), d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); const prev = d.toISOString().slice(0, 7);
  const m = (k) => ({ month: k, orders: 0, ttc_cents: 0, tax_cents: 0, ht_cents: 0, refunded_cents: 0 });
  const A = m(cur), B = m(prev); let recent = 0, refundedOpen = 0;
  for (const o of orders || []) {
    if (!paidOrder(o)) continue;
    const k = monthOf(o.created_at), t = k === cur ? A : k === prev ? B : null;
    if (t) { const v = netTtc(o), tx = taxNet(o); t.orders++; t.ttc_cents += v; t.tax_cents += tx; t.ht_cents += v - tx; t.refunded_cents += o.refunded_cents || 0; }
    if (Date.parse(o.created_at) >= now - 7 * 864e5) recent += netTtc(o);
    if (['pending', 'generating'].includes(o.status)) refundedOpen++;
  }
  return { current: A, previous: B, recent7_ttc_cents: recent, ordersInProgress: refundedOpen, disputes: disputes || 0, estimate: true };
}
// Alertes rappel : états des surveillances demandées par les clients (aucune donnée personnelle ici, seulement des compteurs).
function buildRecallStats(rows, now = Date.now(), cfg = {}) {
  const days = Math.max(1, cfg.intervalDays || 7), act = rows.filter((r) => r.active), since = now - 30 * 864e5, why = {};
  for (const r of rows) if (!r.active) why[r.stopped_reason || 'autre'] = (why[r.stopped_reason || 'autre'] || 0) + 1;
  return {
    enabled: !!cfg.enabled, intervalDays: days, active: act.length, stopped: rows.length - act.length, stoppedBy: why,
    alertsSent: rows.reduce((a, r) => a + (r.alerts_sent || 0), 0), alerted30d: rows.filter((r) => r.last_alert_at && Date.parse(r.last_alert_at) >= since).length,
    awaitingFirstCheck: act.filter((r) => r.known_refs == null).length,
    dueNow: act.filter((r) => !r.last_checked_at || Date.parse(r.last_checked_at) < now - days * 864e5).length,
    checksPerMonth: Math.round(act.length * 30 / days),
  };
}
function buildTech(orders, reports, days, now = Date.now()) {
  const byDay = new Map(), key = (t) => ymd(t);
  for (let i = days - 1; i >= 0; i--) byDay.set(key(now - i * 864e5), { date: key(now - i * 864e5), orders: 0, failed: 0, _ms: 0, _n: 0 });
  const rep = new Map((reports || []).map((r) => [r.order_id, r]));
  const all = []; let failed = 0, total = 0;
  for (const o of orders || []) {
    if (o.kind === 'pack') continue; const d = byDay.get(key(o.created_at)); total++; if (d) d.orders++;
    if (o.status === 'refunded') { failed++; if (d) d.failed++; }
    const r = rep.get(o.id); if (r && Number.isFinite(r.generation_ms) && r.generation_ms >= 0 && r.generation_ms < 6 * 3600e3) { all.push(r.generation_ms); if (d) { d._ms += r.generation_ms; d._n++; } }
  }
  all.sort((a, b) => a - b); const q = (p) => (all.length ? Math.round(all[Math.min(all.length - 1, Math.floor(p * all.length))] / 1000) : null);
  return { days, series: Array.from(byDay.values()).map((d) => ({ date: d.date, orders: d.orders, failed: d.failed, avgSeconds: d._n ? Math.round(d._ms / d._n / 1000) : null })), avgSeconds: all.length ? Math.round(all.reduce((a, x) => a + x, 0) / all.length / 1000) : null, p95Seconds: q(0.95), failureRate: total ? failed / total : 0, reports: all.length };
}
function validGoal(b) { const v = Number(b && b.ht_cents); return Number.isInteger(v) && v >= 0 && v <= 1e9 ? { ht_cents: v } : null; }
function buildGoal(goal, orders, now = Date.now()) {
  const cur = ymd(now).slice(0, 7), [y, mo] = cur.split('-').map(Number), dim = new Date(Date.UTC(y, mo, 0)).getUTCDate(), day = Number(ymd(now).slice(8, 10));
  let done = 0; for (const o of orders || []) if (paidOrder(o) && monthOf(o.created_at) === cur) done += netTtc(o) - taxNet(o);
  const target = goal && goal.ht_cents ? goal.ht_cents : 0;
  return { month: cur, target_ht_cents: target, done_ht_cents: done, pct: target ? done / target : null, day, daysInMonth: dim, projected_ht_cents: day ? Math.round(done / day * dim) : 0, onTrack: target ? Math.round(done / day * dim) >= target : null };
}
const csvCell = (v) => { const t = String(v == null ? '' : v); return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : /^[=+\-@]/.test(t) ? "'" + t : t; };
const eu2 = (c) => (c / 100).toFixed(2).replace('.', ',');
function buildRecap(month, orders, expenses, abandoned, costs) {
  const [y, mo] = month.split('-').map(Number), last = new Date(Date.UTC(y, mo, 0)).getUTCDate(), range = { from: month + '-01', to: month + '-' + String(last).padStart(2, '0') };
  const inM = (orders || []).filter((o) => monthOf(o.created_at) === month), real = buildRealMargin(inM, expenses, costs, 31, Date.now(), range), st = periodStats(inM);
  const un = buildUnsold(inM, (abandoned || []).filter((a) => monthOf(a.created_at) === month), 31);
  return { month, revenue: st, real, offers: un.offers, abandonedTotal: un.abandonedTotal, refunded_cents: inM.reduce((a, o) => a + (o.refunded_cents || 0), 0) };
}
function recapRows(r) {
  const rows = [['Récapitulatif mensuel', r.month], ['Rubrique', 'Montant (€) ou nombre'], ['Commandes payées', r.revenue.orders], ['Chiffre d’affaires net TTC', eu2(r.revenue.net_ttc_cents)], ['TVA nette collectée', eu2(r.real.tax_cents)], ['Chiffre d’affaires net HT', eu2(r.real.revenue_ht_cents)],
    ['Remboursements (TTC)', eu2(r.refunded_cents)], ['Frais Stripe (réels + estimés)', eu2(r.real.stripe_fees_cents)], ['dont réels', eu2(r.real.stripe_fees_actual_cents)], ['Charges saisies (HT)', eu2(r.real.expenses_cents)]];
  for (const [k, v] of Object.entries(r.real.by_category)) rows.push(['  charges : ' + (EXP_CATS[k] || k), eu2(v)]);
  rows.push(['Marge réelle', eu2(r.real.margin_cents)], ['Taux de marge', r.real.marginRate == null ? '' : (r.real.marginRate * 100).toFixed(1).replace('.', ',') + ' %'], ['Frais Stripe complets', r.real.complete ? 'oui' : 'non (en partie estimés)'], ['', ''], ['Offre', 'Ventes', 'Abandons', 'Remboursées']);
  for (const o of r.offers) rows.push([o.label, o.sold, o.abandoned, o.refunded]);
  rows.push(['', ''], ['Document de pilotage interne : ne remplace pas la comptabilité.', '']);
  return rows;
}
async function recapPdf(r) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib'), pdf = await PDFDocument.create(), page = pdf.addPage([595, 842]), f = await pdf.embedFont(StandardFonts.Helvetica), b = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = (t) => String(t).replace(/[^\x20-\x7EÀ-ÿ€’–]/g, '').replace(/’/g, "'").replace(/–/g, '-'); let y = 790;
  page.drawText(clean('Recapitulatif mensuel ' + r.month), { x: 50, y, size: 18, font: b, color: rgb(0.1, 0.1, 0.12) }); y -= 34;
  for (const row of recapRows(r).slice(2)) { if (!row[0] && !row[1]) { y -= 8; continue; } const bold = /^(Marge réelle|Offre)$/.test(row[0]); page.drawText(clean(row[0]), { x: 50, y, size: 10.5, font: bold ? b : f }); row.slice(1).forEach((c, i) => page.drawText(clean(c), { x: 340 + i * 80, y, size: 10.5, font: bold ? b : f })); y -= 17; if (y < 60) break; }
  return Buffer.from(await pdf.save());
}

function buildCharts(orders, days, now = Date.now()) {
  const byDay = new Map(); const dayKey = (t) => ymd(new Date(t));
  for (let i = days - 1; i >= 0; i--) byDay.set(dayKey(now - i * 864e5), { date: dayKey(now - i * 864e5), net_ttc_cents: 0, net_ht_cents: 0, orders: 0 });
  const plans = { essentiel: 0, premium: 0 }, kinds = { report: 0, pack: 0, credit_use: 0 };
  let paid = 0, refunded = 0, net = 0, netHt = 0;
  for (const o of orders) {
    if (o.kind in kinds) kinds[o.kind]++;
    if (o.kind === 'report' && o.plan in plans) plans[o.plan]++;
    if (o.kind === 'credit_use' && o.plan in plans) plans[o.plan]++;
    if (o.kind === 'credit_use') continue;
    const d = byDay.get(ymd(o.created_at)); const n = (o.amount_ttc_cents || 0) - (o.refunded_cents || 0);
    const tax = o.amount_tax_cents || 0, rtax = o.refunded_tax_cents != null ? o.refunded_tax_cents : (o.amount_ttc_cents ? Math.round(tax * (o.refunded_cents || 0) / o.amount_ttc_cents) : 0), ht = n - (tax - rtax);
    if (d) { d.net_ttc_cents += n; d.net_ht_cents += ht; d.orders++; }
    paid++; net += n; netHt += ht; if (o.refunded_cents) refunded++;
  }
  return { days, series: Array.from(byDay.values()), plans, kinds, paidOrders: paid, refundedOrders: refunded, refundRate: paid ? refunded / paid : 0, net_ttc_cents: net, net_ht_cents: netHt };
}
function buildQuality(orders, reports) {
  const bySource = new Map(), byBrand = new Map(), repByOrder = new Map(reports.map((r) => [r.order_id, r]));
  for (const r of reports) { const s = bySource.get(r.data_source) || { source: r.data_source, reports: 0, optionsSum: 0 }; s.reports++; s.optionsSum += r.options_count || 0; bySource.set(r.data_source, s); }
  for (const o of orders) {
    if (o.kind === 'pack' || !o.vin) continue;
    const brand = lib.brandFromVin(o.vin) || 'Autre / inconnue', b = byBrand.get(brand) || { brand, orders: 0, ok: 0, failed: 0, optionsSum: 0, withReport: 0 };
    b.orders++;
    if (o.status === 'refunded') b.failed++; else if (['delivered', 'ready'].includes(o.status)) b.ok++;
    const rep = repByOrder.get(o.id); if (rep) { b.optionsSum += rep.options_count || 0; b.withReport++; }
    byBrand.set(brand, b);
  }
  return {
    brands: Array.from(byBrand.values()).map((b) => ({ brand: b.brand, orders: b.orders, ok: b.ok, failed: b.failed, failureRate: b.orders ? b.failed / b.orders : 0, avgOptions: b.withReport ? Math.round(b.optionsSum / b.withReport) : null })).sort((a, b) => b.orders - a.orders),
    sources: Array.from(bySource.values()).map((s) => ({ source: s.source, reports: s.reports, avgOptions: s.reports ? Math.round(s.optionsSum / s.reports) : 0 })).sort((a, b) => b.reports - a.reports),
  };
}
const COSTS_DEFAULT = { essentiel_cents: 0, premium_cents: 0, stripe_pct: 1.5, stripe_fixed_cents: 25 };
function validCosts(b) {
  const o = b && typeof b === 'object' ? b : {}, n = (v) => Number(v), out = {
    essentiel_cents: n(o.essentiel_cents), premium_cents: n(o.premium_cents), stripe_pct: n(o.stripe_pct), stripe_fixed_cents: n(o.stripe_fixed_cents) };
  for (const k of ['essentiel_cents', 'premium_cents', 'stripe_fixed_cents']) if (!Number.isInteger(out[k]) || out[k] < 0 || out[k] > 100000) return null;
  if (!(out.stripe_pct >= 0 && out.stripe_pct <= 10)) return null;
  out.stripe_pct = Math.round(out.stripe_pct * 100) / 100; return out;
}
function buildMargin(orders, reports, costs) {
  const c = { ...COSTS_DEFAULT, ...(costs || {}) }; let ttc = 0, tax = 0, paid = 0;
  for (const o of orders) {
    if (o.kind === 'credit_use') continue;
    ttc += (o.amount_ttc_cents || 0) - (o.refunded_cents || 0); tax += (o.amount_tax_cents || 0) - (o.refunded_tax_cents || 0); paid++;
  }
  const n = { essentiel: 0, premium: 0 }; for (const r of reports) if (r.plan in n) n[r.plan]++;
  const dataCost = n.essentiel * c.essentiel_cents + n.premium * c.premium_cents, fees = Math.round(orders.filter((o) => o.kind !== 'credit_use').reduce((s, o) => s + (o.amount_ttc_cents || 0), 0) * c.stripe_pct / 100) + paid * c.stripe_fixed_cents;
  const ht = ttc - tax;
  return { revenue_ht_cents: ht, tax_cents: tax, data_cost_cents: dataCost, fees_cents: fees, margin_cents: ht - dataCost - fees, reports: n, paidOrders: paid, marginRate: ht > 0 ? (ht - dataCost - fees) / ht : null, costs: c, estimate: true };
}


/* ---------- résumé quotidien des points à traiter ---------- */
async function collectDigest(supabase, now = Date.now()) {
  const ago = (ms) => new Date(now - ms).toISOString(), cnt = async (q) => { const { count } = await q; return count || 0; };
  const [stuck, failedMail, acct, tickets, rerr, disputes, incomplete] = await Promise.all([
    cnt(supabase.from('orders').select('id', { count: 'exact', head: true }).in('status', ['pending', 'generating']).lt('updated_at', ago(15 * 60e3))),
    cnt(supabase.from('email_log').select('dedupe_key', { count: 'exact', head: true }).eq('status', 'failed').gt('created_at', ago(3 * 864e5))),
    cnt(supabase.from('invoices').select('id', { count: 'exact', head: true }).in('accounting_status', ['needs_review', 'error'])),
    cnt(supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open').lt('created_at', ago(24 * 3600e3))),
    cnt(supabase.from('report_errors').select('id', { count: 'exact', head: true }).eq('status', 'open')),
    cnt(supabase.from('orders').select('id', { count: 'exact', head: true }).in('dispute_status', ['needs_response', 'warning_needs_response', 'under_review'])),
    cnt(supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('details_complete', false)),
  ]);
  const s = (n, one, many) => `${n} ${n > 1 ? many : one}`, items = [];
  if (stuck) items.push(`${s(stuck, 'commande bloquée', 'commandes bloquées')} depuis plus de 15 minutes`);
  if (disputes) items.push(`${s(disputes, 'litige de paiement', 'litiges de paiement')} à traiter (délai de réponse strict chez Stripe)`);
  if (tickets) items.push(`${s(tickets, 'message de support', 'messages de support')} sans réponse depuis plus de 24 h`);
  if (rerr) items.push(`${s(rerr, 'erreur de rapport signalée', 'erreurs de rapport signalées')} par des clients`);
  if (acct) items.push(`${s(acct, 'facture à vérifier', 'factures à vérifier')} pour la comptabilité (TVA à valider ou envoi en erreur)`);
  if (incomplete) items.push(`${s(incomplete, 'facture professionnelle incomplète', 'factures professionnelles incomplètes')}`);
  if (failedMail) items.push(`${s(failedMail, 'e-mail de service en échec', 'e-mails de service en échec')} ces 3 derniers jours`);
  return items;
}
/** Un seul résumé par jour, à partir de 8 h (heure de Paris), uniquement s'il y a quelque chose à traiter. */
async function sendDigest({ supabase, mailer, env = process.env, now = Date.now() }) {
  if (env.ADMIN_DIGEST === '0' || !env.ADMIN_EMAIL) return 'disabled';
  const hour = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date(now)) % 24;
  if (hour < 8) return 'too_early';
  const items = await collectDigest(supabase, now); if (!items.length) return 'nothing';
  const day = ymd(now);
  return mailer.send({ key: 'admin_digest:' + day, kind: 'admin_digest', to: env.ADMIN_EMAIL.split(',').map((x) => x.trim()).filter(Boolean), tpl: mailer.T.adminDigest({ items, date: day }) });
}

module.exports = function mountPlus(r, ctx) {
  const { supabase, stripe, mailer, settings, audit, json, json2, nowIso, env = process.env } = ctx;
  const T = mailer.T;
  const norm = (s) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim();
  const getSetting = async (key) => { const { data } = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle(); return data ? data.value : null; };
  const putSetting = async (key, value) => { const { error } = await supabase.from('app_settings').upsert({ key, value, updated_at: nowIso() }, { onConflict: 'key' }); if (error) throw error; };
  const since = (days) => new Date(Date.now() - days * 864e5).toISOString();

  // Graphiques
  r.get('/api/admin/charts', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days);
      const { data, error } = await supabase.from('orders').select('kind,plan,status,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,created_at').gte('created_at', since(days)).limit(20000);
      if (error) throw error; res.json(buildCharts(data || [], days));
    } catch (e) { next(e); }
  });
  // Qualité des rapports par marque et par fournisseur
  r.get('/api/admin/quality', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days, 90);
      const [o, rp] = await Promise.all([
        supabase.from('orders').select('id,kind,vin,status,created_at').gte('created_at', since(days)).limit(20000),
        supabase.from('reports').select('order_id,options_count,data_source,created_at').gte('created_at', since(days)).limit(20000)]);
      if (o.error) throw o.error; res.json({ days, ...buildQuality(o.data || [], (rp.data || [])) });
    } catch (e) { next(e); }
  });
  // Coûts fournisseurs et marge (estimation)
  r.get('/api/admin/costs', async (req, res, next) => { try { res.json({ costs: { ...COSTS_DEFAULT, ...((await getSetting('costs')) || {}) } }); } catch (e) { next(e); } });
  r.put('/api/admin/costs', json, async (req, res, next) => {
    try { const v = validCosts(req.body); if (!v) return res.status(400).json({ error: 'COSTS_INVALID' }); await putSetting('costs', v); audit(req, 'costs_update', 'costs', v); res.json({ costs: v }); } catch (e) { next(e); }
  });
  // Comparaison avec la période précédente
  r.get('/api/admin/compare', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days), cols = 'kind,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,created_at';
      const [c, p] = await Promise.all([supabase.from('orders').select(cols).gte('created_at', since(days)).limit(20000), supabase.from('orders').select(cols).gte('created_at', since(days * 2)).lt('created_at', since(days)).limit(20000)]);
      if (c.error) throw c.error; res.json(buildCompare(c.data || [], p.data || [], days));
    } catch (e) { next(e); }
  });
  // Entonnoir de conversion et marques recherchées (compteurs anonymes : aucune donnée personnelle)
  const funnelRows = async (days) => { const { data, error } = await supabase.from('funnel_daily').select('day,step,brand,n').gte('day', ymd(Date.now() - (days - 1) * 864e5)).limit(20000); return error ? [] : data || []; };
  r.get('/api/admin/funnel', async (req, res, next) => {
    try { const days = clampDays(req.query.days), [rows, o] = await Promise.all([funnelRows(days), supabase.from('orders').select('kind,amount_ttc_cents').gte('created_at', since(days)).limit(20000)]); if (o.error) throw o.error; res.json(buildFunnel(rows, o.data || [], days)); } catch (e) { next(e); }
  });
  r.get('/api/admin/brands', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days);
      const [rows, o, rp] = await Promise.all([funnelRows(days), supabase.from('orders').select('id,kind,vin,amount_ttc_cents').gte('created_at', since(days)).limit(20000), supabase.from('reports').select('order_id,options_count').gte('created_at', since(days)).limit(20000)]);
      if (o.error) throw o.error; res.json({ days, ...buildBrands(rows, o.data || [], rp.data || []) });
    } catch (e) { next(e); }
  });
  // Clients Pro : crédits qui dorment, bientôt épuisés, jamais utilisés
  r.get('/api/admin/pro-credits', async (req, res, next) => {
    try {
      const [u, o] = await Promise.all([supabase.from('users').select('id,email,role,credits_balance,company_name').eq('role', 'pro').limit(2000), supabase.from('orders').select('user_id,kind,created_at').in('kind', ['pack', 'credit_use']).gte('created_at', since(400)).limit(20000)]);
      if (u.error) throw u.error; res.json(buildProCredits(u.data || [], o.data || [], Date.now(), parseInt(env.LOW_CREDITS_THRESHOLD, 10) || 2));
    } catch (e) { next(e); }
  });
  // TVA collectée et encaissements (estimation, ne remplace pas la comptabilité)
  r.get('/api/admin/treasury', async (req, res, next) => {
    try {
      const [o, d] = await Promise.all([supabase.from('orders').select('kind,status,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,created_at').gte('created_at', since(70)).limit(20000),
        supabase.from('orders').select('id', { count: 'exact', head: true }).in('dispute_status', ['needs_response', 'warning_needs_response', 'under_review'])]);
      if (o.error) throw o.error; res.json(buildTreasury(o.data || [], d.count || 0));
    } catch (e) { next(e); }
  });
  // Alertes rappel : compteurs de surveillance (fonction activée par RECALL_ALERTS=1 et RECALL_ORDER)
  r.get('/api/admin/recall-alerts', async (req, res, next) => {
    try {
      const { data, error } = await supabase.from('recall_watches').select('active,known_refs,last_checked_at,last_alert_at,alerts_sent,stopped_reason').limit(20000);
      if (error) throw error;
      res.json(buildRecallStats(data || [], Date.now(), { enabled: env.RECALL_ALERTS === '1' && !!env.RECALL_ORDER, intervalDays: parseInt(env.RECALL_INTERVAL_DAYS, 10) || 7 }));
    } catch (e) { next(e); }
  });
  // Santé technique : durée de génération et échecs par jour
  r.get('/api/admin/tech', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days);
      const [o, rp] = await Promise.all([supabase.from('orders').select('id,kind,status,created_at').gte('created_at', since(days)).limit(20000), supabase.from('reports').select('order_id,generation_ms').gte('created_at', since(days)).limit(20000)]);
      if (o.error) throw o.error; res.json(buildTech(o.data || [], rp.data || [], days));
    } catch (e) { next(e); }
  });
  // Objectif mensuel de chiffre d'affaires HT
  r.get('/api/admin/goal', async (req, res, next) => {
    try { const g = await getSetting('goal'), o = await supabase.from('orders').select('kind,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,created_at').gte('created_at', since(35)).limit(20000); if (o.error) throw o.error; res.json(buildGoal(g, o.data || [])); } catch (e) { next(e); }
  });
  r.put('/api/admin/goal', json, async (req, res, next) => {
    try { const v = validGoal(req.body); if (!v) return res.status(400).json({ error: 'GOAL_INVALID' }); await putSetting('goal', v); audit(req, 'goal_update', 'objectif', v); res.json({ ok: true, goal: v }); } catch (e) { next(e); }
  });
  // Récapitulatif mensuel (CSV ou PDF) : montants agrégés, aucune donnée personnelle
  r.get('/api/admin/recap', async (req, res, next) => {
    try {
      const month = String(req.query.month || ''); if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'MONTH_INVALID' });
      const from = new Date(month + '-01T00:00:00Z'); from.setUTCDate(from.getUTCDate() - 1); const to = new Date(month + '-01T00:00:00Z'); to.setUTCMonth(to.getUTCMonth() + 1); to.setUTCDate(to.getUTCDate() + 1);
      const [o, a] = await Promise.all([supabase.from('orders').select('kind,plan,credits_delta,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,stripe_fee_cents,created_at').gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).limit(20000),
        supabase.from('abandoned_checkouts').select('kind,plan,pack_size,created_at').gte('created_at', from.toISOString()).lt('created_at', to.toISOString()).limit(20000)]);
      if (o.error) throw o.error;
      const rec = buildRecap(month, o.data || [], (await getSetting('expenses')) || [], a.error ? [] : a.data || [], await getSetting('costs'));
      audit(req, 'recap_export', month, { format: req.query.format === 'pdf' ? 'pdf' : 'csv' });
      if (req.query.format === 'pdf') return res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="recapitulatif-${month}.pdf"` }).send(await recapPdf(rec));
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="recapitulatif-${month}.csv"` }).send('﻿' + recapRows(rec).map((x) => x.map(csvCell).join(';')).join('\r\n'));
    } catch (e) { next(e); }
  });
  r.get('/api/admin/unsold', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days);
      const [o, a] = await Promise.all([
        supabase.from('orders').select('kind,plan,credits_delta,refunded_cents,amount_ttc_cents').gte('created_at', since(days)).limit(20000),
        supabase.from('abandoned_checkouts').select('kind,plan,pack_size,created_at').gte('created_at', since(days)).limit(20000)]);
      if (o.error) throw o.error;
      res.json(buildUnsold(o.data || [], a.error ? [] : a.data || [], days));
    } catch (e) { next(e); }
  });
  r.get('/api/admin/margin', async (req, res, next) => {
    try {
      const days = clampDays(req.query.days);
      const [o, rp] = await Promise.all([
        supabase.from('orders').select('kind,amount_ttc_cents,amount_tax_cents,refunded_cents,refunded_tax_cents,stripe_fee_cents').gte('created_at', since(days)).limit(20000),
        supabase.from('reports').select('plan').gte('created_at', since(days)).limit(20000)]);
      if (o.error) throw o.error;
      const costs = await getSetting('costs'), exp = (await getSetting('expenses')) || [];
      res.json({ days, ...buildMargin(o.data || [], rp.data || [], costs), real: buildRealMargin(o.data || [], exp, costs, days) });
    } catch (e) { next(e); }
  });
  // Charges réelles saisies (marge réelle) : stockées dans app_settings, montants HT
  r.get('/api/admin/expenses', async (req, res, next) => { try { res.json({ items: ((await getSetting('expenses')) || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)), categories: EXP_CATS }); } catch (e) { next(e); } });
  r.post('/api/admin/expenses', json, async (req, res, next) => {
    try {
      const v = validExpense(req.body); if (!v) return res.status(400).json({ error: 'EXPENSE_INVALID' });
      const list = (await getSetting('expenses')) || []; if (list.length >= 1000) return res.status(409).json({ error: 'EXPENSE_LIMIT' });
      const e = { id: crypto.randomUUID(), ...v, by: (req.admin && (req.admin.user ? req.admin.user.email : req.admin.actor)) || null, at: nowIso() };
      await putSetting('expenses', list.concat(e)); audit(req, 'expense_add', v.label, { amount: v.amount_ht_cents, category: v.category }); res.status(201).json({ item: e });
    } catch (e) { next(e); }
  });
  r.delete('/api/admin/expenses/:id', async (req, res, next) => {
    try {
      const list = (await getSetting('expenses')) || [], e = list.find((x) => x.id === req.params.id); if (!e) return res.status(404).json({ error: 'Introuvable.' });
      await putSetting('expenses', list.filter((x) => x.id !== e.id)); audit(req, 'expense_delete', e.label, { amount: e.amount_ht_cents }); res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Recherche globale (e-mail, VIN, numéro de facture ou d'avoir, identifiant de commande)
  r.get('/api/admin/search', async (req, res, next) => {
    try {
      const q = norm(req.query.q).slice(0, 80), out = { users: [], orders: [], invoices: [], creditNotes: [], tickets: [] };
      if (q.length < 3) return res.status(400).json({ error: 'QUERY_TOO_SHORT' });
      const email = q.toLowerCase(), up = q.toUpperCase();
      if (/^[^\s@]+@[^\s@]+$/.test(email)) {
        const [u, o, t] = await Promise.all([
          supabase.from('users').select('id,email,role,company_name,credits_balance').eq('email', email).limit(5),
          supabase.from('orders').select('id,kind,vin,plan,status,buyer_email,amount_ttc_cents,created_at').eq('buyer_email', email).order('created_at', { ascending: false }).limit(20),
          supabase.from('support_tickets').select('id,subject,status,email,created_at').eq('email', email).order('created_at', { ascending: false }).limit(10)]);
        out.users = u.data || []; out.orders = o.data || []; out.tickets = t.data || [];
      }
      if (VIN.test(up)) { const { data } = await supabase.from('orders').select('id,kind,vin,plan,status,buyer_email,amount_ttc_cents,created_at').eq('vin', up).order('created_at', { ascending: false }).limit(20); out.orders = out.orders.concat(data || []); }
      if (/^EV-\d{4}-\d{6}$/.test(up)) { const { data } = await supabase.from('invoices').select('id,order_id,number,buyer_email,amount_ttc_cents,issued_at').eq('number', up).limit(1); out.invoices = data || []; }
      if (/^AV-\d{4}-\d{6}$/.test(up)) { const { data } = await supabase.from('credit_notes').select('id,order_id,number,amount_ttc_cents,issued_at').eq('number', up).limit(1); out.creditNotes = data || []; }
      if (UUID.test(q)) { const { data } = await supabase.from('orders').select('id,kind,vin,plan,status,buyer_email,amount_ttc_cents,created_at').eq('id', q.toLowerCase()).limit(1); out.orders = out.orders.concat(data || []); }
      res.json({ q, ...out });
    } catch (e) { next(e); }
  });

  // Codes promo : gérés dans Stripe (limites, expiration et décompte des utilisations restent côté Stripe)
  const needStripe = (res) => { if (!stripe || !stripe.promotionCodes || !stripe.coupons) { res.status(503).json({ error: 'STRIPE_UNAVAILABLE' }); return false; } return true; };
  const promoView = (p) => ({ id: p.id, code: p.code, active: !!p.active, percentOff: p.coupon && p.coupon.percent_off != null ? p.coupon.percent_off : null, amountOffCents: p.coupon && p.coupon.amount_off != null ? p.coupon.amount_off : null,
    maxRedemptions: p.max_redemptions || null, timesRedeemed: p.times_redeemed || 0, expiresAt: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : null, createdAt: p.created ? new Date(p.created * 1000).toISOString() : null });
  r.get('/api/admin/promos', async (req, res, next) => {
    try { if (!needStripe(res)) return; const l = await stripe.promotionCodes.list({ limit: 100, expand: ['data.coupon'] }); res.json({ items: (l.data || []).map(promoView), enabled: env.ALLOW_PROMO_CODES !== '0' }); } catch (e) { next(e); }
  });
  r.post('/api/admin/promos', json, async (req, res, next) => {
    try {
      if (!needStripe(res)) return; const b = req.body || {}, code = norm(b.code).toUpperCase();
      if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return res.status(400).json({ error: 'PROMO_CODE_INVALID' });
      const pct = b.percentOff != null && b.percentOff !== '' ? Number(b.percentOff) : null, amt = b.amountOffCents != null && b.amountOffCents !== '' ? Number(b.amountOffCents) : null;
      if ((pct == null) === (amt == null)) return res.status(400).json({ error: 'PROMO_VALUE_INVALID' });
      if (pct != null && !(Number.isInteger(pct) && pct >= 1 && pct <= 100)) return res.status(400).json({ error: 'PROMO_VALUE_INVALID' });
      if (amt != null && !(Number.isInteger(amt) && amt >= 1 && amt <= 50000)) return res.status(400).json({ error: 'PROMO_VALUE_INVALID' });
      const max = b.maxRedemptions != null && b.maxRedemptions !== '' ? Number(b.maxRedemptions) : null; if (max != null && !(Number.isInteger(max) && max >= 1 && max <= 100000)) return res.status(400).json({ error: 'PROMO_MAX_INVALID' });
      let exp = null; if (b.expiresAt) { exp = Math.floor(Date.parse(b.expiresAt + (String(b.expiresAt).length === 10 ? 'T23:59:59Z' : '')) / 1000); if (!(exp > Date.now() / 1000)) return res.status(400).json({ error: 'PROMO_EXPIRY_INVALID' }); }
      const existing = await stripe.promotionCodes.list({ code, limit: 1 }); if ((existing.data || []).length) return res.status(409).json({ error: 'PROMO_EXISTS' });
      const coupon = await stripe.coupons.create({ ...(pct != null ? { percent_off: pct } : { amount_off: amt, currency: 'eur' }), duration: 'once', name: code });
      const pc = await stripe.promotionCodes.create({ coupon: coupon.id, code, active: true, ...(max ? { max_redemptions: max } : {}), ...(exp ? { expires_at: exp } : {}) });
      audit(req, 'promo_create', code, { pct, amt, max, exp }); res.status(201).json({ item: promoView({ ...pc, coupon }) });
    } catch (e) { next(e); }
  });
  r.post('/api/admin/promos/:id/active', json, async (req, res, next) => {
    try {
      if (!needStripe(res)) return; if (!/^promo_[A-Za-z0-9_]{3,60}$/.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const active = !!(req.body && req.body.active); const p = await stripe.promotionCodes.update(req.params.id, { active });
      audit(req, active ? 'promo_on' : 'promo_off', req.params.id, {}); res.json({ ok: true, active: !!p.active });
    } catch (e) { next(e); }
  });

  // Libellés d'options : import en lot (une ligne par libellé : MARQUE;CODE;traduction)
  r.put('/api/admin/labels/bulk', json2, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : null; if (!items || !items.length || items.length > 300) return res.status(400).json({ error: 'BULK_INVALID' });
      const ok = [], rejected = [];
      items.forEach((x, i) => {
        const brand = norm(x && x.brand).toUpperCase().slice(0, 60), code = norm(x && x.code).slice(0, 60), label = norm(x && x.labelFr);
        if (!brand || !code || label.length < 2 || label.length > 200) rejected.push({ line: i + 1, error: 'LABEL_INVALID' }); else ok.push({ brand, code, label_fr: label, updated_at: nowIso() });
      });
      if (ok.length) {
        const { error } = await supabase.from('option_labels').upsert(ok, { onConflict: 'brand,code' }); if (error) throw error;
        for (const x of ok) await supabase.from('untranslated_labels').delete().eq('brand', x.brand).eq('code', x.code);
      }
      audit(req, 'labels_bulk', String(ok.length), { rejected: rejected.length }); res.json({ saved: ok.length, rejected });
    } catch (e) { next(e); }
  });

  // Notes privées sur un client
  r.get('/api/admin/users/:id/note', async (req, res, next) => {
    try { if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' }); const { data } = await supabase.from('admin_notes').select('note,author,updated_at').eq('user_id', req.params.id).maybeSingle(); res.json({ note: data ? data.note : '', author: data ? data.author : null, updatedAt: data ? data.updated_at : null }); } catch (e) { next(e); }
  });
  r.put('/api/admin/users/:id/note', json, async (req, res, next) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'ID_INVALID' });
      const note = String((req.body && req.body.note) || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, 2000);
      if (!note) await supabase.from('admin_notes').delete().eq('user_id', req.params.id);
      else { const { error } = await supabase.from('admin_notes').upsert({ user_id: req.params.id, note, author: req.actor, updated_at: nowIso() }, { onConflict: 'user_id' }); if (error) throw error; }
      audit(req, 'client_note', req.params.id, { length: note.length }); res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Textes des e-mails de service : objet et paragraphe d'introduction (jamais de HTML, aucun contenu promotionnel)
  r.get('/api/admin/email-templates', (req, res) => {
    const ov = settings.emailOv || {};
    res.json({ items: Object.entries(M.TEMPLATE_INFO).map(([key, label]) => ({ key, label, override: ov[key] || null, subject: mailer.base[key](M.SAMPLES[key] || {}).subject })), internal: M.INTERNAL_INFO });
  });
  r.post('/api/admin/email-templates/:key/preview', json, (req, res) => {
    const key = req.params.key; if (!M.TEMPLATE_INFO[key]) return res.status(404).json({ error: 'Introuvable.' });
    const o = M.cleanOv({ [key]: req.body || {} })[key] || null, t = mailer.render(key, [M.SAMPLES[key] || {}], o);
    res.json({ subject: t.subject, html: t.html });
  });
  r.put('/api/admin/email-templates/:key', json, async (req, res, next) => {
    try {
      const key = req.params.key; if (!M.TEMPLATE_INFO[key]) return res.status(404).json({ error: 'Introuvable.' });
      const clean = M.cleanOv({ [key]: req.body || {} }), next_ = { ...(settings.emailOv || {}) };
      if (clean[key]) next_[key] = clean[key]; else delete next_[key];
      await putSetting('email_ov', next_); settings.emailOv = next_;
      audit(req, 'email_template', key, { subject: !!(clean[key] && clean[key].subject), intro: !!(clean[key] && clean[key].intro) }); res.json({ ok: true, override: clean[key] || null });
    } catch (e) { next(e); }
  });

  // Brouillon, aperçu et publication planifiée du contenu du site
  const draftView = async () => { const d = await getSetting('site_draft'); return d ? { config: d.config, publishAt: d.publishAt || null, savedAt: d.savedAt, pricesConfirmed: !!d.pricesConfirmed } : null; };
  r.get('/api/admin/site/draft', async (req, res, next) => { try { res.json({ draft: await draftView() }); } catch (e) { next(e); } });
  r.put('/api/admin/site/draft', json2, async (req, res, next) => {
    try {
      const v = SC.validate(req.body && req.body.config); if (!v.ok) return res.status(400).json({ error: v.error });
      let publishAt = null;
      if (req.body.publishAt) { const t = Date.parse(req.body.publishAt); if (!(t > Date.now() + 30e3) || t > Date.now() + 90 * 864e5) return res.status(400).json({ error: 'PUBLISH_AT_INVALID' }); publishAt = new Date(t).toISOString(); }
      const changed = JSON.stringify(SC.effectivePrices(settings.site)) !== JSON.stringify(SC.effectivePrices(v.value));
      if (changed && publishAt && req.body.confirmPrices !== true) return res.status(409).json({ error: 'PRICES_CONFIRM_REQUIRED' });
      await putSetting('site_draft', { config: v.value, publishAt, savedAt: nowIso(), pricesConfirmed: changed && !!publishAt });
      audit(req, 'site_draft', publishAt || 'brouillon', { publishAt }); res.json({ draft: await draftView() });
    } catch (e) { next(e); }
  });
  r.delete('/api/admin/site/draft', async (req, res, next) => { try { await supabase.from('app_settings').delete().eq('key', 'site_draft'); audit(req, 'site_draft_delete', 'brouillon', {}); res.json({ ok: true }); } catch (e) { next(e); } });
  r.post('/api/admin/site/draft/publish', json, async (req, res, next) => {
    try {
      const d = await getSetting('site_draft'); if (!d) return res.status(404).json({ error: 'NO_DRAFT' });
      const v = SC.validate(d.config); if (!v.ok) return res.status(400).json({ error: v.error });
      const changed = JSON.stringify(SC.effectivePrices(settings.site)) !== JSON.stringify(SC.effectivePrices(v.value));
      if (changed && !(req.body && req.body.confirmPrices === true)) return res.status(409).json({ error: 'PRICES_CONFIRM_REQUIRED' });
      await settings.saveSite(v.value); await supabase.from('app_settings').delete().eq('key', 'site_draft');
      audit(req, 'site_publish_draft', 'site', { prices: changed }); res.json({ ok: true });
    } catch (e) { next(e); }
  });
  r.get('/api/admin/site/preview-link', async (req, res, next) => {
    try { const d = await getSetting('site_draft'); if (!d) return res.status(404).json({ error: 'NO_DRAFT' }); res.json({ url: `${(env.APP_URL || '').replace(/\/$/, '')}/?preview=${signPreview(env)}`, minutes: 30 }); } catch (e) { next(e); }
  });
};
Object.assign(module.exports, { buildRecallStats, buildCompare, buildFunnel, buildBrands, buildProCredits, buildTreasury, buildTech, buildGoal, validGoal, buildRecap, recapRows, buildUnsold, OFFERS, buildRealMargin, validExpense, EXP_CATS, collectDigest, sendDigest, buildCharts, buildQuality, buildMargin, validCosts, signPreview, verifyPreview, COSTS_DEFAULT, ymd });
