'use strict';
/**
 * Fournisseurs de données. RÈGLE : ne jamais renvoyer de données inventées ni de données hors Europe.
 * Contrat d'un adaptateur : async (vin, { signal }) => { vehicle:{make,model,year,engine,trim,color,upholstery}, options:[{code,label,priceCents?,category?}] }
 * Les vrais adaptateurs s'écrivent après le POC (phase 0), selon la documentation du fournisseur retenu.
 */
const { MIN_OPTIONS, normalizeOptions } = require('./lib');

class ProviderError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}
const notImplemented = (name) => async () => { throw new ProviderError('NOT_IMPLEMENTED', `Adaptateur ${name} à écrire après le POC`); };

const ADAPTERS = { vindata: notImplemented('VINdata'), jato: notImplemented('JATO'), autovista: notImplemented('Autovista') };
if (process.env.ALLOW_MOCK === '1' && process.env.NODE_ENV !== 'production') {
  // Jeu de test (jamais en production) : libellés allemands/anglais pour exercer la traduction, catalogue pour le comparatif.
  const MOCK_OPTS = [['C01', 'Klimaautomatik', 'Confort', 45000], ['C02', 'Head-Up Display HUD', 'Confort', 89000], ['C03', 'Komfortzugang', 'Confort', 52000], ['C04', 'Navigationssystem', 'Multimédia', 190000],
    ['C05', 'LED Scheinwerfer', 'Extérieur', 120000], ['C06', 'Metallic Lackierung', 'Extérieur', 99000], ['C07', 'Rückfahrkamera', 'Sécurité', 35000], ['C08', 'Parkassistent', 'Sécurité', 78000], ['C09', 'Anhängerkupplung', 'Extérieur', 85000],
    ['C10', 'Leichtmetallräder', 'Extérieur', 150000], ['C11', 'Sportlenkrad', 'Intérieur', 30000], ['C12', 'Winterpaket', 'Confort', 65000], ['C13', 'Pack Sport', 'Extérieur', 280000], ['C14', 'Sonderausstattung XYZ-Spezial', 'Autres', null]];
  const MOCK_CAT = [...MOCK_OPTS.slice(0, 13), ...['Panoramadach', 'Harman Kardon Soundsystem', 'Luftfederung', 'Nachtsicht', 'Elektrische Heckklappe', 'Sportauspuff', 'Dachreling', 'Diebstahlwarnanlage', 'Spurverlassenswarnung', 'Totwinkelassistent', 'Abstandsregeltempomat', 'Ablagenpaket'].map((l, i) => ['K' + (i + 1), l, 'Options', 40000 + i * 5000])];
  const row = ([code, label, category, priceCents]) => ({ code, label, category, priceCents, lang: 'de' });
  ADAPTERS.mock = async () => ({
    vehicle: { make: 'BMW', model: '320d Touring', year: 2021, engine: 'B47 190 ch', trim: 'M Sport', color: 'Sophisto Grey', upholstery: 'Cuir Vernasca' },
    tech: { generation: 'G21', powerHp: 190, powerKw: 140, displacementCc: 1995, fuel: 'Diesel', gearbox: 'Automatique', gears: 8, drive: 'Propulsion', country: 'Allemagne', plant: 'Munich', builtAt: '2021-02' },
    options: MOCK_OPTS.map(row), catalogue: MOCK_CAT.map(row),
  });
}
/* Historique et rappels : contrats d'adaptateur (écrits après le POC, selon la documentation des fournisseurs).
 *  history : async (vin,{signal}) => { status:'ok'|'unavailable', events:[{date,title,place}], theft:{status,text}, lien:{status,text}, damage:{status,items:[{date,kind,text,country}]}, source, asOf }
 *  recalls : async (vin,{signal}) => { status:'ok'|'unavailable', items:[{ref,date,title,status}], source, asOf } */
const HISTORY_ADAPTERS = { carvertical: notImplemented('carVertical'), carfax: notImplemented('CARFAX Europe') };
const RECALL_ADAPTERS = { automotivapi: notImplemented('AutomotivAPI') };
if (process.env.ALLOW_MOCK === '1' && process.env.NODE_ENV !== 'production') {
  const today = new Date().toISOString().slice(0, 10);
  HISTORY_ADAPTERS.mock = async () => ({ status: 'ok', source: 'mock', asOf: today,
    events: [{ date: '2021-03', title: 'Première mise en circulation', place: 'Allemagne' }, { date: '2022-09', title: 'Importation et immatriculation', place: 'France' }],
    theft: { status: 'none_found' }, lien: { status: 'none_found' }, damage: { status: 'none_found' } });
  RECALL_ADAPTERS.mock = async () => ({ status: 'ok', source: 'mock', asOf: today, items: [{ ref: 'T-01', date: '2022-06', title: 'Campagne de test', status: 'Réalisée' }] });
}
const MARKET_ADAPTERS = {}; // à écrire : doit renvoyer { n, base:{p25,p50,p75}, medianKm, kmSlope, optionUplifts } ou null

const num = (k, d) => parseInt(process.env[k] || String(d), 10);

function sanitize(r) {
  if (!r || !Array.isArray(r.options)) return null;
  const options = normalizeOptions(r.options);
  if (!options.length) return null;
  const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : undefined);
  return {
    vehicle: obj(r.vehicle) || {}, options,
    ...(obj(r.tech) ? { tech: r.tech } : {}),
    ...(Array.isArray(r.catalogue) ? { catalogue: normalizeOptions(r.catalogue) } : {}),   // options disponibles pour la finition (comparatif)
  };
}

async function callProvider(name, vin, deadline) {
  const fn = ADAPTERS[name];
  if (!fn) throw new ProviderError('UNKNOWN_PROVIDER', name);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), num('PROVIDER_TIMEOUT_MS', 8000));
  const onDeadline = () => ac.abort();
  deadline.addEventListener('abort', onDeadline);
  try {
    const work = fn(vin, { signal: ac.signal });
    work.catch(() => {});                                  // évite une rejection non gérée après annulation
    const stop = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new ProviderError('TIMEOUT', name))));
    return await Promise.race([work, stop]);
  } finally { clearTimeout(timer); deadline.removeEventListener('abort', onDeadline); }
}

/** Cascade : on s'arrête dès qu'un fournisseur renvoie assez d'options ; sinon on garde le meilleur résultat partiel. */
async function decodeVin(vin) {
  const order = (process.env.PROVIDER_ORDER || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!order.length) throw new ProviderError('NOT_CONFIGURED', 'Aucun fournisseur configuré (PROVIDER_ORDER)');
  const deadline = new AbortController();
  const dt = setTimeout(() => deadline.abort(), num('PROVIDER_DEADLINE_MS', 25000));
  let best = null; const errors = [];
  try {
    for (const name of order) {
      if (deadline.signal.aborted) break;
      try {
        const ok = sanitize(await callProvider(name, vin, deadline.signal));
        if (!ok) { errors.push(`${name}:EMPTY`); continue; }
        const cand = { ...ok, source: name };
        if (!best || cand.options.length > best.options.length) best = cand;
        if (cand.options.length >= MIN_OPTIONS) return cand;
      } catch (e) { errors.push(`${name}:${e.code || e.message}`); }
    }
  } finally { clearTimeout(dt); }
  if (best) return best;
  throw new ProviderError('ALL_FAILED', errors.join(' | '));
}

/** Rubrique optionnelle : jamais bloquante. Échec ou timeout => null (la rubrique est alors « indisponible »). */
async function optional(registry, envKey, vin) {
  const order = (process.env[envKey] || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const name of order) {
    const fn = registry[name]; if (!fn) continue;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), num('PROVIDER_TIMEOUT_MS', 8000));
    try {
      const work = fn(vin, { signal: ac.signal }); work.catch(() => {});
      const stop = new Promise((_, rej) => ac.signal.addEventListener('abort', () => rej(new ProviderError('TIMEOUT', name))));
      const r = await Promise.race([work, stop]);
      if (r && r.status === 'ok') return r;
    } catch (e) { console.error(`${envKey}/${name} :`, e.code || e.message); } finally { clearTimeout(t); }
  }
  return null;
}
const getHistory = (vin) => optional(HISTORY_ADAPTERS, 'HISTORY_ORDER', vin);
const getRecalls = (vin) => optional(RECALL_ADAPTERS, 'RECALL_ORDER', vin);

async function getMarketStats(vehicle, options) {
  const name = process.env.MARKET_PROVIDER;
  if (!name || !MARKET_ADAPTERS[name]) return null;       // pas de données = « non estimable »
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), num('PROVIDER_TIMEOUT_MS', 8000));
  try { return await MARKET_ADAPTERS[name](vehicle, options, { signal: ac.signal }); } finally { clearTimeout(t); }
}

module.exports = { decodeVin, getMarketStats, getHistory, getRecalls, ADAPTERS, HISTORY_ADAPTERS, RECALL_ADAPTERS, ProviderError };
