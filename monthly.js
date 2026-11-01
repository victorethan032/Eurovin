'use strict';
/** Export comptable mensuel : synthèse TVA par pays + détail des pièces. Envoyé automatiquement le mois suivant (sans doublon) ou à la demande. */
const I = require('./invoicing');

module.exports = function createMonthly({ supabase, mailer, env = process.env }) {
  async function build(month) {
    const b = I.monthBounds(month); if (!b) return null;
    const { data: inv, error } = await supabase.from('invoices').select('*').gte('issued_at', b.start).lt('issued_at', b.end).order('issued_at', { ascending: true }).limit(50000);
    if (error) throw error;
    const { data: notes, error: e2 } = await supabase.from('credit_notes').select('*').gte('issued_at', b.start).lt('issued_at', b.end).order('issued_at', { ascending: true }).limit(50000);
    if (e2) throw e2;
    const ids = [...new Set((notes || []).map((n) => n.invoice_id).filter(Boolean))];
    const { data: orig } = ids.length ? await supabase.from('invoices').select('id,number').in('id', ids) : { data: [] };
    const num = new Map((orig || []).map((i) => [i.id, i.number]));
    const nn = (notes || []).map((n) => ({ ...n, invoice_number: num.get(n.invoice_id) }));
    const sum = I.vatByCountry(inv || [], nn, month);
    return { month, summaryCsv: sum.csv, detailCsv: I.accountingCsv(inv || [], nn), invoices: (inv || []).length, notes: nn.length, anomalies: I.anomalies(inv || []), total: sum.total };
  }
  const recipients = () => [env.ADMIN_EMAIL, ...String(env.ACCOUNTANT_EMAIL || '').split(',')].map((x) => (x || '').trim()).filter(Boolean);
  /** Envoie l'export d'un mois (une seule fois par mois, sauf force). */
  async function sendMonthly(month, { force = false } = {}) {
    const to = recipients(); if (!to.length) return 'no_recipient';
    const x = await build(month); if (!x) return 'bad_month';
    const att = [{ filename: `TVA-par-pays_${month}.csv`, content: Buffer.from(x.summaryCsv, 'utf8') }, { filename: `Detail-pieces_${month}.csv`, content: Buffer.from(x.detailCsv, 'utf8') }];
    return mailer.send({ key: force ? `monthly:${month}:${Date.now()}` : `monthly:${month}`, kind: 'monthly_export', to, tpl: mailer.T.monthlyExport({ month, invoices: x.invoices, notes: x.notes, anomalies: x.anomalies }), attachments: att, maxAttempts: 6 });
  }
  /** Appelé par le cron : à partir du 2 du mois (heure de Paris), envoie le mois écoulé. */
  async function sweepMonthly(now = new Date()) {
    if (I.parisDay(now) < 2) return 'too_early';
    return sendMonthly(I.previousMonth(now));
  }
  return { build, sendMonthly, sweepMonthly, recipients };
};
