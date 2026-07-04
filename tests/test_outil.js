// @ts-check
/*
 * Tests de docs/outil.core.js (bibliothèque pure de l'outil web).
 * Sans dépendance :  node tests/test_outil.js
 * Les appels réseau sont injectés (aucune requête réelle).
 */
import assert from "node:assert/strict";
import * as M from "../docs/outil.core.js";

const noop = async () => {};
const HDR = (/** @type {string} */ idCol) =>
  ["ID", "Type", "Nom", idCol, "Numéro TVA", "Adresse", "Code postal", "Ville", "Pays", "Ret"];
/** @param {string[]} header @returns {M.Columns} */
const columnsOf = header => {
  const r = M.detectColumns(header);
  if (!r.ok) throw new Error("colonnes manquantes : " + r.missing.join(", "));
  return r.columns;
};
const COLS_SIRET = columnsOf(HDR("SIRET"));
const COLS_SIREN = columnsOf(HDR("SIREN"));
const mkRow = (/** @type {string[]} */ header, /** @type {Record<string,string>} */ vals) => {
  /** @type {Record<string,string>} */ const o = {};
  header.forEach(h => { o[h] = vals[h] !== undefined ? vals[h] : ""; });
  return o;
};
const FR_INFO = { siren: "303265045", siret: "30326504500017", adresse: "12 RUE X",
  code_postal: "75001", ville: "PARIS", nom_officiel: "ACME" };
/** @type {M.SirenLookup} */ const SIREN_FOUND = { status: "found", info: FR_INFO };

let passed = 0, failed = 0;
async function test(/** @type {string} */ name, /** @type {() => any} */ fn) {
  try { await fn(); console.log("ok   " + name); passed++; }
  catch (e) { console.error("FAIL " + name + " → " + (e && e.message)); failed++; }
}

/* ------------------------------ Fonctions pures ------------------------------ */
await test("frenchVatFromSiren : clé de contrôle, \"\" si invalide", () => {
  assert.equal(M.frenchVatFromSiren("303265045"), "FR40303265045");
  assert.equal(M.frenchVatFromSiren("123"), "");
});
await test("cleanVat / frenchSirenFromVat (\"\" si non FR) / vatCountryCode / vatLocalPart", () => {
  assert.equal(M.cleanVat(" fr 40-303.265045 "), "fr40303265045");
  assert.equal(M.frenchSirenFromVat("FR40303265045"), "303265045");
  assert.equal(M.frenchSirenFromVat("IE9692928F"), "");
  assert.equal(M.vatCountryCode("IE9692928F"), "IE");
  assert.equal(M.vatCountryCode("123456"), "");
  assert.equal(M.vatLocalPart("IE9692928F", "IE"), "9692928F");
});
await test("normalizeName (accents + forme juridique)", () => {
  assert.equal(M.normalizeName("Éléctric SARL"), "ELECTRIC");
  assert.equal(M.normalizeName("ACME SAS"), "ACME");
});
await test("detectColumns : union ok/missing (jamais null)", () => {
  assert.equal(COLS_SIRET.idKind, "SIRET");
  assert.equal(COLS_SIREN.idKind, "SIREN");
  const bad = M.detectColumns(["Nom", "Adresse"]);
  assert.equal(bad.ok, false);
  assert.equal(bad.ok === false && bad.missing.includes("TVA"), true);
});
await test("infoFromApiMatch + NON-DIFFUSIBLE -> \"\"", () => {
  const info = M.infoFromApiMatch({ siren: "1", nom_complet: "X",
    siege: { siret: "[NON-DIFFUSIBLE]", numero_voie: "12", type_voie: "RUE", libelle_voie: "X",
      code_postal: "75001", libelle_commune: "PARIS" } });
  assert.equal(info.siret, "");
  assert.equal(info.adresse, "12 RUE X");
});
await test("parseCsv / serializeCsv round-trip (; + guillemets + vide)", () => {
  const header = ["Nom", "SIRET", "Adresse"];
  const rows = [{ Nom: "A;B", SIRET: "123", Adresse: "" }, { Nom: 'C"D', SIRET: "", Adresse: "Rue X" }];
  const parsed = M.parseCsv(M.serializeCsv(header, rows, ";"), ";");
  assert.deepEqual(parsed[0], header);
  assert.deepEqual(parsed[1], ["A;B", "123", ""]);
  assert.deepEqual(parsed[2], ['C"D', "", "Rue X"]);
});

/* ------------------------- enrichRows : pipeline complet ------------------------- */
await test("FR : SIRET (14 chiffres) — issue completed_fr", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "ACME FR", "Numéro TVA": "FR40303265045", Pays: "FR" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => SIREN_FOUND, sleep: noop });
  assert.equal(res.stats.completed_fr, 1);
  assert.equal(res.outcomes[0].kind, "completed_fr");
  assert.equal(row["SIRET"], "30326504500017");
  assert.equal(row["Adresse"], "12 RUE X");
});
await test("Clients : SIREN (9 chiffres) dans une colonne SIREN", async () => {
  const row = mkRow(HDR("SIREN"), { Nom: "ACME FR", "Numéro TVA": "FR40303265045", Pays: "FR" });
  await M.enrichRows([row], COLS_SIREN, { lookupSiren: async () => SIREN_FOUND, sleep: noop });
  assert.equal(row["SIREN"], "303265045");
});
await test("SIREN protégé -> issue diffusion", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "EI X", "Numéro TVA": "FR40303265045" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => ({ status: "protected" }), sleep: noop });
  assert.equal(res.stats.diffusion, 1);
});
await test("SIREN introuvable -> issue not_found", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "Y", "Numéro TVA": "FR40303265045" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => ({ status: "not_found" }), sleep: noop });
  assert.equal(res.stats.not_found, 1);
});
await test("Sans TVA : match unique -> completed_name + TVA reconstruite", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "ACME" });
  const res = await M.enrichRows([row], COLS_SIRET,
    { lookupByName: async () => ({ status: "match", info: FR_INFO, candidates: [["ACME", "303265045", "PARIS"]] }), sleep: noop });
  assert.equal(res.stats.completed_name, 1);
  assert.equal(row["Numéro TVA"], "FR40303265045");
  assert.equal(row["Pays"], "FR");
});
await test("Sans TVA : ambigu -> issue ambiguous avec candidats", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "MARTIN" });
  const res = await M.enrichRows([row], COLS_SIRET,
    { lookupByName: async () => ({ status: "ambiguous", candidates: [["MARTIN SARL", "111", "PARIS"], ["MARTIN SAS", "222", "LYON"]] }), sleep: noop });
  const o = res.outcomes[0];
  assert.equal(o.kind, "ambiguous");
  assert.equal(o.kind === "ambiguous" && o.candidates.length, 2);
});
await test("Libellé générique : issue generic, sans aucun appel", async () => {
  let calls = 0;
  const row = mkRow(HDR("SIRET"), { Nom: "Taxi", "Numéro TVA": "FR40303265045" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => { calls++; return SIREN_FOUND; }, sleep: noop });
  assert.equal(res.stats.generic, 1);
  assert.equal(calls, 0);
});
await test("Ligne déjà complète : issue already, sans appel", async () => {
  let calls = 0;
  const row = mkRow(HDR("SIRET"), { Nom: "ACME", SIRET: "30326504500017",
    "Numéro TVA": "FR40303265045", Adresse: "12 RUE X", "Code postal": "75001", Ville: "PARIS", Pays: "FR" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => { calls++; return SIREN_FOUND; }, sleep: noop });
  assert.equal(res.stats.already, 1);
  assert.equal(calls, 0);
});
await test("Europe : VIES réussit -> completed_vies + adresse", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "Meta", "Numéro TVA": "IE9692928F", Pays: "IE" });
  const res = await M.enrichRows([row], COLS_SIRET,
    { lookupVies: async () => ({ valide: true, nom_officiel: "META", adresse: "4 GRAND CANAL", code_postal: "", ville: "DUBLIN" }), sleep: noop });
  assert.equal(res.stats.completed_vies, 1);
  assert.equal(row["Adresse"], "4 GRAND CANAL");
});
await test("Europe : VIES bloqué -> foreign(viesError) + viesBlocked + pays corrigé", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "Meta", "Numéro TVA": "IE9692928F", Pays: "FR" });
  const res = await M.enrichRows([row], COLS_SIRET, { lookupVies: async () => { throw new Error("CORS"); }, sleep: noop });
  assert.equal(res.stats.foreign, 1);
  assert.equal(res.viesBlocked, true);
  const o = res.outcomes[0];
  assert.equal(o.kind === "foreign" && o.viesError, true);
  assert.equal(row["Pays"], "IE");
});
await test("TVA mal formatée -> normalisée dans la ligne", async () => {
  const row = mkRow(HDR("SIRET"), { Nom: "X", "Numéro TVA": "FR40 303.265045", Pays: "FR" });
  await M.enrichRows([row], COLS_SIRET, { lookupSiren: async () => SIREN_FOUND, sleep: noop });
  assert.equal(row["Numéro TVA"], "FR40303265045");
});
await test("Déduplication : deux lignes même SIREN -> un seul appel", async () => {
  let calls = 0;
  const rows = [
    mkRow(HDR("SIRET"), { Nom: "A", "Numéro TVA": "FR40303265045" }),
    mkRow(HDR("SIRET"), { Nom: "B", "Numéro TVA": "FR40303265045" })
  ];
  await M.enrichRows(rows, COLS_SIRET, { lookupSiren: async () => { calls++; return SIREN_FOUND; }, sleep: noop });
  assert.equal(calls, 1);
});
await test("onProgress appelé pour chaque ligne", async () => {
  let n = 0;
  const rows = [mkRow(HDR("SIRET"), { Nom: "Taxi" }), mkRow(HDR("SIRET"), { Nom: "Parking" })];
  await M.enrichRows(rows, COLS_SIRET, { sleep: noop }, () => { n++; });
  assert.equal(n, 2);
});

console.log(`\n${passed} réussis, ${failed} échoués`);
process.exit(failed ? 1 : 0);
