// Rendu de la consommation (ADR 0012, points 4 et 5). Module pur : aucune I/O.
// Texte : trois tableaux ; JSON : le rapport v1 tel quel.
"use strict";

const EMPTY = "aucune consommation trouvée";
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Entier exact groupé par une espace : 1234567 devient « 1 234 567 ». */
function formatInt(n) {
  const v = Number.isFinite(n) ? Math.trunc(n) : 0;
  return (v < 0 ? "-" : "") + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** Tableau aligné : première colonne à gauche, les autres à droite. */
function table(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
  const line = (r) =>
    r.map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i]))).join(" | ");
  return [line(headers), widths.map((w) => "-".repeat(w)).join("-|-"), ...rows.map(line)].join("\n");
}

function counters(u) {
  return [formatInt(u.input), formatInt(u.output), formatInt(u.cacheRead), formatInt(u.cacheWrite), formatInt(u.total)];
}

/** Plus haute tentative connue des agents d'une feature ; « - » si aucune. */
function attemptsOf(report, issue) {
  const values = report.agents.filter((a) => a.issue === issue && Number.isInteger(a.attempt)).map((a) => a.attempt);
  return values.length ? String(Math.max(...values)) : "-";
}

function warningLines(report) {
  return report.warnings.length ? ["Avertissements", ...report.warnings.map((w) => `- ${w.code} : ${w.message}`)] : [];
}

/**
 * Rendu texte d'un rapport v1.
 * @param {object} report sortie de aggregate()
 * @param {{focus?: string|null}} [options] focus : le rapport a été restreint à ce milestone ; le
 *   troisième tableau montre alors la part du CP de ce milestone, sans lignes hors feature ni non attribué.
 */
function formatText(report, { focus = null } = {}) {
  const out = [`Consommation en tokens bruts, générée le ${report.generatedAt}`];
  if (focus) out.push(`Milestone : ${focus}`);
  if (report.totals.total === 0 && report.totals.messages === 0) {
    out.push("", EMPTY);
    if (report.warnings.length) out.push("", ...warningLines(report));
    return out.join("\n") + "\n";
  }

  const cpPart = (titre) => report.cp.parMilestone.find((p) => p.milestone === titre);
  const msRows = report.milestones.map((m) => {
    const agents = report.features.filter((f) => f.milestone === m.titre).reduce((s, f) => s + f.agents, 0);
    const cp = cpPart(m.titre);
    return [m.titre, formatInt(agents), formatInt(cp ? cp.usage.total : 0), ...counters(m.usage)];
  });
  out.push("", table(["Milestone", "Agents", "CP", "Entrée", "Sortie", "Cache lu", "Cache écrit", "Total"], msRows));

  const featureRows = report.features.map((f) => [
    String(f.issue),
    formatInt(f.agents),
    attemptsOf(report, f.issue),
    ...counters(f.usage),
  ]);
  out.push("", table(["#", "Agents", "Tentatives", "Entrée", "Sortie", "Cache lu", "Cache écrit", "Total"], featureRows));

  const rows = [];
  if (focus) {
    const cp = cpPart(focus);
    rows.push(["CP", "-", ...counters(cp ? cp.usage : ZERO)]);
  } else {
    rows.push(["CP", `${formatInt(report.cp.sessions)} session(s)`, ...counters(report.cp.usage)]);
    rows.push(["Hors feature", `${formatInt(report.horsFeature.agents)} agent(s)`, ...counters(report.horsFeature.usage)]);
    rows.push(["Non attribué", `${formatInt(report.nonAttribue.fichiers)} fichier(s)`, ...counters(report.nonAttribue.usage)]);
  }
  rows.push(["Total", `${formatInt(report.totals.messages)} message(s)`, ...counters(report.totals)]);
  out.push("", table(["Poste", "Détail", "Entrée", "Sortie", "Cache lu", "Cache écrit", "Total"], rows));

  if (report.warnings.length) out.push("", ...warningLines(report));
  return out.join("\n") + "\n";
}

/** JSON v1, indenté de deux espaces, terminé par un saut de ligne. */
function formatJson(report) {
  return JSON.stringify(report, null, 2) + "\n";
}

module.exports = { EMPTY, formatInt, formatText, formatJson };
