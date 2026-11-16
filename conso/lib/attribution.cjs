// Attribution de la consommation (ADR 0013, points 2, 4, 5 et 10). Module pur : aucune I/O.
// Relie un agent à { role, mode, issue, pr, attempt } et la session du CP à un milestone.
// Le journal (schéma v1) est lu sans être modifié ; seuls les champs d'attribution sont utilisés.
"use strict";

const PREFIXES = ["gepet-squad:", "claude-gepet-squad:"];
const CADRAGE = "Cadrage";

// Mêmes règles que hooks/lib/normalize.cjs (champ en début de ligne, première occurrence, arrêt aux
// notes libres), sauf ISSUE qui accepte aussi `F-<n>` (mode économe local).
const FREE_TEXT_START = /^[ \t]*(?:Notes?|RAPPORT)[ \t]*:/m;

function matchInt(text, re) {
  const m = re.exec(text);
  return m ? Number.parseInt(m[1], 10) : undefined;
}

/** { mode, issue, pr, attempt } d'un texte de mission ; champ absent = undefined. issue : entier ou "F-<n>". */
function parseMissionHeader(text) {
  if (typeof text !== "string") return {};
  const cut = text.search(FREE_TEXT_START);
  const head = cut === -1 ? text : text.slice(0, cut);
  const mode = /^[ \t]*MODE[ \t]*:[ \t]*([A-Z][A-Z0-9_]*)/m.exec(head);
  const issue = /^[ \t]*ISSUE[ \t]*:[ \t]*#?(F-\d+|\d+)/m.exec(head);
  return {
    mode: mode ? mode[1] : undefined,
    issue: issue ? (/^\d+$/.test(issue[1]) ? Number.parseInt(issue[1], 10) : issue[1]) : undefined,
    pr: matchInt(head, /^[ \t]*PR[ \t]*:[ \t]*#?(\d+)/m),
    attempt: matchInt(head, /^[ \t]*TENTATIVE[ \t]*:[ \t]*(\d+)/m),
  };
}

/** Texte de la mission porté par la première ligne d'un transcript d'agent ; "" si illisible. */
function missionTextFromLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return "";
  }
  const content = obj && obj.message ? obj.message.content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const block = content.find((b) => b && b.type === "text" && typeof b.text === "string");
    return block ? block.text : "";
  }
  return "";
}

/** `agentType` sans préfixe de la squad ; null si l'agent n'est pas de la squad. */
function roleOf(agentType) {
  if (typeof agentType !== "string") return null;
  for (const prefix of PREFIXES) {
    if (agentType.startsWith(prefix) && agentType.length > prefix.length) return agentType.slice(prefix.length);
  }
  return null;
}

function isFeatureId(value) {
  return (Number.isInteger(value) && value > 0) || (typeof value === "string" && /^F-\d+$/.test(value));
}

function pick(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

function orNull(value) {
  return value === undefined ? null : value;
}

/**
 * Attribue un transcript d'agent.
 * @param {{agentId?: string, meta?: {agentType?: string, toolUseId?: string}, missionText?: string, events?: object[]}} input
 * @returns {null | {role, mode, issue, pr, attempt, toolUseId, source, bucket}}
 *   null : agent hors squad (exclu). bucket : "feature" | "horsFeature" | "nonAttribue".
 *   source : "toolUseId" | "agentId" | "mission" | null. Inconnu vaut null (jamais undefined).
 */
function attributeAgent({ agentId, meta, missionText, events } = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === "object") : [];
  const toolUseId = meta && typeof meta.toolUseId === "string" ? meta.toolUseId : undefined;
  const byTool = toolUseId
    ? list.find((e) => e.type === "agent.requested" && e.toolUseId === toolUseId)
    : undefined;
  const byAgent =
    !byTool && typeof agentId === "string" && agentId !== ""
      ? list.filter((e) => typeof e.type === "string" && e.type.startsWith("agent.") && e.agentId === agentId)
      : [];

  const agentType = pick(meta && meta.agentType, byTool && byTool.agentType, ...byAgent.map((e) => e.agentType));
  const role = roleOf(agentType);
  if (role === null) return null;

  const header = parseMissionHeader(missionText);
  const base = byTool || {};
  const mode = pick(base.mode, ...byAgent.map((e) => e.mode), header.mode);
  const issue = pick(isFeatureId(base.issue) ? base.issue : undefined, header.issue);
  const pr = pick(base.pr, header.pr);
  const attempt = pick(base.attempt, header.attempt);

  const hasHeader = Object.values(header).some((v) => v !== undefined);
  const source = byTool ? "toolUseId" : byAgent.length > 0 ? "agentId" : hasHeader ? "mission" : null;
  const bucket = source === null ? "nonAttribue" : issue === undefined ? "horsFeature" : "feature";
  return {
    role,
    mode: orNull(mode),
    issue: orNull(issue),
    pr: orNull(pr),
    attempt: orNull(attempt),
    toolUseId: orNull(toolUseId),
    source,
    bucket,
  };
}

function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 };
}

function addUsage(totals, usage) {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.total += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  totals.messages += 1;
}

function timeOf(ts) {
  const t = typeof ts === "string" ? Date.parse(ts) : Number.NaN;
  return Number.isNaN(t) ? null : t;
}

/**
 * Rattache la consommation du CP aux milestones.
 * @param {object[]} entries réponses dédupliquées de la session principale ({ ts, usage })
 * @param {{events?: object[], agents?: object[], milestones?: object|Map|null}} context
 *   events : journal ; agents : résultats de attributeAgent (leur issue complète celle d'un
 *   `agent.requested` sans issue, via toolUseId) ; milestones : table `id → milestone` (objet ou Map).
 * @returns {{total, byMilestone: null | Object<string, object>}}
 *   Chaque réponse va au milestone de la dernière feature demandée (`agent.requested`) avant son
 *   timestamp ; « Cadrage » avant la première, ou si la feature n'est pas dans la table. Sans table,
 *   byMilestone vaut null : le CP n'a qu'un total.
 */
function attributeCp(entries, { events, agents, milestones } = {}) {
  const total = emptyTotals();
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.usage) : [];
  for (const entry of list) addUsage(total, entry.usage);
  if (milestones === undefined || milestones === null) return { total, byMilestone: null };

  const table = milestones instanceof Map ? milestones : new Map(Object.entries(milestones));
  const issueByTool = new Map();
  for (const a of Array.isArray(agents) ? agents : []) {
    if (a && a.toolUseId && a.issue !== null && a.issue !== undefined) issueByTool.set(a.toolUseId, a.issue);
  }
  const timeline = [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || e.type !== "agent.requested") continue;
    const t = timeOf(e.ts);
    const issue = isFeatureId(e.issue) ? e.issue : issueByTool.get(e.toolUseId);
    if (t !== null && issue !== undefined) timeline.push({ t, issue });
  }
  timeline.sort((a, b) => a.t - b.t);

  const byMilestone = {};
  for (const entry of list) {
    const t = timeOf(entry.ts);
    let current;
    if (t !== null) for (const step of timeline) if (step.t <= t) current = step.issue;
    const found = current === undefined ? undefined : (table.get(String(current)) ?? table.get(current));
    const name = typeof found === "string" && found !== "" ? found : CADRAGE;
    addUsage((byMilestone[name] ??= emptyTotals()), entry.usage);
  }
  return { total, byMilestone };
}

module.exports = { CADRAGE, parseMissionHeader, missionTextFromLine, roleOf, attributeAgent, attributeCp };
