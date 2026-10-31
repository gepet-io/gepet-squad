// Modèle client de la visualisation : applique les messages SSE à l'état `/state`.
// Module pur : aucun import, ni `three`, ni DOM, ni horloge (le temps vient des messages ou de l'argument `now`).
// Références : ARCHITECTURE § 6 (contrat `/state`, schéma d'événement v1, correspondance avec les stations),
// ADR 0004 (corrélation des agents), ADR 0006 et 0007. Le réducteur serveur (`viz/lib/reducer.cjs`) fait foi :
// `tests/viz-web/stations-parity.test.mjs` vérifie que les stations calculées ici sont les mêmes.
//
// ---------------------------------------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------------------------------------
//   init(state)            -> model                       état `/state` -> modèle client (copie, tolérante)
//   apply(model, message)  -> { model, transitions }      un message SSE -> nouveau modèle + transitions à animer
//   tick(model, now)       -> { model, transitions }      purge des agents terminés et passage en `unknown` (horloge)
//   diff(before, after)    -> transitions                 différences entre deux modèles
//
// Le modèle n'est jamais modifié : `apply` et `tick` renvoient un nouveau modèle (ou le même objet quand rien ne
// change). Le modèle a la forme de `/state` (repo, updatedAt, milestones, features, agents, releases, warnings), plus
// `lastStation` ({ [issue]: station }), la dernière station connue par les événements reçus, utilisée pour la station
// d'accolement d'une feature `blocked`. Chaque agent porte en plus `sessionId` et `binding` (corrélation), propres au client.
//
// Cycle de vie des agents (ADR 0008, mêmes règles que `viz/lib/reducer.cjs`) : un agent peut avoir plusieurs cycles
// sous le même `agentId` (reprise par SendMessage). Un `started`, `launched` ou `reported` de `ts` strictement postérieur
// au `finishedAt` rouvre un cycle (`finishedAt` revient à `null`, `block`/`verdict` repartent de `null` sur
// `started`/`launched`) ; un `finished` clôt le cycle en cours, et un `finished` en double ne complète que `block` et
// `verdict`. Le `mode` (donc la station) d'un architecte se déduit du `block` de son rapport. `id` et `since` restent
// ceux du premier cycle. `tick` s'applique au dernier cycle : un agent réactivé n'est pas retiré.
//
// ---------------------------------------------------------------------------------------------------------
// Format SSE (strict : contrat avec viz-server, #8)
// ---------------------------------------------------------------------------------------------------------
// L'événement SSE porte le nom `evt`, `snapshot` ou `warning`, et sa `data` est une chaîne JSON. Le client appelle :
//
//     source.addEventListener("evt", (e) => apply(model, { event: e.type, data: e.data }));
//
// (`e.type` est le nom de l'événement SSE, `e.data` la chaîne reçue, jamais déjà parsée).
//   - `snapshot` : `data` est un état `/state` complet (objet JSON), qui remplace le modèle ;
//   - `evt`      : `data` est un événement v1 (hooks/lib/schema.cjs), ou un tableau d'événements v1 (un lot, appliqué
//                  trié par `ts`, comme le fait le réducteur serveur : ADR 0008) ;
//   - `warning`  : `data` est exactement { code, message, at } (trois chaînes non vides, `at` est une date ISO).
// Rien d'autre n'est accepté : ni l'alias `type` à la place de `event`, ni une `data` déjà parsée, ni une liste
// d'avertissements. Un message qui n'est pas un objet ou qui n'a pas de nom `event`, une `data` qui n'est pas une chaîne,
// un JSON invalide ou une forme inattendue sont ignorés, avec un avertissement `EVENT_ERROR` ajouté au modèle (le détail
// brut du message n'y figure pas). Un nom d'événement SSE inconnu (autre que ces trois-là) est ignoré en silence.
// Aucune fonction de ce module ne lève d'exception.
//
// Transitions { kind, id, from, to } :
//   feature-add / feature-remove    id = numéro ; `to` / `from` = lieu ("cadrage".."release" ou "escalade")
//   feature-move                    id = numéro ; lieu `from` -> `to` (une feature `escalated` est au lieu "escalade")
//   feature-status                  id = numéro ; statut `from` -> `to`, sans changement de lieu
//   feature-retry                   id = numéro ; compteur `from` -> `to`
//   agent-add / agent-remove        id = id de l'agent ; `to` / `from` = station (ou null)
//   agent-move                      id ; station `from` -> `to`
//   agent-phase                     id ; phase `from` -> `to`
//   milestone                       id = numéro ; état "open" | "closed"
//   release                         id = branche ; `from` = null (nouvelle) ou état précédent ; `to` = état

export const STATIONS = Object.freeze(["cadrage", "roadmap", "dev", "verification", "test", "merge", "release"]);
export const ESCALADE = "escalade";
export const DEFAULT_BLOCKED_STATION = "dev";

// Statut `status:*` -> station. `blocked` n'a pas de station propre : voir `escalated`.
export const STATUS_STATION = Object.freeze({
  backlog: "roadmap",
  ready: "roadmap",
  "in-progress": "dev",
  "changes-requested": "dev",
  "in-review": "verification",
  "in-test": "test",
  done: "merge",
});
export const STATUSES = Object.freeze([...Object.keys(STATUS_STATION), "blocked"]);
// Stations auxquelles la zone d'escalade peut être accolée : celles d'un statut (jamais cadrage ni release).
const ATTACH_STATIONS = Object.freeze([...new Set(Object.values(STATUS_STATION))]);

export const AGENT_FINISHED_TTL_MS = 10 * 60 * 1000;
export const AGENT_UNKNOWN_AFTER_MS = 45 * 60 * 1000;

const SCHEMA_VERSION = 1;
const AGENT_PREFIX = "claude-gepet-squad:";
const SINGLE_PER_ISSUE = new Set(["developpeur", "verificateur", "testeur"]);
const PHASE_ORDER = { requested: 0, running: 1, reported: 2, finished: 3 };
const SSE_EVENTS = new Set(["evt", "snapshot", "warning"]);
// Bloc de rapport de l'architecte -> mode (ADR 0008, règle 4). Même table que le réducteur serveur.
const BLOCK_MODE = Object.freeze({
  QUESTIONS: "CADRAGE_QUESTIONS",
  PROPOSITION: "CADRAGE_PROPOSITION",
  PITCH: "CADRAGE_FINALISATION",
  VERDICT_ROADMAP: "REVUE_ROADMAP",
  ESCALADE: "ESCALADE",
});
const REOPENING_EVENTS = new Set(["agent.started", "agent.launched", "agent.reported"]);
const PHASES = ["requested", "running", "reported", "finished", "unknown"];
const MAX_WARNINGS = 50;
const MAX_ID_LENGTH = 200;

// Champs obligatoires de chaque type d'événement : "s" chaîne non vide, "n" entier >= 1, "id" identifiant d'agent,
// "source" `stop` ou `tool`. Même table que le réducteur serveur (ARCHITECTURE § 6, « Champs par type »).
const REQUIRED_FIELDS = Object.freeze({
  "agent.requested": { toolUseId: "s", agentType: "s" },
  "agent.launched": { toolUseId: "s", agentId: "id" },
  "agent.started": { agentId: "id", agentType: "s" },
  "agent.reported": { agentId: "id" },
  "agent.finished": { agentId: "id", source: "source" },
  "feature.status": { issue: "n", status: "s" },
  "feature.retry": { issue: "n", retry: "n" },
  "issue.created": { ref: "s" },
  "issue.closed": { issue: "n" },
  "pr.opened": { ref: "s" },
  "release.opened": { ref: "s" },
  "pr.merged": { pr: "n" },
  "milestone.changed": { ref: "s" },
});

// --- Utilitaires ---------------------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function str(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function posInt(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

function toMs(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function normalizeAgentId(id) {
  if (typeof id !== "string") return null;
  const bare = id.trim().replace(/^agent-/, "").slice(0, MAX_ID_LENGTH);
  return bare === "" ? null : bare;
}

function shortType(agentType) {
  const s = str(agentType);
  if (s === null) return null;
  return s.startsWith(AGENT_PREFIX) ? s.slice(AGENT_PREFIX.length) : s;
}

const byNumber = (a, b) => a.number - b.number;
const byText = (x, y) => (x < y ? -1 : x > y ? 1 : 0);

export function stationForStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_STATION, status) ? STATUS_STATION[status] : null;
}

// Station d'un agent : son type pour les agents d'issue, le MODE pour l'architecte.
export function agentStation(type, mode) {
  switch (type) {
    case "developpeur":
      return "dev";
    case "verificateur":
      return "verification";
    case "testeur":
      return "test";
    case "architecte":
      if (typeof mode !== "string") return null;
      if (mode.startsWith("CADRAGE")) return "cadrage";
      if (mode === "REVUE_ROADMAP") return "roadmap";
      if (mode === "ESCALADE") return ESCALADE;
      return null;
    default:
      return null;
  }
}

// Lieu d'une feature : la zone d'escalade pour une feature `escalated`, sinon sa station.
export const placeOf = (feature) => (feature.escalated ? ESCALADE : feature.station);

// `release/m2-api` <-> milestone « M2 — API » : on compare le numéro k.
function milestoneForBranch(branch, milestones) {
  const k = /^release\/m(\d+)\b/i.exec(branch);
  if (!k) return null;
  const found = milestones.find((m) => {
    const t = /^\s*M(\d+)\b/i.exec(m.title);
    return t !== null && Number.parseInt(t[1], 10) === Number.parseInt(k[1], 10);
  });
  return found ? found.title : null;
}

// --- Stations des features (mêmes règles que le réducteur serveur) ---------------------------------------------

// Contexte de calcul : titres des milestones fermés, et des milestones qui ont une PR `release/*` ouverte.
export function stationContext(milestones, releases) {
  return {
    closedMilestones: new Set((milestones || []).filter((m) => m.state === "closed").map((m) => m.title)),
    releasedMilestones: new Set((releases || []).filter((r) => r.state === "open" && r.milestone).map((r) => r.milestone)),
  };
}

// Station d'une feature NON bloquée, ou `null` si le statut est inconnu. Priorité (ARCHITECTURE § 6) :
//   - Release : toutes les features d'un milestone fermé, et les features `done` d'un milestone qui a une PR de release ouverte ;
//   - sinon, selon le statut.
// Le cas `blocked` (zone d'escalade) est traité par l'appelant, qui connaît la station d'accolement.
export function stationForFeature(feature, context) {
  const { closedMilestones, releasedMilestones } = context;
  const m = feature.milestone;
  if (m && (closedMilestones.has(m) || (feature.status === "done" && releasedMilestones.has(m)))) return "release";
  return stationForStatus(feature.status);
}

// Recalcule station et escalated de toutes les features, puis total/done des milestones.
function restate(model) {
  const context = stationContext(model.milestones, model.releases);
  for (const f of model.features) {
    if (f.status === "blocked") {
      f.escalated = true;
      if (!ATTACH_STATIONS.includes(f.station)) f.station = model.lastStation[f.number] || DEFAULT_BLOCKED_STATION;
    } else {
      f.escalated = false;
      f.station = stationForFeature(f, context);
    }
  }
  for (const m of model.milestones) {
    const own = model.features.filter((f) => f.milestone === m.title);
    m.total = own.length;
    m.done = own.filter((f) => f.status === "done").length;
  }
}

// --- Normalisation de l'état `/state` ----------------------------------------------------------------------------

function list(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFeature(raw) {
  if (!isObject(raw)) return null;
  const number = posInt(raw.number);
  if (number === null || !STATUSES.includes(raw.status)) return null;
  return {
    number,
    title: str(raw.title),
    milestone: str(raw.milestone),
    status: raw.status,
    retry: Number.isInteger(raw.retry) && raw.retry > 0 ? raw.retry : 0,
    pr: posInt(raw.pr),
    station: typeof raw.station === "string" ? raw.station : null,
    escalated: raw.status === "blocked",
  };
}

function normalizeMilestone(raw) {
  if (!isObject(raw)) return null;
  const number = posInt(raw.number);
  const title = str(raw.title);
  if (number === null || title === null) return null;
  return { number, title, state: raw.state === "closed" ? "closed" : "open", total: 0, done: 0 };
}

function normalizeRelease(raw) {
  if (!isObject(raw)) return null;
  const branch = str(raw.branch);
  if (branch === null) return null;
  const state = raw.state === "merged" || raw.state === "closed" ? raw.state : "open";
  return { branch, pr: posInt(raw.pr), state, title: str(raw.title), milestone: str(raw.milestone) };
}

function normalizeAgent(raw) {
  if (!isObject(raw)) return null;
  const id = str(raw.id);
  if (id === null) return null;
  const type = shortType(raw.type);
  const mode = str(raw.mode);
  const agentId = normalizeAgentId(raw.agentId);
  const since = iso(toMs(raw.since));
  return {
    id,
    type,
    mode,
    issue: posInt(raw.issue),
    pr: posInt(raw.pr),
    attempt: Number.isInteger(raw.attempt) ? raw.attempt : null,
    station: typeof raw.station === "string" ? raw.station : agentStation(type, mode),
    phase: PHASES.includes(raw.phase) ? raw.phase : "unknown",
    since,
    updatedAt: iso(toMs(raw.updatedAt)) ?? since,
    finishedAt: iso(toMs(raw.finishedAt)),
    verdict: str(raw.verdict),
    block: str(raw.block),
    agentId,
    toolUseId: str(raw.toolUseId),
    sessionId: str(raw.sessionId),
    binding: agentId === null ? null : "exact",
  };
}

function normalizeWarning(raw) {
  if (!isObject(raw)) return null;
  const code = str(raw.code);
  const message = str(raw.message);
  if (code === null || message === null) return null;
  return { code, message, at: typeof raw.at === "string" ? raw.at : null };
}

function sortAgents(agents) {
  agents.sort((x, y) => byText(x.since || "", y.since || "") || byText(x.id, y.id));
}

// Construit le modèle client à partir d'un état `/state`. Tolérant : une entrée invalide est écartée, jamais d'exception.
export function init(state) {
  const s = isObject(state) ? state : {};
  const model = {
    repo: str(s.repo),
    updatedAt: iso(toMs(s.updatedAt)),
    milestones: list(s.milestones).map(normalizeMilestone).filter(Boolean).sort(byNumber),
    features: list(s.features).map(normalizeFeature).filter(Boolean).sort(byNumber),
    agents: list(s.agents).map(normalizeAgent).filter(Boolean),
    releases: list(s.releases).map(normalizeRelease).filter(Boolean).sort((x, y) => byText(x.branch, y.branch)),
    warnings: list(s.warnings).map(normalizeWarning).filter(Boolean),
    lastStation: {},
  };
  sortAgents(model.agents);
  restate(model);
  return model;
}

// --- Agents : corrélation et cycle de vie (ADR 0004) ---------------------------------------------------------------

const isActive = (a) => a.phase !== "finished";
const phaseRank = (p) => (p in PHASE_ORDER ? PHASE_ORDER[p] : -1);

function finish(a, t) {
  if (a.phase === "finished") return;
  a.phase = "finished";
  a.finishedAt = iso(t);
  a.updatedAt = iso(t);
}

// Fusionne `b` (connu seulement par son agentId) dans `a` (connu par son toolUseId) et retire `b`.
function mergeAgents(model, a, b) {
  model.agents.splice(model.agents.indexOf(b), 1);
  a.agentId = b.agentId;
  a.binding = "exact";
  for (const f of ["type", "mode", "issue", "pr", "attempt", "sessionId", "verdict", "block"]) {
    if (a[f] === null) a[f] = b[f];
  }
  if (phaseRank(b.phase) > phaseRank(a.phase)) a.phase = b.phase;
  if (a.finishedAt === null) a.finishedAt = b.finishedAt;
  if (b.since < a.since) a.since = b.since;
  if (b.updatedAt > a.updatedAt) a.updatedAt = b.updatedAt;
}

// `b` avait pris l'agentId par FIFO, mais `a` (le toolUseId fait foi) le revendique : on le lui rend.
function stealAgentId(a, b) {
  a.agentId = b.agentId;
  a.binding = "exact";
  if (phaseRank(b.phase) > phaseRank(a.phase)) a.phase = b.phase;
  if (a.finishedAt === null) a.finishedAt = b.finishedAt;
  if (a.verdict === null) a.verdict = b.verdict;
  if (a.block === null) a.block = b.block;
  if (b.updatedAt > a.updatedAt) a.updatedAt = b.updatedAt;
  b.agentId = null;
  b.binding = null;
  b.phase = "requested";
  b.verdict = null;
  b.block = null;
  b.finishedAt = null;
  b.updatedAt = b.since;
}

function locateAgent(model, ev) {
  const byTool = ev.toolUseId ? model.agents.find((a) => a.toolUseId === ev.toolUseId) : undefined;
  const byAgent = ev.agentId ? model.agents.find((a) => a.agentId === ev.agentId) : undefined;
  let a = byTool || byAgent;
  if (byTool && byAgent && byTool !== byAgent) {
    if (byAgent.toolUseId === null && byTool.agentId === null) mergeAgents(model, byTool, byAgent);
    else if (byAgent.toolUseId !== null && byAgent.binding === "fifo" && byTool.agentId === null) stealAgentId(byTool, byAgent);
    // Deux agents déjà reliés chacun de façon certaine : le premier gagne.
    a = byTool;
  } else if (a) {
    if (ev.toolUseId && a.toolUseId === null) a.toolUseId = ev.toolUseId;
    if (ev.agentId && a.agentId === null) {
      a.agentId = ev.agentId;
      a.binding = "exact";
    }
  }
  if (!a && !ev.toolUseId && ev.agentId && ev.agentType) {
    // FIFO : plus ancien agent `requested` de ce type qui n'a pas encore d'agentId, dans la même session.
    a = model.agents.find(
      (c) =>
        c.type === ev.agentType &&
        c.agentId === null &&
        c.phase === "requested" &&
        (c.sessionId === null || ev.sessionId === null || c.sessionId === ev.sessionId),
    );
    if (a) {
      a.agentId = ev.agentId;
      a.binding = "fifo";
    }
  }
  if (a) return a;
  a = {
    id: ev.toolUseId || ev.agentId,
    type: null,
    mode: null,
    issue: null,
    pr: null,
    attempt: null,
    station: null,
    phase: "requested",
    since: iso(ev.t),
    updatedAt: iso(ev.t),
    finishedAt: null,
    verdict: null,
    block: null,
    agentId: ev.agentId,
    toolUseId: ev.toolUseId,
    sessionId: null,
    binding: ev.agentId ? "exact" : null,
  };
  model.agents.push(a);
  return a;
}

// Au plus un agent actif développeur/vérificateur/testeur par issue : le plus récent (le dernier créé) l'emporte.
function enforceSingle(model, issue, t) {
  if (issue === null) return;
  const active = model.agents.filter((a) => a.issue === issue && SINGLE_PER_ISSUE.has(a.type) && isActive(a));
  for (const older of active.slice(0, -1)) finish(older, t);
}

function enrichAgent(model, a, ev) {
  if (a.sessionId === null) a.sessionId = ev.sessionId;
  if (a.type === null) a.type = ev.agentType;
  if (a.mode === null) a.mode = ev.mode;
  if (a.pr === null) a.pr = ev.pr;
  if (a.attempt === null) a.attempt = ev.attempt;
  if (a.verdict === null) a.verdict = ev.verdict;
  if (a.block === null) a.block = ev.block;
  if (a.issue === null && ev.issue !== null) {
    a.issue = ev.issue;
    enforceSingle(model, a.issue, ev.t);
  }
}

// Reprise (ADR 0008, règle 1) : un signal de `ts` strictement postérieur à la fin ouvre un nouveau cycle. `id` et
// `since` restent ceux du premier cycle ; `block` et `verdict` du cycle précédent ne sont plus affichés.
function reopenAgent(a, ev) {
  a.finishedAt = null;
  a.phase = ev.type === "agent.reported" ? "reported" : "running";
  a.verdict = null;
  a.block = null;
}

// Le mode d'un architecte se déduit du bloc de son rapport (ADR 0008, règle 4), donc sa station.
function deduceMode(a) {
  if (a.type === "architecte" && a.block !== null && Object.prototype.hasOwnProperty.call(BLOCK_MODE, a.block)) {
    a.mode = BLOCK_MODE[a.block];
  }
  a.station = agentStation(a.type, a.mode);
}

function applyAgentEvent(model, ev) {
  const a = locateAgent(model, ev);
  // Un agent passé en `unknown` par `tick` reprend vie dès qu'un signal arrive.
  if (a.phase === "unknown") a.phase = a.agentId === null ? "requested" : "running";
  const finishedAt = toMs(a.finishedAt);
  if (a.phase === "finished" && finishedAt !== null && ev.t > finishedAt && REOPENING_EVENTS.has(ev.type)) reopenAgent(a, ev);
  enrichAgent(model, a, ev);
  deduceMode(a);
  if (isActive(a) && iso(ev.t) > a.updatedAt) a.updatedAt = iso(ev.t);
  switch (ev.type) {
    case "agent.launched":
    case "agent.started":
      if (a.phase === "requested") a.phase = "running";
      break;
    case "agent.reported":
      if (a.phase === "requested" || a.phase === "running") a.phase = "reported";
      break;
    case "agent.finished":
      finish(a, ev.t);
      break;
    default:
      break;
  }
}

// Un `feature.status` vers `status` fait sortir de leur station les agents de cette issue.
function leaveStation(model, issue, status, t) {
  const target = status === "blocked" ? ESCALADE : stationForStatus(status);
  if (target === null) return;
  for (const a of model.agents) {
    if (a.issue !== issue || !isActive(a)) continue;
    const station = agentStation(a.type, a.mode);
    if (station !== null && station !== target) finish(a, t);
  }
}

// --- Événements v1 -------------------------------------------------------------------------------------------------

function fieldIsValid(kind, value) {
  switch (kind) {
    case "s":
      return str(value) !== null;
    case "n":
      return posInt(value) !== null;
    case "id":
      return normalizeAgentId(value) !== null;
    case "source":
      return value === "stop" || value === "tool";
    default:
      return false;
  }
}

// { kind: "ok", event } | { kind: "unknown" } (ignoré en silence) | { kind: "invalid", type, fields }.
function inspectEvent(raw) {
  if (!isObject(raw)) return { kind: "invalid", type: "?", fields: ["événement"] };
  if (typeof raw.type !== "string") return { kind: "invalid", type: "?", fields: ["type"] };
  const spec = REQUIRED_FIELDS[raw.type];
  if (spec === undefined) return { kind: "unknown" };
  const missing = [];
  if (!Number.isInteger(raw.v) || raw.v < 1) missing.push("v");
  const t = typeof raw.ts === "string" ? toMs(raw.ts) : null;
  if (t === null) missing.push("ts");
  if (missing.length > 0) return { kind: "invalid", type: raw.type, fields: missing };
  if (raw.v > SCHEMA_VERSION) return { kind: "unknown" };
  for (const [name, kind] of Object.entries(spec)) {
    if (!fieldIsValid(kind, raw[name])) missing.push(name);
  }
  if (missing.length > 0) return { kind: "invalid", type: raw.type, fields: missing };
  return {
    kind: "ok",
    event: {
      type: raw.type,
      t,
      sessionId: str(raw.sessionId),
      toolUseId: str(raw.toolUseId),
      agentId: normalizeAgentId(raw.agentId),
      agentType: shortType(raw.agentType),
      mode: str(raw.mode),
      issue: posInt(raw.issue),
      pr: posInt(raw.pr),
      attempt: Number.isInteger(raw.attempt) ? raw.attempt : null,
      retry: posInt(raw.retry),
      status: str(raw.status),
      verdict: str(raw.verdict),
      block: str(raw.block),
      ref: str(raw.ref),
    },
  };
}

function applyFeatureStatus(model, ev) {
  if (!STATUSES.includes(ev.status)) return;
  let f = model.features.find((x) => x.number === ev.issue);
  if (!f) {
    f = { number: ev.issue, title: null, milestone: null, status: ev.status, retry: 0, pr: null, station: null, escalated: false };
    model.features.push(f);
    model.features.sort(byNumber);
  }
  const before = f.status;
  if (ev.status === "blocked") {
    // Station d'accolement, comme le serveur : la dernière station connue par les événements `feature.status`
    // reçus (hors blocked), sinon `dev`. Une feature déjà bloquée garde la sienne.
    if (before !== "blocked" || !f.station) f.station = model.lastStation[ev.issue] || DEFAULT_BLOCKED_STATION;
  } else {
    model.lastStation[ev.issue] = STATUS_STATION[ev.status];
  }
  leaveStation(model, ev.issue, ev.status, ev.t);
  f.status = ev.status;
  if (ev.status === "done") f.retry = 0;
  restate(model);
}

function applyEvent(model, ev) {
  switch (ev.type) {
    case "agent.requested":
    case "agent.launched":
    case "agent.started":
    case "agent.reported":
    case "agent.finished":
      applyAgentEvent(model, ev);
      sortAgents(model.agents);
      break;

    case "feature.status":
      applyFeatureStatus(model, ev);
      break;

    case "feature.retry": {
      // Une feature inconnue n'est pas affichable avant son premier `feature.status` : l'événement est sans effet.
      const f = model.features.find((x) => x.number === ev.issue);
      if (f) f.retry = ev.retry;
      break;
    }

    case "milestone.changed": {
      const m = model.milestones.find((x) => x.number === Number.parseInt(ev.ref, 10));
      const state = typeof ev.status === "string" ? ev.status.toLowerCase() : "";
      if (m && (state === "open" || state === "closed")) {
        m.state = state;
        restate(model);
      }
      break;
    }

    case "release.opened":
      if (!model.releases.some((r) => r.branch === ev.ref)) {
        model.releases.push({ branch: ev.ref, pr: null, state: "open", title: null, milestone: milestoneForBranch(ev.ref, model.milestones) });
        model.releases.sort((x, y) => byText(x.branch, y.branch));
        restate(model);
      }
      break;

    case "pr.merged":
      for (const r of model.releases) if (r.pr === ev.pr) r.state = "merged";
      restate(model);
      break;

    default:
      // pr.opened, issue.created, issue.closed : reconnus, sans effet direct (le numéro de la PR ou de l'issue créée
      // n'est connu qu'au prochain `snapshot`).
      break;
  }
  const latest = iso(ev.t);
  if (model.updatedAt === null || latest > model.updatedAt) model.updatedAt = latest;
}

// --- Avertissements ---------------------------------------------------------------------------------------------------

function addWarnings(model, incoming) {
  for (const w of incoming) {
    const dup = model.warnings.findIndex((x) => x.code === w.code && x.message === w.message);
    if (dup !== -1) model.warnings.splice(dup, 1);
    model.warnings.push(w);
  }
  if (model.warnings.length > MAX_WARNINGS) model.warnings.splice(0, model.warnings.length - MAX_WARNINGS);
}

// Avertissement SSE : exactement { code, message, at } (trois chaînes non vides, `at` est une date), sinon `null`.
// Plus strict que `normalizeWarning`, qui lit l'état `/state` et tolère un `at` absent.
function strictWarning(data) {
  if (!isObject(data)) return null;
  const code = str(data.code);
  const message = str(data.message);
  const at = str(data.at);
  if (code === null || message === null || at === null || toMs(at) === null) return null;
  return { code, message, at };
}

// --- Transitions -------------------------------------------------------------------------------------------------------

// Différences entre deux modèles, dans un ordre déterministe : milestones, releases, features (par numéro), agents (par id).
export function diff(before, after) {
  const out = [];

  const oldMs = new Map(before.milestones.map((m) => [m.number, m]));
  for (const m of after.milestones) {
    const old = oldMs.get(m.number);
    if (old && old.state !== m.state) out.push({ kind: "milestone", id: m.number, from: old.state, to: m.state });
  }

  const oldRel = new Map(before.releases.map((r) => [r.branch, r]));
  for (const r of after.releases) {
    const old = oldRel.get(r.branch);
    if (!old) out.push({ kind: "release", id: r.branch, from: null, to: r.state });
    else if (old.state !== r.state) out.push({ kind: "release", id: r.branch, from: old.state, to: r.state });
  }

  const oldFeatures = new Map(before.features.map((f) => [f.number, f]));
  const newFeatures = new Map(after.features.map((f) => [f.number, f]));
  const numbers = [...new Set([...oldFeatures.keys(), ...newFeatures.keys()])].sort((x, y) => x - y);
  for (const n of numbers) {
    const old = oldFeatures.get(n);
    const cur = newFeatures.get(n);
    if (!old) out.push({ kind: "feature-add", id: n, from: null, to: placeOf(cur) });
    else if (!cur) out.push({ kind: "feature-remove", id: n, from: placeOf(old), to: null });
    else {
      if (placeOf(old) !== placeOf(cur)) out.push({ kind: "feature-move", id: n, from: placeOf(old), to: placeOf(cur) });
      else if (old.status !== cur.status) out.push({ kind: "feature-status", id: n, from: old.status, to: cur.status });
      if (old.retry !== cur.retry) out.push({ kind: "feature-retry", id: n, from: old.retry, to: cur.retry });
    }
  }

  const oldAgents = new Map(before.agents.map((a) => [a.id, a]));
  const newAgents = new Map(after.agents.map((a) => [a.id, a]));
  const ids = [...new Set([...oldAgents.keys(), ...newAgents.keys()])].sort(byText);
  for (const id of ids) {
    const old = oldAgents.get(id);
    const cur = newAgents.get(id);
    if (!old) out.push({ kind: "agent-add", id, from: null, to: cur.station });
    else if (!cur) out.push({ kind: "agent-remove", id, from: old.station, to: null });
    else {
      if (old.station !== cur.station) out.push({ kind: "agent-move", id, from: old.station, to: cur.station });
      if (old.phase !== cur.phase) out.push({ kind: "agent-phase", id, from: old.phase, to: cur.phase });
    }
  }
  return out;
}

// --- Points d'entrée -----------------------------------------------------------------------------------------------------

// Lit un message SSE strict : { kind, data } (data parsée), `null` (nom d'événement inconnu : ignoré en silence) ou
// { error } (message mal formé : à signaler par EVENT_ERROR). Le détail brut du message n'entre jamais dans l'erreur.
function readMessage(message) {
  if (!isObject(message) || typeof message.event !== "string") return { error: "message SSE sans nom d'événement `event`" };
  if (!SSE_EVENTS.has(message.event)) return null;
  if (typeof message.data !== "string") return { error: `message SSE "${message.event}" ignoré : data n'est pas une chaîne JSON` };
  try {
    return { kind: message.event, data: JSON.parse(message.data) };
  } catch {
    return { error: `message SSE "${message.event}" ignoré : data n'est pas du JSON valide` };
  }
}

function warn(model, code, message) {
  const next = structuredClone(model);
  addWarnings(next, [{ code, message, at: next.updatedAt }]);
  return next;
}

const eventError = (model, text) => ({ model: warn(model, "EVENT_ERROR", text), transitions: [] });

// Applique un message SSE (format strict : voir l'en-tête). Renvoie toujours { model, transitions } : le même modèle
// et aucune transition si le message est ignoré en silence ou sans effet, un modèle qui porte un avertissement
// (`EVENT_ERROR`, `EVENT_INCOMPLETE`) s'il est mal formé. Ne lève jamais d'exception.
export function apply(model, message) {
  const unchanged = { model, transitions: [] };
  try {
    const msg = readMessage(message);
    if (msg === null) return unchanged;
    if (msg.error) return eventError(model, msg.error);

    if (msg.kind === "snapshot") {
      if (!isObject(msg.data)) return eventError(model, 'message SSE "snapshot" ignoré : data n\'est pas un objet /state');
      const next = init(msg.data);
      return { model: next, transitions: diff(model, next) };
    }

    if (msg.kind === "warning") {
      const incoming = strictWarning(msg.data);
      if (incoming === null) return eventError(model, 'message SSE "warning" ignoré : data n\'a pas la forme { code, message, at }');
      const next = structuredClone(model);
      addWarnings(next, [incoming]);
      return { model: next, transitions: [] };
    }

    // `evt` : un événement v1, ou un lot (tableau) appliqué trié par `ts`, à égalité dans l'ordre reçu (ADR 0008).
    if (!isObject(msg.data) && !Array.isArray(msg.data)) return eventError(model, 'message SSE "evt" ignoré : data n\'est ni un événement ni un lot');
    const valid = [];
    const invalid = [];
    (Array.isArray(msg.data) ? msg.data : [msg.data]).forEach((raw, index) => {
      const r = inspectEvent(raw);
      if (r.kind === "ok") valid.push({ ...r.event, i: index });
      else if (r.kind === "invalid") invalid.push(r);
    });
    if (valid.length === 0 && invalid.length === 0) return unchanged;
    const next = structuredClone(model);
    valid.sort((x, y) => x.t - y.t || x.i - y.i);
    for (const ev of valid) applyEvent(next, ev);
    for (const r of invalid) {
      addWarnings(next, [{ code: "EVENT_INCOMPLETE", message: `événement "${r.type}" ignoré : champ obligatoire manquant ou invalide (${r.fields.join(", ")})`, at: next.updatedAt }]);
    }
    return { model: next, transitions: diff(model, next) };
  } catch (error) {
    return eventError(model, `message ignoré : ${error && error.message}`);
  }
}

// Fait avancer l'horloge du modèle : retire les agents terminés depuis AGENT_FINISHED_TTL_MS, et passe en `unknown`
// ceux qui n'ont rien signalé depuis AGENT_UNKNOWN_AFTER_MS (sans les déclarer terminés), comme le fait le serveur.
// `now` : nombre de ms, `Date` ou chaîne ISO.
export function tick(model, now) {
  const nowMs = toMs(now);
  if (nowMs === null) return { model, transitions: [] };
  const next = structuredClone(model);
  next.agents = next.agents.filter((a) => !(a.phase === "finished" && nowMs - (toMs(a.finishedAt) ?? toMs(a.updatedAt) ?? nowMs) >= AGENT_FINISHED_TTL_MS));
  for (const a of next.agents) {
    if (a.phase !== "finished" && a.phase !== "unknown" && nowMs - (toMs(a.updatedAt) ?? nowMs) >= AGENT_UNKNOWN_AFTER_MS) a.phase = "unknown";
  }
  const transitions = diff(model, next);
  return transitions.length === 0 ? { model, transitions } : { model: next, transitions };
}
