// Vue texte de repli, quand WebGL n'est pas disponible (ou que l'URL porte `?mode=texte`) : pour chaque station, ses
// features (`#n titre`, badge de tentative, statut) et ses agents actifs (type, mode, issue). C'est aussi une alternative
// accessible à la scène 3D.
//
// Deux couches, dans ce seul module :
//   - `fallbackView(model)` et `forcesFallback(search)` : fonctions pures (aucune globale du navigateur, ni hasard, ni
//     horloge). Elles décident de tout : ordre des stations, tri, badges, agents à montrer. Testées sous Node ;
//   - `renderFallback(container, model, doc)` et `webglAvailable(doc)` : écrivent le DOM avec `createElement` et
//     `textContent` uniquement (la seconde essaie de créer un contexte WebGL). Le document est reçu en argument ; tout texte venu du serveur (titres de features) reste du texte brut, jamais du
//     HTML (ADR 0005, règle ESLint sur innerHTML et outerHTML).
//
// L'état vient de `state.js` (le modèle), les noms de `view-model.js` : rien n'est recalculé ici.

import { ESCALADE, STATIONS } from "./state.js";
import { ESCALADE_NAME, STATUS_COLORS, STATUS_LABELS, featureLabel, stationName } from "./view-model.js";

/** Valeur du paramètre d'URL `mode` qui force la vue de repli. */
export const TEXT_MODE = "texte";
/** Identifiant du groupe qui reçoit ce qui n'a pas de station connue. */
export const UNPLACED = "sans-station";
export const UNPLACED_NAME = "Sans station";

// Phases d'un agent considéré comme actif, et leur libellé. `finished` (terminé) et `unknown` (silencieux depuis
// longtemps) ne sont pas montrés : la vue liste ce qui travaille.
const ACTIVE_PHASES = Object.freeze({ requested: "demandé", running: "en cours", reported: "rapport rendu" });

/**
 * `?mode=texte` force-t-il la vue de repli ?
 * @param {string | null | undefined} search la partie « ?… » de l'URL (`location.search`)
 */
export function forcesFallback(search) {
  if (typeof search !== "string") return false;
  return new URLSearchParams(search).getAll("mode").some((value) => value.trim().toLowerCase() === TEXT_MODE);
}

/**
 * WebGL est-il disponible ? Essaie de créer un contexte sur un canvas jetable (sans `three`, donc sans qu'il ne
 * journalise une erreur), puis le libère aussitôt : un navigateur n'accepte qu'un nombre limité de contextes.
 * @param {Document} doc
 */
export function webglAvailable(doc) {
  try {
    const canvas = doc.createElement("canvas");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return false;
    gl.getExtension?.("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** Le texte d'un badge de tentative (« retry 2 »), ou `null` quand la feature n'a pas de tentative. */
export function retryBadge(retry) {
  return Number.isInteger(retry) && retry > 0 ? `retry ${retry}` : null;
}

// Un agent actif : « developpeur · IMPLEMENTATION · #13 » (les parties inconnues sont omises).
function agentRow(agent) {
  const parts = [agent.type ?? "agent"];
  if (agent.mode) parts.push(agent.mode);
  if (agent.issue !== null) parts.push(`#${agent.issue}`);
  return {
    id: agent.id,
    type: agent.type,
    mode: agent.mode,
    issue: agent.issue,
    phase: agent.phase,
    phaseLabel: ACTIVE_PHASES[agent.phase],
    text: parts.join(" · "),
  };
}

function featureRow(feature) {
  return {
    number: feature.number,
    text: featureLabel(feature),
    status: Object.prototype.hasOwnProperty.call(STATUS_COLORS, feature.status) ? feature.status : "unknown",
    statusLabel: STATUS_LABELS[feature.status] ?? String(feature.status),
    retry: Number.isInteger(feature.retry) && feature.retry > 0 ? feature.retry : 0,
    retryBadge: retryBadge(feature.retry),
  };
}

// Ordre des agents d'un groupe : par issue (celles sans issue à la fin), puis type, puis identifiant.
const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const compareAgents = (a, b) =>
  (a.issue ?? Infinity) - (b.issue ?? Infinity) || byText(String(a.type), String(b.type)) || byText(String(a.id), String(b.id));

/**
 * Transforme le modèle de `state.js` en structure de liste.
 *
 * Les groupes, dans l'ordre : les 7 stations du pipeline (toutes, même vides), puis la zone d'escalade, puis « Sans
 * station » ; ces deux derniers n'apparaissent que s'ils contiennent quelque chose. Dans un groupe, les features sont
 * triées par numéro et les agents actifs par issue. Une feature bloquée est dans l'escalade, pas dans sa station.
 *
 * @returns {{ groups: Array<{ id: string, name: string, features: object[], agents: object[] }>, featureCount: number,
 *   agentCount: number }}
 */
export function fallbackView(model) {
  const groups = [...STATIONS, ESCALADE, UNPLACED].map((id) => ({
    id,
    name: id === UNPLACED ? UNPLACED_NAME : id === ESCALADE ? ESCALADE_NAME : stationName(id),
    features: [],
    agents: [],
  }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const groupFor = (id) => byId.get(id) ?? byId.get(UNPLACED);

  for (const feature of [...model.features].sort((a, b) => a.number - b.number)) {
    groupFor(feature.escalated ? ESCALADE : feature.station).features.push(featureRow(feature));
  }
  const active = model.agents.filter((agent) => Object.prototype.hasOwnProperty.call(ACTIVE_PHASES, agent.phase));
  for (const agent of active) groupFor(agent.station).agents.push(agentRow(agent));
  for (const group of groups) group.agents.sort(compareAgents);

  const shown = groups.filter(
    (group) => !(group.id === ESCALADE || group.id === UNPLACED) || group.features.length > 0 || group.agents.length > 0,
  );
  return { groups: shown, featureCount: model.features.length, agentCount: active.length };
}

// --- DOM ---------------------------------------------------------------------------------------------------------------

function textElement(doc, tag, className, text) {
  const el = doc.createElement(tag);
  if (className) el.className = className;
  el.textContent = text;
  return el;
}

function featureItem(doc, feature) {
  const item = doc.createElement("li");
  const parts = [textElement(doc, "span", "repli-titre", feature.text)];
  if (feature.retryBadge !== null) parts.push(textElement(doc, "span", "repli-badge repli-retry", feature.retryBadge));
  parts.push(textElement(doc, "span", `repli-badge repli-statut statut-${feature.status}`, feature.statusLabel));
  item.append(...parts);
  return item;
}

function agentItem(doc, agent) {
  const item = doc.createElement("li");
  const parts = [textElement(doc, "span", "repli-titre", agent.text)];
  parts.push(textElement(doc, "span", "repli-badge repli-phase", agent.phaseLabel));
  item.append(...parts);
  return item;
}

function groupSection(doc, group) {
  const section = doc.createElement("section");
  section.className = "repli-station";
  const headingId = `repli-${group.id}`;
  section.setAttribute("aria-labelledby", headingId);
  const heading = textElement(doc, "h2", "", group.name);
  heading.setAttribute("id", headingId);
  section.append(heading);

  if (group.features.length === 0 && group.agents.length === 0) {
    section.append(textElement(doc, "p", "repli-vide", "aucune feature"));
    return section;
  }
  if (group.features.length > 0) {
    const list = doc.createElement("ul");
    list.className = "repli-liste";
    list.setAttribute("aria-label", `Features, ${group.name}`);
    list.append(...group.features.map((feature) => featureItem(doc, feature)));
    section.append(list);
  }
  if (group.agents.length > 0) {
    const agents = doc.createElement("ul");
    agents.className = "repli-liste repli-agents";
    agents.setAttribute("aria-label", `Agents actifs, ${group.name}`);
    agents.append(...group.agents.map((agent) => agentItem(doc, agent)));
    section.append(agents);
  }
  return section;
}

/**
 * Écrit la vue de repli dans `container`, en remplaçant son contenu. Appelée à chaque mise à jour du modèle.
 * @param {Element} container
 * @param {object} model modèle de `state.js`
 * @param {Document} doc
 */
export function renderFallback(container, model, doc) {
  const view = fallbackView(model);
  container.textContent = "";
  const summary = `${view.featureCount} feature${view.featureCount > 1 ? "s" : ""}, ${view.agentCount} agent${view.agentCount > 1 ? "s" : ""} actif${view.agentCount > 1 ? "s" : ""}`;
  container.append(textElement(doc, "p", "repli-resume", summary));
  for (const group of view.groups) container.append(groupSection(doc, group));
}
