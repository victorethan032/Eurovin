'use strict';
const assert = require('assert');
const lib = require('./lib');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('ÉCHEC :', name, '\n ', e.message); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('ÉCHEC :', name, '\n ', e.message); process.exitCode = 1; } };

t('VIN valide (casse et espaces tolérés)', () => assert.deepStrictEqual(lib.checkVin(' wba5r11050fh12345 '), { ok: true, vin: 'WBA5R11050FH12345' }));
t('VIN trop court', () => assert.strictEqual(lib.checkVin('WBA5').reason, 'LENGTH'));
t('VIN avec la lettre O', () => assert.strictEqual(lib.checkVin('WBA5R11050FO12345').reason, 'CHARS'));
t('VIN hors Europe', () => assert.strictEqual(lib.checkVin('1HGCM82633A004352').reason, 'NON_EU'));
t('VIN absent', () => assert.strictEqual(lib.checkVin(undefined).ok, false));

const ok = { kind: 'report', vin: 'WBA5R11050FH12345', plan: 'premium', email: 'A@B.fr', consent: { cgv: true, waiver: true } };
t('commande valide', () => assert.strictEqual(lib.validateCheckoutBody(ok).value.email, 'a@b.fr'));
t('renonciation obligatoire', () => assert.strictEqual(lib.validateCheckoutBody({ ...ok, consent: { cgv: true } }).error, 'WAIVER_REQUIRED'));
t('CGV obligatoires', () => assert.strictEqual(lib.validateCheckoutBody({ ...ok, consent: { waiver: true } }).error, 'CGV_REQUIRED'));
t('plan « constructor » refusé', () => assert.strictEqual(lib.validateCheckoutBody({ ...ok, plan: 'constructor' }).error, 'PLAN_INVALID'));
t('email invalide', () => assert.strictEqual(lib.validateCheckoutBody({ ...ok, email: 'x@y' }).error, 'EMAIL_INVALID'));
t('pack valide', () => assert.strictEqual(lib.validateCheckoutBody({ kind: 'pack', packSize: 30, consent: { cgv: true } }).value.packSize, 30));
t('pack inconnu / « toString »', () => { assert.strictEqual(lib.validateCheckoutBody({ kind: 'pack', packSize: 7, consent: { cgv: true } }).error, 'PACK_INVALID'); assert.strictEqual(lib.validateCheckoutBody({ kind: 'pack', packSize: 'toString', consent: { cgv: true } }).error, 'PACK_INVALID'); });
t('type inconnu', () => assert.strictEqual(lib.validateCheckoutBody({ kind: 'x' }).error, 'KIND_INVALID'));
t('coûts en crédits : Essentiel 1, Premium 2', () => assert.deepStrictEqual({ ...lib.CREDIT_COST }, { essentiel: 1, premium: 2 }));
t('prix serveur : 7,99 € et 12,99 €', () => assert.deepStrictEqual({ ...lib.PRICES_TTC_CENTS }, { essentiel: 799, premium: 1299 }));

t('options : doublons et vides ignorés', () => assert.strictEqual(lib.countOptions([{ code: 'A', label: 'a' }, { code: 'A', label: 'b' }, { code: ' ' }, null, { code: 'B' }]), 2));

const stats = { n: 40, base: { p25: 30000, p50: 34000, p75: 38000 }, medianKm: 50000, kmSlope: -0.06, optionUplifts: { A: { amount: 1200, n: 50 }, B: { amount: 900, n: 10 }, C: { amount: 700, n: 35 } } };
t('cotation : comparables insuffisants = non estimable (pas de prix par défaut)', () => assert.strictEqual(lib.estimateValue({ ...stats, n: 5 }).status, 'not_estimable'));
t('cotation : absence de données = non estimable', () => assert.strictEqual(lib.estimateValue(null).status, 'not_estimable'));
t('cotation : calcul et arrondi', () => { const v = lib.estimateValue(stats, { km: 50000, presentCodes: ['A', 'C'] }); assert.strictEqual(v.status, 'ok'); assert.strictEqual(v.optionsAdj, 1900); assert.strictEqual(v.mid, 35900); assert.strictEqual(v.low, 31900); assert.strictEqual(v.high, 39900); });
t('cotation : option avec échantillon < 30 ignorée', () => assert.deepStrictEqual(lib.estimateValue(stats, { presentCodes: ['B'] }).breakdown, []));
t('cotation : kilométrage élevé baisse le prix', () => assert.ok(lib.estimateValue(stats, { km: 110000 }).mid < lib.estimateValue(stats, { km: 50000 }).mid));
t('cotation : plus-values plafonnées à 15 %', () => { const s = { ...stats, optionUplifts: { A: { amount: 9000, n: 99 } } }; assert.ok(lib.estimateValue(s, { presentCodes: ['A'] }).optionsAdj <= 34000 * 0.15 + 1); });
t('cotation : données incohérentes refusées', () => assert.strictEqual(lib.estimateValue({ ...stats, base: { p25: 40000, p50: 34000, p75: 38000 } }).reason, 'DONNEES_INCOHERENTES'));

const val = lib.estimateValue(stats, { km: 50000, presentCodes: ['A', 'C'] }), al = lib.allowedNumbers(val);
t('texte IA conforme accepté', () => assert.ok(lib.explanationIsSafe(`Sur ${val.n} annonces comparables, le véhicule se situe entre ${val.low} et ${val.high} euros, autour de ${val.mid} euros.`, al)));
t('texte IA avec un montant inventé refusé', () => assert.strictEqual(lib.explanationIsSafe('Ce véhicule vaut 52 000 euros sur le marché actuel.', al), false));
t('texte IA « expert / garanti » refusé', () => { assert.strictEqual(lib.explanationIsSafe('Avis d’expert : excellente affaire pour ce modèle rare.', al), false); assert.strictEqual(lib.explanationIsSafe('Prix garanti pour ce véhicule de collection.', al), false); });


/* ---------- paiements et gestion (payments.js) ---------- */
const P = require('./payments');
const body = { kind: 'report', vin: 'WBA5R11050FH12345', plan: 'premium', email: 'a@b.fr' };
t('checkout : montant TTC pris côté serveur', () => { const p = P.buildCheckoutParams({ body: { ...body, amount: 1 }, user: null, meta: {}, appUrl: 'https://x.fr', taxOn: true, env: {} }); assert.strictEqual(p.line_items[0].price_data.unit_amount, 1299); assert.strictEqual(p.line_items[0].price_data.tax_behavior, 'inclusive'); });
t('checkout : aucun moyen de paiement imposé = Stripe affiche tous ceux activés', () => { const p = P.buildCheckoutParams({ body, user: null, meta: {}, appUrl: 'https://x.fr', taxOn: true, env: {} }); assert.ok(!('payment_method_types' in p)); assert.strictEqual(p.locale, 'auto'); assert.strictEqual(p.allow_promotion_codes, true); assert.deepStrictEqual(p.automatic_tax, { enabled: true }); });
t('checkout : liste de moyens forcée et nettoyée', () => { const p = P.buildCheckoutParams({ body, user: null, meta: {}, appUrl: 'https://x.fr', taxOn: false, env: { PAYMENT_METHOD_TYPES: 'card, paypal ,ideal,;;drop' } }); assert.deepStrictEqual(p.payment_method_types, ['card', 'paypal', 'ideal']); assert.ok(!p.automatic_tax); });
t('checkout : codes promo désactivables', () => assert.strictEqual(P.buildCheckoutParams({ body, user: null, meta: {}, appUrl: 'u', taxOn: 0, env: { ALLOW_PROMO_CODES: '0' } }).allow_promotion_codes, false));
t('checkout : invité = email, connecté = client Stripe', () => { const g = P.buildCheckoutParams({ body, user: null, meta: {}, appUrl: 'u', taxOn: 1, env: {} }); assert.strictEqual(g.customer_email, 'a@b.fr'); assert.ok(!g.customer); const c = P.buildCheckoutParams({ body, user: { email: 'x@y.fr' }, customerId: 'cus_1', meta: {}, appUrl: 'u', taxOn: 1, env: {} }); assert.strictEqual(c.customer, 'cus_1'); assert.ok(!c.customer_email); assert.deepStrictEqual(c.customer_update, { address: 'auto', name: 'auto' }); });
t('checkout : pack = prix HT + TVA ajoutée + numéro de TVA', () => { const p = P.buildCheckoutParams({ body: { kind: 'pack', packSize: 30 }, user: { email: 'p@q.fr' }, meta: {}, appUrl: 'u', taxOn: 1, env: {} }); assert.strictEqual(p.line_items[0].price_data.unit_amount, 12900); assert.strictEqual(p.line_items[0].price_data.tax_behavior, 'exclusive'); assert.strictEqual(p.tax_id_collection.enabled, true); });

const ord = { kind: 'report', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, refunded_tax_cents: 0 };
t('avoir : remboursement total solde exactement la TVA', () => assert.deepStrictEqual(P.splitCreditNote(ord, 1299), { ttc: 1299, tax: 217, ht: 1082, remainingAfter: 0 }));
t('avoir : deux remboursements partiels = pas d’écart d’un centime', () => { const a = P.splitCreditNote(ord, 500); const o2 = { ...ord, refunded_cents: 500, refunded_tax_cents: a.tax }; const b = P.splitCreditNote(o2, 799); assert.strictEqual(a.tax + b.tax, 217); assert.strictEqual(a.ttc + b.ttc, 1299); assert.strictEqual(b.remainingAfter, 0); });
t('avoir : dépassement refusé', () => assert.throws(() => P.splitCreditNote({ ...ord, refunded_cents: 1000 }, 400), (e) => e.code === 'EXCEEDS_REMAINING'));
t('avoir : montant nul, négatif ou décimal refusé', () => { for (const x of [0, -5, 1.5, NaN, '10']) assert.throws(() => P.splitCreditNote(ord, x), (e) => e.code === 'AMOUNT_INVALID'); });
const pack = { kind: 'pack', credits_delta: 30, amount_ttc_cents: 15480, amount_tax_cents: 2580, refunded_cents: 0, credits_reversed: 0 };
t('pack : remboursement total retire tous les crédits', () => assert.strictEqual(P.creditsToReverse(pack, 15480), 30));
t('pack : remboursement partiel retire des crédits proportionnels (arrondi au supérieur)', () => assert.strictEqual(P.creditsToReverse(pack, 5160), 10));
t('pack : solde restant après un premier retrait', () => assert.strictEqual(P.creditsToReverse({ ...pack, refunded_cents: 5160, credits_reversed: 10 }, 10320), 20));
t('rapport : aucun crédit à retirer', () => assert.strictEqual(P.creditsToReverse(ord, 1299), 0));

t('SIRET valide (clé de Luhn)', () => assert.strictEqual(P.validSiret('732 829 320 00074'), true));
t('SIRET : mauvaise clé ou longueur refusées', () => { assert.strictEqual(P.validSiret('73282932000075'), false); assert.strictEqual(P.validSiret('1234'), false); assert.strictEqual(P.validSiret(''), false); });
t('support : message valide', () => assert.strictEqual(P.validateTicket({ email: 'A@b.fr', subject: 'Facture', message: 'Bonjour, il me manque la facture.' }).value.email, 'a@b.fr'));
t('support : sujet inconnu, message court, VIN invalide refusés', () => { assert.strictEqual(P.validateTicket({ email: 'a@b.fr', subject: 'x', message: 'Bonjour bonjour' }).error, 'SUBJECT_INVALID'); assert.strictEqual(P.validateTicket({ email: 'a@b.fr', subject: 'Facture', message: 'court' }).error, 'MESSAGE_INVALID'); assert.strictEqual(P.validateTicket({ email: 'a@b.fr', subject: 'Facture', message: 'Bonjour bonjour', vin: 'ABC' }).error, 'VIN_INVALID'); });
t('signalement d’erreur : type connu obligatoire', () => { assert.strictEqual(P.validateReportError({ type: 'Une option manque' }).ok, true); assert.strictEqual(P.validateReportError({ type: 'inconnu' }).error, 'TYPE_INVALID'); });
t('profil : téléphone et SIRET contrôlés, rôle et crédits jamais modifiables', () => { const v = P.validateProfilePatch({ phone: '+33 6 12 34 56 78', role: 'pro', credits_balance: 999 }); assert.deepStrictEqual(v.value, { phone: '+33612345678' }); assert.strictEqual(P.validateProfilePatch({ phone: '12' }).error, 'PHONE_INVALID'); assert.strictEqual(P.validateProfilePatch({ company_siret: '12345678901234' }).error, 'SIRET_INVALID'); assert.strictEqual(P.validateProfilePatch({ role: 'pro' }).error, 'NOTHING_TO_UPDATE'); });
t('admin : comparaison de clé à temps constant, clé vide refusée', () => { assert.strictEqual(P.safeEq('abc', 'abc'), true); assert.strictEqual(P.safeEq('abc', 'abd'), false); assert.strictEqual(P.safeEq('', ''), false); assert.strictEqual(P.safeEq(undefined, 'x'), false); });
t('tableau de bord : totaux nets des remboursements', () => { const s = P.summarizeOrders([{ kind: 'report', amount_ttc_cents: 1299, amount_tax_cents: 217, refunded_cents: 0, refunded_tax_cents: 0 }, { kind: 'report', amount_ttc_cents: 799, amount_tax_cents: 133, refunded_cents: 799, refunded_tax_cents: 133 }, { kind: 'pack', amount_ttc_cents: 5880, amount_tax_cents: 980, refunded_cents: 0, refunded_tax_cents: 0, dispute_status: 'needs_response' }, { kind: 'credit_use', status: 'delivered' }]); assert.strictEqual(s.paid_ttc_cents, 7978); assert.strictEqual(s.net_ttc_cents, 7179); assert.strictEqual(s.tax_cents, 1197); assert.strictEqual(s.disputes, 1); assert.strictEqual(s.refunded_orders, 1); assert.strictEqual(s.credit_uses, 1); });

// --- Aperçu gratuit : pays du constructeur et année modèle indicative, lus dans le VIN ---
const VF = require('./site/vinfacts');
const NOW = new Date('2026-10-07');
for (const [vin, pays] of [['WP0ZZZ99ZTS392124', 'Allemagne'], ['VF1RFB00X56123456', 'France'], ['ZFA31200003123456', 'Italie'], ['YV1MS382392123456', 'Suède'], ['TMBJG7NE5K0123456', 'Tchéquie'], ['SAJAA01A3FM123456', 'Royaume-Uni'], ['VSSZZZ5FZHR123456', 'Espagne'], ['XL9AB12345X123456', 'Pays-Bas'], ['UUHAB123450123456', 'Roumanie'], ['YF1AB12345X123456', 'Finlande']]) t('pays du constructeur : ' + vin.slice(0, 3) + ' → ' + pays, () => assert.strictEqual(VF.country(vin), pays));
t('pays : préfixe inconnu → rien n’est inventé', () => { assert.strictEqual(VF.country('S1ABC123456789012'), null); assert.strictEqual(VF.country('T6ABC123456789012'), null); assert.strictEqual(VF.country('1HGCM82633A004352'), null); });
t('année : lettre H → 2017 (ou 1987)', () => assert.deepStrictEqual(VF.modelYear('WBA8E9C50HK123456', NOW), { likely: 2017, alt: 1987 }));
t('année : chiffre 5 → 2005 seulement (2035 est dans le futur)', () => assert.deepStrictEqual(VF.modelYear('VF1RFB00X56123456', NOW), { likely: 2005, alt: null }));
t('année : 10e caractère invalide (0, U, Z) → null', () => { for (const c of ['0', 'U', 'Z']) assert.strictEqual(VF.modelYear('WBA8E9C50' + c + 'K123456', NOW), null); });
t('année : jamais plus d’un an dans le futur', () => assert.ok(VF.modelYear('WBA8E9C50YK123456', NOW) === null || VF.modelYear('WBA8E9C50YK123456', NOW).likely <= 2027));
t('lib.vinFacts expose pays et année', () => { const f = lib.vinFacts('WBA8E9C50GK123456'); assert.strictEqual(f.country, 'Allemagne'); assert.strictEqual(f.modelYear.likely, 2016); });

(async () => {
  process.env.PROVIDER_TIMEOUT_MS = '60'; process.env.PROVIDER_DEADLINE_MS = '1000';
  const P = require('./providers');
  const opts = (k) => ({ vehicle: { make: 'X' }, options: Array.from({ length: k }, (_, i) => ({ code: 'C' + i, label: 'o' + i })) });
  await ta('aucun fournisseur configuré : erreur explicite', async () => { process.env.PROVIDER_ORDER = ''; await assert.rejects(P.decodeVin('WBA5R11050FH12345'), (e) => e.code === 'NOT_CONFIGURED'); });
  await ta('adaptateurs non écrits : échec, jamais de fausses données', async () => { process.env.PROVIDER_ORDER = 'vindata,jato'; await assert.rejects(P.decodeVin('WBA5R11050FH12345'), (e) => e.code === 'ALL_FAILED'); });
  await ta('cascade : résultat partiel puis complet', async () => { P.ADAPTERS.a = async () => opts(4); P.ADAPTERS.b = async () => opts(12); process.env.PROVIDER_ORDER = 'a,b'; const r = await P.decodeVin('X'); assert.strictEqual(r.source, 'b'); assert.strictEqual(r.options.length, 12); });
  await ta('cascade : on garde le meilleur résultat partiel', async () => { P.ADAPTERS.a = async () => opts(4); P.ADAPTERS.b = async () => opts(6); process.env.PROVIDER_ORDER = 'a,b'; const r = await P.decodeVin('X'); assert.strictEqual(r.options.length, 6); });
  await ta('délai dépassé : bascule sur le suivant', async () => { P.ADAPTERS.slow = () => new Promise(() => {}); P.ADAPTERS.b = async () => opts(12); process.env.PROVIDER_ORDER = 'slow,b'; const r = await P.decodeVin('X'); assert.strictEqual(r.source, 'b'); });
  await ta('réponse vide ignorée', async () => { P.ADAPTERS.empty = async () => ({ options: [] }); process.env.PROVIDER_ORDER = 'empty'; await assert.rejects(P.decodeVin('X'), (e) => e.code === 'ALL_FAILED'); });
  await ta('cotation sans fournisseur de marché : null', async () => { delete process.env.MARKET_PROVIDER; assert.strictEqual(await P.getMarketStats({}, []), null); });
  console.log(process.exitCode ? 'Des tests ont échoué.' : `${n} tests réussis.`);
})();
