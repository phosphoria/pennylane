// @ts-check
/**
 * outil.core.js — Bibliothèque PURE de complétion des exports Pennylane (web).
 *
 * Aucun accès au DOM : tout est testable en Node. Chaque ligne produit
 * exactement UN {@link Outcome} (union discriminée). Les états illégaux ne sont
 * pas représentables.
 *
 * Périmètre du navigateur : **France uniquement** (API Sirene, qui autorise les
 * appels navigateur). Les fournisseurs **européens ne sont PAS complétés en
 * ligne** : VIES (Commission européenne) n'autorise pas les appels cross-origin
 * (CORS) depuis un navigateur. Le code pays est corrigé, et l'adresse doit être
 * récupérée via la version téléchargeable (le script Python interroge VIES
 * côté machine, où la restriction ne s'applique pas).
 *
 * Discipline de typage : pas de `null`, ni de `undefined`/`unknown`/`any` qui
 * « fuit » dans le code métier. Les absences sont des unions discriminées ou la
 * chaîne vide `""`. Le seul `unknown` est la frontière JSON (types `Api*`),
 * converti aussitôt en modèle propre.
 */

/* ============================== Constantes ============================== */

export const API_URL = "https://recherche-entreprises.api.gouv.fr/search";
export const ANNUAIRE_URL = "https://annuaire-entreprises.data.gouv.fr/entreprise/";
export const SLEEP_MS = 160;

/** Codes pays de l'UE (+ XI) — sert uniquement à qualifier un fournisseur étranger. @type {ReadonlySet<string>} */
export const EU_COUNTRIES = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","EL","GR",
  "ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"]);

/** @type {ReadonlySet<string>} */
export const GENERIC_LABELS = new Set(["Hôtels","Hotels","Parking","Restaurants","Taxi","Taxis",
  "Transport","Transports","Autre","Autres","FOURNISSEURS DIVERS","DIVERS - FR","DIVERS",
  "Frais bancaires","Frais de mission","Notes de frais","Péage","Peage","Carburant","Essence",
  "Pourboire","Pourboires"]);

/** Préfixes génériques (comparaison insensible à la casse). @type {readonly string[]} */
export const GENERIC_PREFIXES = ["NOTE DE FRAIS", "FRS DIVERS "];

/** Vrai si le nom est un libellé générique (exact ou par préfixe). @param {string} nom @returns {boolean} */
export function isGenericLabel(nom) {
  if (GENERIC_LABELS.has(nom)) return true;
  const up = nom.toUpperCase();
  return GENERIC_PREFIXES.some(p => up.startsWith(p));
}

/** @type {readonly OutcomeKind[]} */
export const OUTCOME_KINDS = [
  "already", "completed_fr", "completed_name",
  "generic", "diffusion", "not_found", "unconfirmed", "ambiguous", "foreign", "error"
];

/** @type {ReadonlySet<string>} */
export const COMPLETED_KINDS = new Set(["already", "completed_fr", "completed_name"]);

/* ========================== Types du domaine ========================== */

/**
 * @typedef {Object} Columns
 * @property {string} nom
 * @property {string} id
 * @property {"SIRET"|"SIREN"} idKind
 * @property {string} tva
 * @property {string} adresse
 * @property {string} cp
 * @property {string} ville
 * @property {string} pays
 */

/** @typedef {Record<string,string>} Row */

/**
 * @typedef {Object} CompanyInfo
 * @property {string} siren
 * @property {string} siret
 * @property {string} adresse
 * @property {string} code_postal
 * @property {string} ville
 * @property {string} nom_officiel
 */

/** @typedef {[nom:string, siren:string, ville:string]} Candidate */

/** @typedef {{ ok: true, columns: Columns } | { ok: false, missing: string[] }} ColumnsResult */
/** @typedef {{ status: "found", info: CompanyInfo } | { status: "protected" } | { status: "not_found" } | { status: "unconfirmed" }} SirenLookup */
/** @typedef {{ status: "match", info: CompanyInfo, candidates: Candidate[] } | { status: "ambiguous", candidates: Candidate[] }} NameLookup */

/**
 * Dépendances réseau injectables (tests sans requête réelle).
 * @typedef {Object} Deps
 * @property {(siren:string)=>Promise<SirenLookup>} lookupSiren
 * @property {(nom:string)=>Promise<NameLookup>} lookupByName
 * @property {(ms:number)=>Promise<void>} sleep
 */

/** @typedef {Outcome["kind"]} OutcomeKind */

/**
 * Issue d'UNE ligne — union discriminée.
 * @typedef {(
 *   | { kind: "already" }
 *   | { kind: "generic" }
 *   | { kind: "completed_fr" }
 *   | { kind: "completed_name", siren: string, nomOfficiel: string }
 *   | { kind: "diffusion", siren: string }
 *   | { kind: "not_found", siren: string }
 *   | { kind: "unconfirmed", siren: string }
 *   | { kind: "ambiguous", candidates: Candidate[] }
 *   | { kind: "foreign", cc: string, inEu: boolean }
 *   | { kind: "error", message: string }
 * )} Outcome
 */

/** @typedef {Record<OutcomeKind, number>} Stats */

/**
 * @typedef {Object} EnrichResult
 * @property {Row[]} rows
 * @property {Outcome[]} outcomes
 * @property {Row[]} done
 * @property {Row[]} todo
 * @property {Stats} stats
 */

/* ============ Types de la frontière API (seuls champs optionnels) ============ */

/** @typedef {{ siret?: string, code_postal?: string, libelle_commune?: string, numero_voie?: string, type_voie?: string, libelle_voie?: string, complement_adresse?: string, adresse?: string }} ApiSiege */
/** @typedef {{ siren?: string, nom_complet?: string, nom_raison_sociale?: string, etat_administratif?: string, siege?: ApiSiege }} ApiCompany */
/** @typedef {{ results?: ApiCompany[] }} ApiSearchResponse */

/* ========================= Numéros TVA / SIREN ========================= */

/** @param {string} v @returns {string} */
export function cleanVat(v) { return v.trim().replace(/[ \-.]/g, ""); }

/** Code pays ISO d'une TVA, ou "" si absent. @param {string} v @returns {string} */
export function vatCountryCode(v) {
  const m = cleanVat(v).match(/^([A-Za-z]{2})/);
  return m ? m[1].toUpperCase() : "";
}

/** SIREN d'une TVA française valide, ou "" sinon. @param {string} v @returns {string} */
export function frenchSirenFromVat(v) {
  const m = cleanVat(v).match(/^FR\d{2}(\d{9})$/i);
  return m ? m[1] : "";
}

/** Reconstruit la TVA FR depuis un SIREN (clé officielle), ou "" si invalide. @param {string} siren @returns {string} */
export function frenchVatFromSiren(siren) {
  if (!/^\d{9}$/.test(siren)) return "";
  const key = (12 + 3 * (Number(siren) % 97)) % 97;
  return "FR" + String(key).padStart(2, "0") + siren;
}

/** Normalise un nom pour comparaison stricte. @param {string} n @returns {string} */
export function normalizeName(n) {
  let s = n.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase();
  s = s.replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  for (const suffix of [" SARL", " SAS", " SASU", " SA", " EURL", " EI", " SCI", " ASSOCIATION"]) {
    if (s.endsWith(suffix)) { s = s.slice(0, -suffix.length).trim(); break; }
  }
  return s;
}

/* ============================ CSV (; séparé) ============================ */

/** @param {string} text @param {string} [delim=";"] @returns {string[][]} */
export function parseCsv(text, delim = ";") {
  /** @type {string[][]} */ const rows = [];
  let field = "", /** @type {string[]} */ row = [], i = 0, inQuotes = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); field = ""; row = []; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

/** @param {string} v @returns {string} */
export function csvField(v) {
  return /[";\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** @param {string[]} header @param {Row[]} rows @param {string} [delim=";"] @returns {string} */
export function serializeCsv(header, rows, delim = ";") {
  const lines = [header.map(csvField).join(delim)];
  for (const r of rows) lines.push(header.map(h => csvField(r[h])).join(delim));
  return lines.join("\r\n");
}

/* ===================== Colonnes & application des infos ===================== */

const COLUMN_SPECS = /** @type {const} */ ([
  ["nom", ["Nom"]], ["id", ["SIRET", "SIREN"]], ["tva", ["Numéro TVA", "Numero TVA", "TVA"]],
  ["adresse", ["Adresse"]], ["cp", ["Code postal"]], ["ville", ["Ville"]], ["pays", ["Pays"]]
]);
const COLUMN_LABELS = { nom: "Nom", id: "SIRET/SIREN", tva: "TVA", adresse: "Adresse", cp: "Code postal", ville: "Ville", pays: "Pays" };

/** @param {string[]} header @returns {ColumnsResult} */
export function detectColumns(header) {
  const pick = (/** @type {readonly string[]} */ names) => names.find(n => header.includes(n)) || "";
  /** @type {Record<string,string>} */ const found = {};
  /** @type {string[]} */ const missing = [];
  for (const [key, names] of COLUMN_SPECS) {
    const col = pick(names);
    if (col) found[key] = col; else missing.push(COLUMN_LABELS[key]);
  }
  if (missing.length) return { ok: false, missing };
  const columns = /** @type {Columns} */ ({
    nom: found.nom, id: found.id, idKind: found.id === "SIREN" ? "SIREN" : "SIRET",
    tva: found.tva, adresse: found.adresse, cp: found.cp, ville: found.ville, pays: found.pays
  });
  return { ok: true, columns };
}

/** @param {Columns} cols @param {CompanyInfo} info @returns {string} */
export function idValueForColumns(cols, info) {
  return cols.idKind === "SIREN" ? info.siren : info.siret;
}

/** @param {Row} row @param {Columns} cols @returns {boolean} */
export function isComplete(row, cols) {
  return Boolean(row[cols.id] && row[cols.adresse] && row[cols.cp] && row[cols.ville]);
}

/** @param {Row} row @param {Columns} cols @param {CompanyInfo} info @returns {void} */
export function applyInfo(row, cols, info) {
  if (!row[cols.id]) row[cols.id] = idValueForColumns(cols, info);
  if (!row[cols.adresse]) row[cols.adresse] = info.adresse;
  if (!row[cols.cp]) row[cols.cp] = info.code_postal;
  if (!row[cols.ville]) row[cols.ville] = info.ville;
}

/* ===================== Mapping des réponses API ===================== */

/** @param {string|undefined} v @returns {string} */
export function cleanApiValue(v) { return (!v || v === "[NON-DIFFUSIBLE]") ? "" : v; }

/** @param {ApiSiege} siege @returns {string} */
export function buildStreetAddress(siege) {
  const street = [cleanApiValue(siege.numero_voie), cleanApiValue(siege.type_voie), cleanApiValue(siege.libelle_voie)]
    .filter(Boolean).join(" ").trim();
  const comp = cleanApiValue(siege.complement_adresse);
  const withComp = comp ? (street + " " + comp).trim() : street;
  return withComp || cleanApiValue(siege.adresse);
}

/** @param {ApiCompany} match @returns {CompanyInfo} */
export function infoFromApiMatch(match) {
  const siege = match.siege || {};
  return {
    siren: cleanApiValue(match.siren),
    siret: cleanApiValue(siege.siret),
    adresse: buildStreetAddress(siege),
    code_postal: cleanApiValue(siege.code_postal),
    ville: cleanApiValue(siege.libelle_commune),
    nom_officiel: cleanApiValue(match.nom_complet)
  };
}

/* ===================== Clients réseau (défaut) ===================== */

/** @param {number} ms @returns {Promise<void>} */
export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Frontière JSON : seul endroit renvoyant `unknown`. @param {string} url @returns {Promise<unknown>} */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/**
 * Recherche plein texte : l'API peut renvoyer d'autres entreprises que celle
 * demandée. Seul un résultat portant EXACTEMENT ce SIREN est retenu ; sinon
 * « unconfirmed » (la ligne n'est jamais complétée avec le SIRET d'une autre
 * entreprise).
 * @param {string} siren @returns {Promise<SirenLookup>}
 */
export async function lookupSiren(siren) {
  const data = /** @type {ApiSearchResponse} */ (await fetchJson(`${API_URL}?q=${siren}`));
  const results = data.results || [];
  if (!results.length) return { status: "not_found" };
  const match = results.find(x => x.siren === siren);
  if (!match) return { status: "unconfirmed" };
  const info = infoFromApiMatch(match);
  return info.siret ? { status: "found", info } : { status: "protected" };
}

/** @param {string} nom @returns {Promise<NameLookup>} */
export async function lookupByName(nom) {
  const data = /** @type {ApiSearchResponse} */ (await fetchJson(`${API_URL}?q=${encodeURIComponent(nom)}&per_page=10`));
  const results = data.results || [];
  const target = normalizeName(nom);
  /** @type {Candidate[]} */ const candidates = [];
  /** @type {ApiCompany[]} */ const exact = [];
  for (const r of results) {
    if (r.etat_administratif !== "A") continue;
    const rn = r.nom_complet || r.nom_raison_sociale || "";
    candidates.push([rn, r.siren || "", (r.siege || {}).libelle_commune || ""]);
    if (normalizeName(rn) === target) exact.push(r);
  }
  const shortlist = candidates.slice(0, 5);
  if (exact.length !== 1) return { status: "ambiguous", candidates: shortlist };
  return { status: "match", info: infoFromApiMatch(exact[0]), candidates: shortlist };
}

/** @returns {Deps} */
export function defaultDeps() { return { lookupSiren, lookupByName, sleep }; }

/* ===================== Résolution d'une ligne ===================== */

/**
 * Cache (déduplication) + espacement après un appel réel.
 * @template R
 * @param {(...a: string[]) => Promise<R>} fn @param {(ms:number)=>Promise<void>} sleepFn @param {number} ms
 * @returns {(...a: string[]) => Promise<R>}
 */
function throttledMemo(fn, sleepFn, ms) {
  /** @type {Map<string, Promise<R>>} */ const cache = new Map();
  return (...args) => {
    const key = args.join(" ");
    const hit = cache.get(key);
    if (hit) return hit;
    const p = fn(...args).then(async value => { await sleepFn(ms); return value; });
    cache.set(key, p);
    return p;
  };
}

/** @param {Row} row @param {Columns} cols @param {string} nom @param {Deps} deps @returns {Promise<Outcome>} */
async function resolveByName(row, cols, nom, deps) {
  const res = await deps.lookupByName(nom);
  if (res.status === "ambiguous") return { kind: "ambiguous", candidates: res.candidates };
  applyInfo(row, cols, res.info);
  const vat = frenchVatFromSiren(res.info.siren);
  if (vat && !row[cols.tva]) row[cols.tva] = vat;
  row[cols.pays] = "FR";
  return { kind: "completed_name", siren: res.info.siren, nomOfficiel: res.info.nom_officiel || nom };
}

/** @param {Row} row @param {Columns} cols @param {string} siren @param {Deps} deps @returns {Promise<Outcome>} */
async function resolveFrench(row, cols, siren, deps) {
  const res = await deps.lookupSiren(siren);
  row[cols.pays] = "FR";
  switch (res.status) {
    case "found": applyInfo(row, cols, res.info); return { kind: "completed_fr" };
    case "protected": return { kind: "diffusion", siren };
    case "not_found": return { kind: "not_found", siren };
    case "unconfirmed": return { kind: "unconfirmed", siren };
  }
}

/**
 * Fournisseur étranger : on corrige seulement le code pays. L'adresse (VIES)
 * n'est PAS récupérable en ligne → à faire via la version téléchargeable.
 * @param {Row} row @param {Columns} cols @param {string} vat @returns {Outcome}
 */
function resolveForeign(row, cols, vat) {
  const cc = vatCountryCode(vat);
  if (cc && cc !== "FR") row[cols.pays] = cc;
  const inEu = cc !== "" && cc !== "FR" && EU_COUNTRIES.has(cc);
  return { kind: "foreign", cc, inEu };
}

/** Résout UNE ligne (mutation) et renvoie son issue. @param {Row} row @param {Columns} cols @param {Deps} deps @returns {Promise<Outcome>} */
export async function resolveRow(row, cols, deps) {
  if (isComplete(row, cols)) return { kind: "already" };
  const nom = (row[cols.nom] || "").trim();
  if (isGenericLabel(nom)) return { kind: "generic" };

  const rawVat = (row[cols.tva] || "").trim();
  if (!rawVat) return resolveByName(row, cols, nom, deps);

  const vat = cleanVat(rawVat);
  if (vat !== rawVat) row[cols.tva] = vat;
  const siren = frenchSirenFromVat(vat);
  return siren ? resolveFrench(row, cols, siren, deps) : resolveForeign(row, cols, vat);
}

/* ===================== Orchestration & agrégation ===================== */

/** @returns {Stats} */
export function emptyStats() {
  const s = /** @type {Stats} */ ({});
  for (const k of OUTCOME_KINDS) s[k] = 0;
  return s;
}

/** @param {Row[]} rows @param {Outcome[]} outcomes @returns {EnrichResult} */
export function summarize(rows, outcomes) {
  /** @type {Row[]} */ const done = [];
  /** @type {Row[]} */ const todo = [];
  const stats = emptyStats();
  outcomes.forEach((o, i) => {
    stats[o.kind]++;
    (COMPLETED_KINDS.has(o.kind) ? done : todo).push(rows[i]);
  });
  return { rows, outcomes, done, todo, stats };
}

/**
 * Complète toutes les lignes (appels réseau espacés & dédupliqués).
 * @param {Row[]} rows @param {Columns} cols
 * @param {Partial<Deps>} [overrides]
 * @param {(processed:number, total:number)=>void} [onProgress]
 * @returns {Promise<EnrichResult>}
 */
export async function enrichRows(rows, cols, overrides, onProgress = () => {}) {
  const base = { ...defaultDeps(), ...(overrides || {}) };
  /** @type {Deps} */ const deps = {
    lookupSiren: throttledMemo(base.lookupSiren, base.sleep, SLEEP_MS),
    lookupByName: throttledMemo(base.lookupByName, base.sleep, SLEEP_MS),
    sleep: base.sleep
  };
  /** @type {Outcome[]} */ const outcomes = [];
  for (let i = 0; i < rows.length; i++) {
    /** @type {Outcome} */ let outcome;
    try { outcome = await resolveRow(rows[i], cols, deps); }
    catch (e) { outcome = { kind: "error", message: e instanceof Error ? e.message : String(e) }; }
    outcomes.push(outcome);
    onProgress(i + 1, rows.length);
  }
  return summarize(rows, outcomes);
}
