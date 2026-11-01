'use strict';
/**
 * Synchronisation des factures vers Pennylane (le comptable y accède directement).
 * - Ne bloque JAMAIS une commande : toute erreur est enregistrée sur la facture puis réessayée (délai croissant).
 * - Sans PENNYLANE_API_TOKEN ou avec PENNYLANE_SYNC=0 : les factures restent « pending » et l'export CSV fonctionne.
 * - Noms de champs et codes de TVA issus de la documentation publique Pennylane API v2 : À VÉRIFIER en bac à sable avant la mise en production.
 */
const I = require('./invoicing');

const DEFAULT_VAT = { 20: 'FR_200', 10: 'FR_100', 5.5: 'FR_55', 2.1: 'FR_21' };
const MAX_ATTEMPTS = 8;
const eur = (c) => (c / 100).toFixed(2);

function vatMap(env) {
  let extra = {};
  try { if (env.PENNYLANE_VAT_MAP) extra = JSON.parse(env.PENNYLANE_VAT_MAP); } catch (e) { /* ignoré : la carte par défaut reste active */ }
  return { ...DEFAULT_VAT, ...extra };
}
/** Code TVA Pennylane d'une ligne, ou null si le cas demande une décision humaine (autoliquidation, franchise, OSS…). */
function vatCode(doc, rate, env) {
  const map = vatMap(env);
  const key = String(Number(rate));
  const country = (doc.buyer_country || 'FR');
  if (doc.vat_regime === 'standard' && country !== 'FR' && !map['OSS:' + country]) return null;   // TVA d'un autre pays : traitement comptable à valider
  if (doc.vat_regime !== 'standard' && !map[key]) return null;
  return map[key] || null;
}

module.exports = function createPennylane({ supabase, fetchFn, env = process.env, buildInvoicePdf, buildCreditNotePdf, nowIso = () => new Date().toISOString(), log = console }) {
  const doFetch = fetchFn || (typeof fetch === 'function' ? fetch : null);
  const base = () => String(env.PENNYLANE_API_URL || 'https://app.pennylane.com/api/external/v2').replace(/\/$/, '');
  const enabled = () => !!env.PENNYLANE_API_TOKEN && env.PENNYLANE_SYNC !== '0' && !!doFetch;
  const creditNotesOn = () => env.PENNYLANE_CREDIT_NOTES === '1';

  async function call(method, path, body, isForm) {
    const res = await doFetch(base() + path, {
      method,
      headers: { Authorization: 'Bearer ' + env.PENNYLANE_API_TOKEN, Accept: 'application/json', ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { /* corps non JSON */ }
    if (!res.ok) { const e = new Error(`Pennylane ${method} ${path} → ${res.status} ${(json && (json.error || json.message)) || text.slice(0, 200)}`); e.status = res.status; throw e; }
    return json || {};
  }

  /** Client Pennylane : particuliers regroupés sous un seul client ; professionnels = un client par SIREN (sinon par e-mail). */
  async function ensureCustomer(doc) {
    const pro = doc.buyer_type === 'professionnel';
    const key = pro ? 'pro:' + (doc.buyer_siren || (doc.buyer_email || '').toLowerCase()) : 'b2c';
    const { data: known } = await supabase.from('accounting_customers').select('*').eq('key', key).maybeSingle();
    if (known && known.pennylane_customer_id) return known.pennylane_customer_id;
    const a = doc.buyer_address || {};
    const payload = pro
      ? { name: doc.buyer_name || doc.buyer_email, emails: doc.buyer_email ? [doc.buyer_email] : [], reg_no: doc.buyer_siren || undefined, vat_number: doc.buyer_vat || undefined,
          billing_address: { address: [a.line1, a.line2].filter(Boolean).join(', '), postal_code: a.postal_code || '', city: a.city || '', country_alpha2: a.country || 'FR' }, external_reference: key }
      : { name: env.PENNYLANE_B2C_CUSTOMER_NAME || 'Clients particuliers (EuroVin)', billing_address: { address: '-', postal_code: '-', city: '-', country_alpha2: 'FR' }, external_reference: key };
    const c = await call('POST', '/company_customers', payload);
    if (!c.id) throw new Error('Pennylane : identifiant client absent de la réponse');
    await supabase.from('accounting_customers').upsert({ key, pennylane_customer_id: String(c.id) }, { onConflict: 'key' });
    return String(c.id);
  }

  function invoiceLines(doc, sign) {
    return I.linesOf(doc).map((l) => {
      const code = vatCode(doc, l.vat_rate, env);
      if (!code) { const e = new Error(`TVA à valider (régime ${doc.vat_regime}, taux ${l.vat_rate} %, pays ${doc.buyer_country || '?'})`); e.review = true; throw e; }
      return { label: l.label, quantity: String(l.qty || 1), raw_currency_unit_price: eur(sign * l.unit_ht_cents), unit: 'piece', vat_rate: code,
        currency_amount: eur(sign * l.ttc_cents), currency_tax: eur(sign * l.tax_cents) };
    });
  }

  async function push(kind, doc, inv) {
    const sign = kind === 'credit_note' ? -1 : 1;
    const lines = invoiceLines(doc, sign);                                   // peut lever « à valider » avant tout appel réseau
    const customerId = await ensureCustomer(doc);
    const pdf = kind === 'credit_note' ? await buildCreditNotePdf(doc, inv, I.sellerFromEnv(env)) : await buildInvoicePdf(doc, doc.seller || I.sellerFromEnv(env));
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), `${doc.number}.pdf`);
    const att = await call('POST', '/file_attachments', form, true);
    const day = String(doc.issued_at || nowIso()).slice(0, 10);
    const out = await call('POST', '/customer_invoices/import', {
      file_attachment_id: att.id, customer_id: Number.isNaN(Number(customerId)) ? customerId : Number(customerId), date: day, deadline: String(doc.due_date || day).slice(0, 10),
      currency: 'EUR', external_reference: doc.number, invoice_lines: lines,
    });
    return String(out.id || out.invoice_id || doc.number);
  }

  const table = (kind) => (kind === 'credit_note' ? 'credit_notes' : 'invoices');
  async function setStatus(kind, id, patch) { await supabase.from(table(kind)).update({ ...patch, accounting_updated_at: nowIso() }).eq('id', id); }

  /** Envoie un document ; renvoie le statut final. Ne lève jamais. */
  async function syncOne(kind, doc, inv) {
    const prev = doc.accounting_status;
    const { data: claimed } = await supabase.from(table(kind)).update({ accounting_status: 'sending', accounting_updated_at: nowIso() }).eq('id', doc.id).eq('accounting_status', prev).select();
    if (!claimed || !claimed.length) return prev;                            // pris par un autre traitement
    try {
      const ref = await push(kind, doc, inv);
      await setStatus(kind, doc.id, { accounting_status: 'synced', accounting_ref: ref, accounting_error: null });
      return 'synced';
    } catch (e) {
      if (e.review) { await setStatus(kind, doc.id, { accounting_status: 'needs_review', accounting_error: e.message }); return 'needs_review'; }
      const attempts = (doc.accounting_attempts || 0) + 1;
      log.error('Pennylane :', e.message);
      await setStatus(kind, doc.id, { accounting_status: 'error', accounting_error: String(e.message).slice(0, 300), accounting_attempts: attempts });
      return 'error';
    }
  }

  const waitMs = (attempts) => Math.min(5 * 60e3 * 2 ** attempts, 6 * 3600e3);
  /** Passe de rattrapage (cron) : factures en attente, erreurs dont le délai est écoulé, envois bloqués. */
  async function syncPending(limit = 20) {
    if (!enabled()) return { enabled: false, done: 0 };
    const ago = (ms) => new Date(Date.now() - ms).toISOString();
    await supabase.from('invoices').update({ accounting_status: 'pending' }).eq('accounting_status', 'sending').lt('accounting_updated_at', ago(10 * 60e3));
    const { data: rows } = await supabase.from('invoices').select('*').in('accounting_status', ['pending', 'error']).eq('details_complete', true).limit(limit * 3);
    let done = 0;
    for (const d of rows || []) {
      if (done >= limit) break;
      if (d.accounting_status === 'error' && ((d.accounting_attempts || 0) >= MAX_ATTEMPTS || new Date(d.accounting_updated_at || 0).getTime() > Date.now() - waitMs(d.accounting_attempts || 0))) continue;
      await syncOne('invoice', d, d); done++;
    }
    if (creditNotesOn()) {
      const { data: notes } = await supabase.from('credit_notes').select('*').in('accounting_status', ['pending', 'error']).limit(limit);
      for (const n of notes || []) {
        const { data: inv } = await supabase.from('invoices').select('*').eq('id', n.invoice_id).maybeSingle();
        if (inv && inv.accounting_status === 'synced') { await syncOne('credit_note', n, inv); done++; }   // l'avoir suit sa facture
      }
    }
    return { enabled: true, done };
  }

  /** Relance manuelle (admin) : repart de zéro, pour une facture ou un avoir. */
  async function retry(kind, id) {
    await supabase.from(table(kind)).update({ accounting_status: 'pending', accounting_attempts: 0, accounting_error: null, accounting_updated_at: nowIso() }).eq('id', id);
    if (!enabled()) return { queued: true, enabled: false };
    const { data: d } = await supabase.from(table(kind)).select('*').eq('id', id).maybeSingle();
    if (!d) return { queued: false };
    let inv = d;
    if (kind === 'credit_note') { const r = await supabase.from('invoices').select('*').eq('id', d.invoice_id).maybeSingle(); inv = r.data; }
    return { queued: true, enabled: true, status: await syncOne(kind, d, inv) };
  }

  return { enabled, syncPending, syncOne, retry, vatCode, MAX_ATTEMPTS };
};
module.exports.vatCode = vatCode;
