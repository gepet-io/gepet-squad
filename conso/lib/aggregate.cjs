// Agrégation de la consommation (ADR 0012, point 4). Module pur : aucune I/O.
// Messages déjà attribués (attribution.cjs) en entrée, rapport JSON v1 en sortie.
"use strict";

const CADRAGE = "Cadrage";

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 };
}

function counter(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Usage normalisé : entiers positifs, `total` toujours égal à la somme des quatre compteurs. */
function usageOf(usage) {
  const u = usage && typeof usage === "object" ? usage : {};
  const out = {
    input: counter(u.input),
    output: counter(u.output),
    cacheRead: counter(u.cacheRead),
    cacheWrite: counter(u.cacheWrite),
    total: 0,
    messages: counter(u.messages),
  };
  out.total = out.input + out.output + out.cacheRead + out.cacheWrite;
  return out;
}

function addTo(target, usage) {
  const u = usageOf(usage);
  target.input += u.input;
  target.output += u.output;
  target.cacheRead += u.cacheRead;
  target.cacheWrite += u.cacheWrite;
  target.total += u.total;
  target.messages += u.messages;
  return target;
}

/** Identifiant de feature : entier ou "F-<n>" gardé tel quel ; "12" devient 12 ; null sinon. */
function normalizeId(value) {
  if (Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const v = value.trim().replace(/^#/, "");
    if (/^\d+$/.test(v) && Number.parseInt(v, 10) > 0) return Number.parseInt(v, 10);
    if (/^F-\d+$/.test(v)) return v;
  }
  return null;
}

function idRank(id) {
  return typeof id === "number" ? [0, id, ""] : [1, Number.parseInt(id.slice(2), 10), id];
}

function compareIds(a, b) {
  const [ka, na, sa] = idRank(a);
  const [kb, nb, sb] = idRank(b);
  return ka - kb || na - nb || (sa < sb ? -1 : sa > sb ? 1 : 0);
}

function normalizeMilestones(milestones) {
  if (!Array.isArray(milestones)) return null;
  const seen = new Set();
  const list = [];
  for (const m of milestones) {
    if (!m || typeof m.titre !== "string" || m.titre === "" || seen.has(m.titre)) continue;
    seen.add(m.titre);
    const ids = [];
    for (const raw of Array.isArray(m.issues) ? m.issues : []) {
      const id = normalizeId(raw);
      if (id !== null && !ids.includes(id)) ids.push(id);
    }
    list.push({ titre: m.titre, issues: ids });
  }
  return list;
}

function orNull(value) {
  return value === undefined ? null : value;
}

function agentEntry(a) {
  return {
    agentId: orNull(a.agentId),
    role: orNull(a.role),
    mode: orNull(a.mode),
    issue: normalizeId(a.issue),
    pr: orNull(a.pr),
    attempt: orNull(a.attempt),
    model: orNull(a.model),
    debut: orNull(a.debut),
    fin: orNull(a.fin),
    usage: usageOf(a.usage),
  };
}

function compareAgents(a, b) {
  return String(a.debut ?? "").localeCompare(String(b.debut ?? "")) || String(a.agentId ?? "").localeCompare(String(b.agentId ?? ""));
}

/**
 * Construit le rapport v1.
 * @param {object} input
 * @param {object[]} [input.agents] agents attribués : { agentId, role, mode, issue, pr, attempt, model,
 *   debut, fin, usage, bucket }. bucket : "feature" (défaut) | "horsFeature" | "nonAttribue". Un agent
 *   « nonAttribue » n'apparaît pas dans `agents[]` : il est compté dans `nonAttribue` (un fichier).
 * @param {{sessions?: number, total?: object, byMilestone?: object|null}} [input.cp] résultat de
 *   attributeCp, plus le nombre de sessions. byMilestone null : le CP n'a qu'un total.
 * @param {{usage?: object, fichiers?: number}} [input.nonAttribue] autres fichiers non attribués
 * @param {{titre: string, issues: Array<number|string>}[]|null} [input.milestones] groupement des features
 * @param {string} [input.focus] titre d'un milestone de `milestones`
 * @param {{code: string, message: string}[]} [input.warnings] repris tels quels
 * @param {string|null} [input.project]
 * @param {string} [input.generatedAt] ISO ; défaut : maintenant
 */
function aggregate(input = {}) {
  const table = normalizeMilestones(input.milestones);
  const focus = input.focus === undefined || input.focus === null ? null : input.focus;
  if (focus !== null && !(table && table.some((m) => m.titre === focus))) {
    const err = new Error(`milestone ciblé inconnu : ${focus}`);
    err.code = "FOCUS_INCONNU";
    throw err;
  }

  const milestoneOfIssue = new Map();
  for (const m of table || []) for (const id of m.issues) if (!milestoneOfIssue.has(id)) milestoneOfIssue.set(id, m.titre);

  // Agents, répartis par seau.
  const featureAgents = [];
  const horsFeature = { agents: 0, usage: emptyUsage() };
  const nonAttribue = {
    usage: usageOf(input.nonAttribue && input.nonAttribue.usage),
    fichiers: counter(input.nonAttribue && input.nonAttribue.fichiers),
  };
  for (const raw of Array.isArray(input.agents) ? input.agents : []) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.bucket === "nonAttribue") {
      addTo(nonAttribue.usage, raw.usage);
      nonAttribue.fichiers += 1;
      continue;
    }
    const entry = agentEntry(raw);
    if (raw.bucket === "horsFeature" || entry.issue === null) {
      horsFeature.agents += 1;
      addTo(horsFeature.usage, entry.usage);
      continue;
    }
    featureAgents.push(entry);
  }
  featureAgents.sort(compareAgents);

  // Features.
  const featureMap = new Map();
  for (const a of featureAgents) {
    const f = featureMap.get(a.issue) || {
      issue: a.issue,
      milestone: milestoneOfIssue.get(a.issue) ?? null,
      agents: 0,
      usage: emptyUsage(),
    };
    f.agents += 1;
    addTo(f.usage, a.usage);
    featureMap.set(a.issue, f);
  }
  const features = [...featureMap.values()].sort((a, b) => compareIds(a.issue, b.issue));

  // CP.
  const cpIn = input.cp && typeof input.cp === "object" ? input.cp : {};
  const cpUsage = usageOf(cpIn.total);
  const cpByTitle = new Map();
  if (cpIn.byMilestone && table) {
    for (const [name, usage] of Object.entries(cpIn.byMilestone)) cpByTitle.set(name, usageOf(usage));
  }
  const order = [CADRAGE, ...(table || []).map((m) => m.titre)];
  const rank = (name) => {
    const i = order.indexOf(name);
    return i === -1 ? order.length : i;
  };
  const parMilestone = [...cpByTitle.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((name) => ({ milestone: name, usage: cpByTitle.get(name) }));

  // Milestones : agents de leurs features + part du CP.
  const milestones = (table || []).map((m) => {
    const usage = emptyUsage();
    for (const f of features) if (f.milestone === m.titre) addTo(usage, f.usage);
    if (cpByTitle.has(m.titre)) addTo(usage, cpByTitle.get(m.titre));
    return { titre: m.titre, issues: m.issues, usage };
  });

  // Total général : agents rattachés + hors feature + CP + non attribué (aucun double compte).
  const totals = emptyUsage();
  for (const a of featureAgents) addTo(totals, a.usage);
  addTo(totals, horsFeature.usage);
  addTo(totals, cpUsage);
  addTo(totals, nonAttribue.usage);

  const report = {
    v: 1,
    generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : new Date().toISOString(),
    project: typeof input.project === "string" ? input.project : null,
    totals,
    cp: { sessions: counter(cpIn.sessions), usage: cpUsage, parMilestone },
    milestones,
    features,
    horsFeature,
    agents: featureAgents,
    nonAttribue,
    warnings: (Array.isArray(input.warnings) ? input.warnings : [])
      .filter((w) => w && typeof w.code === "string")
      .map((w) => ({ code: w.code, message: typeof w.message === "string" ? w.message : "" })),
  };

  if (focus !== null) {
    const ms = milestones.filter((m) => m.titre === focus);
    const ids = new Set(ms[0].issues);
    report.milestones = ms;
    report.features = features.filter((f) => f.milestone === focus);
    report.agents = featureAgents.filter((a) => ids.has(a.issue));
    report.cp.parMilestone = parMilestone.filter((p) => p.milestone === focus);
    report.totals = ms[0].usage;
  }
  return report;
}

module.exports = { CADRAGE, aggregate, usageOf, normalizeId };
