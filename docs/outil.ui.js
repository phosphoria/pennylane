// @ts-check
/**
 * outil.ui.js — Contrôleur d'interface (DOM) de l'outil en ligne.
 *
 * Aucune logique métier : importe la bibliothèque pure `outil.core.js`,
 * orchestre l'UI et traduit les {@link Outcome} en HTML. Les seuls `null`
 * résiduels proviennent d'API navigateur (DataTransfer, FileList) et sont
 * neutralisés par des gardes ; l'état applicatif est une union `ready`.
 */
import { parseCsv, serializeCsv, detectColumns, enrichRows, ANNUAIRE_URL } from "./outil.core.js";

/** @typedef {import("./outil.core.js").Columns} Columns */
/** @typedef {import("./outil.core.js").Row} Row */
/** @typedef {import("./outil.core.js").Outcome} Outcome */
/** @typedef {import("./outil.core.js").EnrichResult} EnrichResult */

/** Récupère un élément requis (lève si absent → jamais null en aval). @param {string} id @returns {HTMLElement} */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Élément #${id} introuvable`);
  return node;
}

/** @param {string} s @returns {string} */
const escapeHtml = s => s.replace(/[&<>]/g, c => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));

/** État applicatif (union : jamais null). @typedef {{ ready: false } | { ready: true, header: string[], rows: Row[], cols: Columns, name: string }} AppState */
/** @type {AppState} */
let state = { ready: false };

/* ----------------------------- Chargement ----------------------------- */

/** @param {string} msg @returns {void} */
function showError(msg) { const e = el("error"); e.textContent = msg; e.classList.remove("hidden"); }

/** @param {string} text @param {string} name @returns {void} */
function loadCsv(text, name) {
  const grid = parseCsv(text, ";");
  if (grid.length < 2) { showError("Fichier vide ou illisible."); return; }
  const header = grid[0];
  const analysis = detectColumns(header);
  if (!analysis.ok) {
    showError("Colonnes manquantes : " + analysis.missing.join(", ") +
      ". La colonne d'identifiant doit s'appeler « SIRET » ou « SIREN ».");
    return;
  }
  const cols = analysis.columns;
  const rows = grid.slice(1).map(cells => {
    /** @type {Row} */ const o = {};
    header.forEach((h, i) => { o[h] = cells[i] !== undefined ? cells[i] : ""; });
    return o;
  });
  state = { ready: true, header, rows, cols, name };
  el("error").classList.add("hidden");
  el("fileinfo").innerHTML = `<b>${rows.length}</b> lignes · identifiant : <code>${escapeHtml(cols.id)}</code>`;
  el("run").removeAttribute("disabled");
  el("results").classList.add("hidden");
}

/* ------------------------------ Traitement ------------------------------ */

async function run() {
  if (!state.ready) return;
  const current = state;
  // Instantané AVANT complétion (enrichRows mute les lignes) -> permet l'avant/après.
  const before = current.rows.map(r => ({ ...r }));
  el("run").setAttribute("disabled", "true");
  el("progwrap").classList.remove("hidden");
  el("results").classList.add("hidden");

  const result = await enrichRows(current.rows, current.cols, undefined, (processed, total) => {
    /** @type {HTMLProgressElement} */ (el("prog")).value = Math.round((processed / total) * 100);
    el("progtxt").textContent = `${processed} / ${total} lignes traitées…`;
  });

  renderResults(result, current, before);
}

/* -------------------------------- Rendu -------------------------------- */

/** @param {EnrichResult} result @param {{ header: string[], rows: Row[], cols: Columns, name: string }} ctx @param {Row[]} before @returns {void} */
function renderResults(result, ctx, before) {
  const { done, todo, stats, outcomes } = result;
  el("progwrap").classList.add("hidden");

  const completed = stats.already + stats.completed_fr + stats.completed_name;
  const toVerify = stats.diffusion + stats.not_found + stats.ambiguous + stats.generic + stats.error;
  /** @type {[string, number, string][]} */
  const cards = [
    ["g", completed, "Complétées (prêtes à réimporter)"],
    ["o", stats.foreign, "Étrangers (à finir hors ligne)"],
    ["o", toVerify, "À vérifier / ignorées"]
  ];
  el("stats").innerHTML = cards
    .map(([cls, n, label]) => `<div class="stat ${cls}"><div class="n">${n}</div><small>${label}</small></div>`)
    .join("");

  renderForeignNote(stats.foreign > 0);

  const detail = renderDetail(outcomes, ctx, before);
  el("todoDetails").classList.toggle("hidden", detail === "");
  el("todoList").innerHTML = detail;

  el("results").classList.remove("hidden");
  el("run").removeAttribute("disabled");
  el("status").textContent = "Terminé ✓";

  const base = ctx.name.replace(/\.csv$/i, "") || "pennylane";
  el("dlDone").onclick = () => download(base + ".complete.csv", serializeCsv(ctx.header, done));
  const dlTodo = /** @type {HTMLButtonElement} */ (el("dlTodo"));
  dlTodo.onclick = () => download(base + ".a_traiter.csv", serializeCsv(ctx.header, todo));
  dlTodo.disabled = todo.length === 0;
}

/** @param {boolean} anyForeign @returns {void} */
function renderForeignNote(anyForeign) {
  const fn = el("foreignNote");
  if (!anyForeign) { fn.classList.add("hidden"); return; }
  fn.innerHTML = "🌍 <b>Les fournisseurs étrangers ne sont pas complétés en ligne.</b> " +
    "VIES (Commission européenne) n'autorise pas les appels depuis un navigateur (restriction CORS de leur côté) : " +
    "seul le code pays a été corrigé. Pour récupérer les adresses européennes, utilisez la " +
    "<a href=\"telecharger.html\">version à télécharger</a>.";
  fn.classList.remove("hidden");
}

/** @param {string} siren @param {string} label @returns {string} */
const verifyLink = (siren, label) =>
  `<a href="${ANNUAIRE_URL}${encodeURIComponent(siren)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;

/** Groupes du détail, dans l'ordre d'affichage. @typedef {{ title: string, emoji: string, kinds: string[], diff?: boolean }} DetailGroup */
/** @type {DetailGroup[]} */
const DETAIL_GROUPS = [
  { title: "Complété par nom", emoji: "✅", kinds: ["completed_name"], diff: true },
  { title: "Libellé générique ignoré", emoji: "🏷️", kinds: ["generic"] },
  { title: "Étranger", emoji: "🌍", kinds: ["foreign"] },
  { title: "Sans TVA, à vérifier", emoji: "🔎", kinds: ["ambiguous"] },
  { title: "Introuvable / protégé", emoji: "❓", kinds: ["not_found", "diffusion"] },
  { title: "Erreur réseau", emoji: "⚠️", kinds: ["error"] }
];

/**
 * Construit le détail des lignes, regroupé par catégorie (ordre {@link DETAIL_GROUPS}).
 * @param {Outcome[]} outcomes @param {{ rows: Row[], cols: Columns }} ctx @param {Row[]} before @returns {string}
 */
function renderDetail(outcomes, ctx, before) {
  const parts = [];
  for (const g of DETAIL_GROUPS) {
    /** @type {string[]} */ const items = [];
    outcomes.forEach((o, i) => {
      if (!g.kinds.includes(o.kind)) return;
      const nom = ctx.rows[i][ctx.cols.nom] || "";
      const extra = g.diff ? renderBeforeAfter(before[i], ctx.rows[i], ctx.cols) : "";
      items.push(itemLine(o, nom, extra));
    });
    if (items.length) {
      parts.push(`<div class="grp"><div class="grp-h">${g.emoji} ${escapeHtml(g.title)}` +
        ` <span class="grp-n">${items.length}</span></div>${items.join("")}</div>`);
    }
  }
  return parts.join("");
}

/**
 * Une ligne du détail (donnée externe échappée). `extra` = bloc avant/après optionnel.
 * @param {Outcome} o @param {string} nom @param {string} extra @returns {string}
 */
function itemLine(o, nom, extra) {
  const b = `<b>${escapeHtml(nom)}</b>`;
  let text;
  switch (o.kind) {
    case "completed_name": text = `${b} → ${verifyLink(o.siren, `SIREN ${o.siren}`)}`; break;
    case "generic": text = b; break;
    case "foreign": text = `${b} <span class="mut">(${escapeHtml(o.cc) || "?"} — ${o.inEu ? "UE, adresse via la version à télécharger" : "hors UE"})</span>`; break;
    case "diffusion": text = `${b} <span class="mut">(SIREN ${escapeHtml(o.siren)} — diffusion partielle)</span>`; break;
    case "not_found": text = `${b} <span class="mut">(SIREN ${escapeHtml(o.siren)} — introuvable)</span>`; break;
    case "error": text = `${b} <span class="mut">(${escapeHtml(o.message)})</span>`; break;
    case "ambiguous": {
      const lines = o.candidates.filter(c => c[0]).map(c =>
        `<div class="cand">${escapeHtml(c[0])} — SIREN ${escapeHtml(c[1])}, ${escapeHtml(c[2])} — ${verifyLink(c[1], "voir")}</div>`).join("");
      text = `${b}${lines}`; break;
    }
    default: text = b;
  }
  return `<div class="todo">${text}${extra}</div>`;
}

/**
 * Bloc « voir avant / après » listant les champs modifiés. @param {Row} beforeRow @param {Row} afterRow @param {Columns} cols @returns {string}
 */
function renderBeforeAfter(beforeRow, afterRow, cols) {
  /** @type {[string, string][]} */
  const fields = [[cols.id, cols.idKind], [cols.tva, "TVA"], [cols.adresse, "Adresse"],
    [cols.cp, "Code postal"], [cols.ville, "Ville"], [cols.pays, "Pays"]];
  const lines = [];
  for (const [col, label] of fields) {
    const bv = beforeRow[col] || "", av = afterRow[col] || "";
    if (bv !== av) {
      lines.push(`<div class="ba-row"><span class="ba-l">${escapeHtml(label)}</span>` +
        `<span class="ba-b">${bv ? escapeHtml(bv) : "(vide)"}</span><span class="ba-arrow">→</span>` +
        `<span class="ba-a">${escapeHtml(av)}</span></div>`);
    }
  }
  return lines.length ? `<details class="ba"><summary>voir avant / après</summary>${lines.join("")}</details>` : "";
}

/** @param {string} name @param {string} text @returns {void} */
function download(name, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------ Câblage ------------------------------ */

/** @param {File} file @returns {void} */
function readFile(file) {
  const reader = new FileReader();
  reader.onload = () => loadCsv(String(reader.result), file.name);
  reader.readAsText(file, "utf-8");
}

const drop = el("drop"), fileInput = /** @type {HTMLInputElement} */ (el("file"));
drop.onclick = () => fileInput.click();
drop.ondragover = (/** @type {DragEvent} */ e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (/** @type {DragEvent} */ e) => {
  e.preventDefault(); drop.classList.remove("over");
  const files = e.dataTransfer ? e.dataTransfer.files : undefined;
  if (files && files[0]) readFile(files[0]);
};
fileInput.onchange = () => { const f = fileInput.files; if (f && f[0]) readFile(f[0]); };
el("run").onclick = run;
