// @ts-check
/**
 * outil.core.js — Bibliothèque PURE de complétion des exports Pennylane.
 *
 * Aucun accès au DOM : tout est testable en Node. Chaque ligne produit
 * exactement UN {@link Outcome} (union discriminée). Les états illégaux ne sont
 * pas représentables.
 *
 * Discipline de typage : pas de `null`, ni de valeur `undefined`/`unknown`/`any`
 * qui « fuit » dans le code métier. Les absences sont modélisées par des unions
 * discriminées (statuts) ou la chaîne vide `""`. Le SEUL point où subsistent des
 * champs optionnels et un `unknown`, c'est la frontière avec le JSON des API
 * (types `Api*` ci-dessous), immédiatement converti en modèle propre.
 */

/* ============================== Constantes ============================== */

export const API_URL = "https://recherche-entreprises.api.gouv.fr/search";
export const VIES_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/ms";
export const ANNUAIRE_URL = "https://annuaire-entreprises.data.gouv.fr/entreprise/";
export const SLEEP_MS = 160;
export const VIES_TIMEOUT = 8000;

/** @type {ReadonlySet<string>} */
export const EU_COUNTRIES = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","EL","GR",
  "ES","FI","FR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK","XI"]);

/** @type {ReadonlySet<string>} */
export const GENERIC_LABELS = new Set(["Hôtels","Hotels","Parking","Restaurants","Taxi","Taxis",
  "Transport","Transports","Autre","Autres","FOURNISSEURS DIVERS","DIVERS - FR","DIVERS",
  "Frais bancaires","Frais de mission","Notes de frais","Péage","Peage","Carburant","Essence",
  "Pourboire","Pourboires"]);

/** @type {readonly OutcomeKind[]} */
export const OUTCOME_KINDS = [
  "already", "completed_fr", "completed_name", "completed_vies",
  "generic", "diffusion", "not_found", "ambiguous", "foreign", "error"
];

/** @type {ReadonlySet<string>} */
export const COMPLETED_KINDS = new Set(["already", "completed_fr", "completed_name", "completed_vies"]);

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

/** @typedef {Record<string,string>} Row  Ligne CSV : colonne → valeur (toujours des chaînes). */

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

/**
 * @typedef {Object} ViesResult
 * @property {boolean} valide
 * @property {string} nom_officiel
 * @property {string} adresse
 * @property {string} code_postal
 * @property {string} ville
 */

/** Résultat d'une détection de colonnes (jamais null). @typedef {{ ok: true, columns: Columns } | { ok: false, missing: string[] }} ColumnsResult */

/** Résultat d'une recherche par SIREN (jamais null). @typedef {{ status: "found", info: CompanyInfo } | { status: "protected" } | { status: "not_found" }} SirenLookup */

/** Résultat d'une recherche par nom (jamais null). @typedef {{ status: "match", info: CompanyInfo, candidates: Candidate[] } | { status: "ambiguous", candidates: Candidate[] }} NameLookup */

/**
 * Dépendances réseau injectables (tests sans requête réelle).
 * @typedef {Object} Deps
 * @property {(siren:string)=>Promise<SirenLookup>} lookupSiren
 * @property {(nom:string)=>Promise<NameLookup>} lookupByName
 * @property {(cc:string, num:string)=>Promise<ViesResult>} lookupVies
 * @property {(ms:number)=>Promise<void>} sleep
 */

/** @typedef {Outcome["kind"]} OutcomeKind */

/**
 * Issue d'UNE ligne — union discriminée : chaque variante ne porte que ses données.
 * @typedef {(
 *   | { kind: "already" }
 *   | { kind: "generic" }
 *   | { kind: "completed_fr" }
 *   | { kind: "completed_name", siren: string, nomOfficiel: string }
 *   | { kind: "completed_vies", cc: string }
 *   | { kind: "diffusion", siren: string }
 *   | { kind: "not_found", siren: string }
 *   | { kind: "ambiguous", candidates: Candidate[] }
 *   | { kind: "foreign", cc: string, inEu: boolean, viesError: boolean }
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
 * @property {boolean} viesBlocked
 */

/* ============ Types de la frontière API (seuls champs optionnels) ============ */

/** @typedef {{ siret?: string, code_postal?: string, libelle_commune?: string, numero_voie?: string, type_voie?: string, libelle_voie?: string, complement_adresse?: string, adresse?: string }} ApiSiege */
/** @typedef {{ siren?: string, nom_complet?: string, nom_raison_sociale?: string, etat_administratif?: string, siege?: ApiSiege }} ApiCompany */
/** @typedef {{ results?: ApiCompany[] }} ApiSearchResponse */
/** @typedef {{ isValid?: boolean, name?: string, address?: string }} ViesResponse */

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

/** Partie du numéro après le code pays (pour VIES). @param {string} v @param {string} cc @returns {string} */
export function vatLocalPart(v, cc) {
  v = cleanVat(v);
  return v.toUpperCase().startsWith(cc) ? v.slice(cc.length) : v;
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
/** Étiquettes lisibles pour le message d'erreur. */
const COLUMN_LABELS = { nom: "Nom", id: "SIRET/SIREN", tva: "TVA", adresse: "Adresse", cp: "Code postal", ville: "Ville", pays: "Pays" };

/**
 * Détecte les colonnes utiles. Renvoie un résultat discriminé (jamais null).
 * @param {string[]} header @returns {ColumnsResult}
 */
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

/** Remplit les champs vides avec une CompanyInfo (mutation). @param {Row} row @param {Columns} cols @param {CompanyInfo} info @returns {void} */
export function applyInfo(row, cols, info) {
  if (!row[cols.id]) row[cols.id] = idValueForColumns(cols, info);
  if (!row[cols.adresse]) row[cols.adresse] = info.adresse;
  if (!row[cols.cp]) row[cols.cp] = info.code_postal;
  if (!row[cols.ville]) row[cols.ville] = info.ville;
}

/** Remplit adresse/CP/ville depuis un résultat VIES (mutation). @param {Row} row @param {Columns} cols @param {ViesResult} v @returns {void} */
export function applyViesInfo(row, cols, v) {
  if (!row[cols.adresse]) row[cols.adresse] = v.adresse;
  if (!row[cols.cp] && v.code_postal) row[cols.cp] = v.code_postal;
  if (!row[cols.ville] && v.ville) row[cols.ville] = v.ville;
}

/* ===================== Mapping des réponses API ===================== */

/** Traite absence / « [NON-DIFFUSIBLE] » comme "". @param {string|undefined} v @returns {string} */
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

/** Frontière JSON : seul endroit renvoyant `unknown` (converti aussitôt). @param {string} url @returns {Promise<unknown>} */
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

/** @param {string} siren @returns {Promise<SirenLookup>} */
export async function lookupSiren(siren) {
  const data = /** @type {ApiSearchResponse} */ (await fetchJson(`${API_URL}?q=${siren}`));
  const results = data.results || [];
  if (!results.length) return { status: "not_found" };
  const info = infoFromApiMatch(results.find(x => x.siren === siren) || results[0]);
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

/** @param {string} cc @param {string} num @returns {Promise<ViesResult>} */
export async function lookupVies(cc, num) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VIES_TIMEOUT);
  try {
    const r = await fetch(`${VIES_URL}/${cc}/vat/${encodeURIComponent(num)}`,
      { signal: ctrl.signal, headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = /** @type {ViesResponse} */ (await r.json());
    const name = d.name === "---" ? "" : (d.name || "");
    const address = d.address === "---" ? "" : (d.address || "");
    let code_postal = "", ville = "";
    const m = address.match(/\b(\d{4,6})\b\s*,?\s*([A-ZÀ-Ÿ' \-]+)/);
    if (m) { code_postal = m[1]; ville = m[2].trim().replace(/,+$/, "").trim(); }
    return { valide: Boolean(d.isValid), nom_officiel: name, adresse: address, code_postal, ville };
  } finally { clearTimeout(timer); }
}

/** @returns {Deps} */
export function defaultDeps() { return { lookupSiren, lookupByName, lookupVies, sleep }; }

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
  }
}

/** @param {Row} row @param {Columns} cols @param {string} vat @param {Deps} deps @returns {Promise<Outcome>} */
async function resolveForeign(row, cols, vat, deps) {
  const cc = vatCountryCode(vat);
  if (cc && cc !== "FR") row[cols.pays] = cc;
  const inEu = cc !== "" && cc !== "FR" && EU_COUNTRIES.has(cc);
  if (!inEu) return { kind: "foreign", cc, inEu: false, viesError: false };
  try {
    const vies = await deps.lookupVies(cc, vatLocalPart(vat, cc));
    if (vies.nom_officiel && vies.adresse) { applyViesInfo(row, cols, vies); return { kind: "completed_vies", cc }; }
    return { kind: "foreign", cc, inEu: true, viesError: false };
  } catch {
    return { kind: "foreign", cc, inEu: true, viesError: true };
  }
}

/** Résout UNE ligne (mutation) et renvoie son issue. @param {Row} row @param {Columns} cols @param {Deps} deps @returns {Promise<Outcome>} */
export async function resolveRow(row, cols, deps) {
  if (isComplete(row, cols)) return { kind: "already" };
  const nom = (row[cols.nom] || "").trim();
  if (GENERIC_LABELS.has(nom)) return { kind: "generic" };

  const rawVat = (row[cols.tva] || "").trim();
  if (!rawVat) return resolveByName(row, cols, nom, deps);

  const vat = cleanVat(rawVat);
  if (vat !== rawVat) row[cols.tva] = vat;
  const siren = frenchSirenFromVat(vat);
  return siren ? resolveFrench(row, cols, siren, deps) : resolveForeign(row, cols, vat, deps);
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
  let viesBlocked = false;
  outcomes.forEach((o, i) => {
    stats[o.kind]++;
    (COMPLETED_KINDS.has(o.kind) ? done : todo).push(rows[i]);
    if (o.kind === "foreign" && o.viesError) viesBlocked = true;
  });
  return { rows, outcomes, done, todo, stats, viesBlocked };
}

/**
 * Complète toutes les lignes (appels réseau espacés & dédupliqués).
 * @param {Row[]} rows @param {Columns} cols
 * @param {Partial<Deps>} [overrides]  Surcharge des dépendances (tests)
 * @param {(processed:number, total:number)=>void} [onProgress]
 * @returns {Promise<EnrichResult>}
 */
export async function enrichRows(rows, cols, overrides, onProgress = () => {}) {
  const base = { ...defaultDeps(), ...(overrides || {}) };
  /** @type {Deps} */ const deps = {
    lookupSiren: throttledMemo(base.lookupSiren, base.sleep, SLEEP_MS),
    lookupByName: throttledMemo(base.lookupByName, base.sleep, SLEEP_MS),
    lookupVies: throttledMemo(base.lookupVies, base.sleep, SLEEP_MS),
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
