"use strict";
// Réducteur d'état de la visualisation : (instantané GitHub, événements du journal, horloge) -> état `/state`.
// Module pur : aucune I/O, aucune exception, aucune mutation des arguments, aucun appel à `Date.now()` si `now` est donné.
// Références : ARCHITECTURE § 6, ADR 0003 (état fusionné), ADR 0004 (corrélation des agents) et ADR 0008 (reprise
// d'un agent).
//
// ---------------------------------------------------------------------------------------------------------
// Forme de l'état renvoyé par `reduce(snapshot, events, now)` (contrat `/state`, consommé par `viz-web`)
// ---------------------------------------------------------------------------------------------------------
//   {
//     repo:       "owner/nom" | null,             // celui de l'instantané
//     updatedAt:  "2026-10-30T10:00:00.000Z",     // `now`
//     milestones: [{ number, title, state: "open"|"closed", total, done }],
//     features:   [{ number, title, milestone, status, retry, pr, station, escalated }],
//     agents:     [{ id, type, mode, issue, pr, attempt, station, phase, since, updatedAt, finishedAt,
//                    verdict, block, agentId, toolUseId }],
//     releases:   [{ branch, pr, state: "open"|"merged"|"closed", title, milestone }],
//     warnings:   [{ code, message, at }]
//   }
//
// - `features[]`, `milestones[]` : triés par numéro. `title` et `milestone` (titre du milestone) valent `null` s'ils
//   sont inconnus. `retry` vaut 0 sans label `retry:K`. `pr` est le numéro de la PR de la feature, ou `null`.
// - `station` d'une feature : "roadmap" | "dev" | "verification" | "test" | "merge" | "release" (voir STATIONS).
//   Une feature `blocked` porte `escalated: true` et, dans `station`, la station à laquelle la zone « escalade »
//   est accolée : la dernière station connue par le journal (hors `blocked`), ou "dev" à défaut.
// - `agents[]` : triés par `since`. `type` est le nom court de l'agent (`developpeur`, sans le préfixe
//   `gepet-squad:`, ou `claude-gepet-squad:` dans les anciens journaux). `id` est la clé de corrélation d'origine (`toolUseId`, sinon `agentId`) et ne change
//   plus ensuite. `phase` : requested | running | reported | finished | unknown. `since` : premier signal ;
//   `updatedAt` : dernier signal ; `finishedAt` : fin (agents `finished`), sinon `null`. Toutes les dates sont ISO.
//   `station` : "cadrage" | "roadmap" | "dev" | "verification" | "test" | "escalade" ou `null`.
// - `releases[]` : PR `release/*` de l'instantané, plus les `release.opened` postérieurs. `milestone` : titre du
//   milestone `M<k>` correspondant à la branche `release/m<k>-…`, ou `null`.
// - `warnings[]` : ceux de l'appelant (`reduce(snapshot, events, now, { warnings })`, p. ex. `GH_AUTH`, `GH_TIMEOUT`,
//   `GH_PARSE`, `GH_MISSING`, `GH_REPO`, `GH_CONFIG` ; seuls `code`, `message` et `at` sont recopiés), puis
//   les codes `SNAPSHOT_MISSING`, `SNAPSHOT_STALE`, `EVENT_INCOMPLETE` (un avertissement par type
//   d'événement ignoré), `EVENT_ERROR`. Vide quand tout va bien.
//
// ---------------------------------------------------------------------------------------------------------
// Instantané attendu (produit par `fetchSnapshot()` de `viz/lib/github.cjs`)
// ---------------------------------------------------------------------------------------------------------
//   { repo, fetchedAt, issues[], milestones[], pulls[] }
//   issues[]     { number, title, state: "open"|"closed", labels: string[], status, retry, milestone, milestoneNumber }
//                `status` : valeur du label `status:*` sans préfixe, ou null ; `retry` : plus grand K de `retry:K`,
//                ou null ; `milestone` : titre ou null. Sans `status`/`retry`, ils sont relus dans `labels`.
//   milestones[] { number, title, state: "open"|"closed", openIssues, closedIssues, dueOn }
//   pulls[]      { number, title, state: "open"|"merged"|"closed", head, base, url, draft, mergedAt }
//   (`headRefName`/`baseRefName` sont acceptés à la place de `head`/`base`, et les labels `{ name }` comme des chaînes.)
//   Les états sont lus sans tenir compte de la casse. Seules les issues qui portent un `status:*` sont des
//   features ; une issue fermée sans `status:done` (remplacée) en est écartée.
//
// ---------------------------------------------------------------------------------------------------------
// Règles de fusion
// ---------------------------------------------------------------------------------------------------------
// - GitHub fait foi. Les événements `feature.*` et `milestone.changed` ne modifient l'état d'une feature ou d'un
//   milestone que s'ils sont postérieurs à `snapshot.fetchedAt`. Les plus anciens sont déjà dans l'instantané.
// - Les agents ne viennent que du journal : tous les événements `agent.*` comptent, quelle que soit leur date.
// - Un événement est ignoré, sans exception et sans effet, si son type est inconnu, si sa version dépasse celle
//   du schéma, ou s'il manque un champ obligatoire de son type (ARCHITECTURE § 6, « Champs par type »).
//   Les types inconnus sont ignorés en silence ; les événements incomplets sont signalés dans `warnings`.
// - `ref` et `status` s'interprètent selon le type : `pr.opened`/`release.opened` -> branche ; `issue.created` ->
//   titre du milestone ; `milestone.changed` -> numéro du milestone en chaîne, `status` = `open`|`closed`.
//   Les numéros de PR et d'issue créées ne sont connus qu'au prochain instantané : `pr.opened`, `issue.created` et
//   `issue.closed` sont donc reconnus mais sans effet direct (la PR d'une feature vient de l'instantané, ou de la
//   `PR:` de la mission d'un agent).
// - Corrélation des agents (ADR 0004) : clé `toolUseId`, puis `agentId` (préfixe `agent-` retiré) ; en l'absence de
//   correspondance, FIFO par type d'agent sur les agents `requested` qui n'ont pas encore d'`agentId` (de la même
//   session) ; au plus un agent `developpeur`/`verificateur`/`testeur` actif par issue (le plus récent) ;
//   sans signal depuis 45 min, un agent passe en `unknown` sans être déclaré terminé.
// - Cycle de vie non monotone (ADR 0008) : les événements `agent.*` sont appliqués par `ts` croissant (à égalité,
//   dans l'ordre du journal). Un agent a une suite de cycles sous le même `agentId`. Un `agent.finished` ou un
//   `feature.status` qui fait sortir l'issue de la station de l'agent clôt le cycle en cours ; un `finished` reçu
//   sur un agent déjà `finished` n'ajoute qu'un `block`/`verdict` manquant. Un `started`, `launched` ou `reported`
//   de `ts` strictement postérieur au `finishedAt` rouvre un cycle (reprise par `SendMessage`) : `finishedAt`
//   revient à `null`, `running` (ou `reported`) et `block`/`verdict` repartent de `null`. Un `reported` de
//   `ts` <= `finishedAt` (écriture tardive) ne rouvre rien. `id` et `since` restent ceux du premier cycle.
//   Le `mode` d'un architecte se déduit du `block` de son rapport (BLOCK_MODE), donc sa station.
// - Purge : on garde les agents de la session la plus récente (celle du dernier événement portant un `sessionId`),
//   non terminés, ou terminés depuis moins de 10 min. Les autres sont retirés.

const {
  SCHEMA_VERSION,
  EVENT_TYPES,
  FINISH_SOURCES,
  isPlainObject,
  normalizeAgentId,
} = require("../../hooks/lib/schema.cjs");

const STATIONS = Object.freeze(["cadrage", "roadmap", "dev", "verification", "test", "merge", "release"]);
const ESCALADE = "escalade";
const DEFAULT_BLOCKED_STATION = "dev";

// Statut `status:*` -> station (ARCHITECTURE § 6). `blocked` n'a pas de station propre : voir `escalated`.
const STATUS_STATION = Object.freeze({
  backlog: "roadmap",
  ready: "roadmap",
  "in-progress": "dev",
  "changes-requested": "dev",
  "in-review": "verification",
  "in-test": "test",
  done: "merge",
});
const STATUSES = Object.freeze([...Object.keys(STATUS_STATION), "blocked"]);

const AGENT_FINISHED_TTL_MS = 10 * 60 * 1000;
const AGENT_UNKNOWN_AFTER_MS = 45 * 60 * 1000;
const SNAPSHOT_STALE_AFTER_MS = 5 * 60 * 1000;

// Nouveau préfixe, puis l'ancien (avant le renommage du plugin) : les journaux existants restent lisibles.
const AGENT_PREFIXES = ["gepet-squad:", "claude-gepet-squad:"];
// Agents rattachés à une issue, dont un seul peut être actif à la fois.
const SINGLE_PER_ISSUE = new Set(["developpeur", "verificateur", "testeur"]);
const PHASE_ORDER = { requested: 0, running: 1, reported: 2, finished: 3 };
// Bloc de rapport de l'architecte -> mode (ADR 0008, règle 4). `SendMessage` ne transporte pas le MODE, le rapport si.
const BLOCK_MODE = Object.freeze({
  QUESTIONS: "CADRAGE_QUESTIONS",
  PROPOSITION: "CADRAGE_PROPOSITION",
  PITCH: "CADRAGE_FINALISATION",
  VERDICT_ROADMAP: "REVUE_ROADMAP",
  ESCALADE: "ESCALADE",
});
const REOPENING_EVENTS = new Set(["agent.started", "agent.launched", "agent.reported"]);

// Champs obligatoires de chaque type (ARCHITECTURE § 6). "s" : chaîne non vide ; "n" : entier >= 1 ;
// "id" : identifiant d'agent non vide après normalisation ; "source" : `stop` ou `tool`.
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

function toMs(value) {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function iso(ms) {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

function str(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function posInt(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

// Variantes d'un rôle, affichées comme le rôle lui-même (agents/developpeur-outille.md).
const TYPE_ALIASES = { "developpeur-outille": "developpeur" };

function shortType(agentType) {
  const s = str(agentType);
  if (s === null) return null;
  const prefix = AGENT_PREFIXES.find((p) => s.startsWith(p));
  const short = prefix === undefined ? s : s.slice(prefix.length);
  return Object.hasOwn(TYPE_ALIASES, short) ? TYPE_ALIASES[short] : short;
}

function stationForStatus(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_STATION, status) ? STATUS_STATION[status] : null;
}

// Station d'un agent : son type pour les agents d'issue, le MODE pour l'architecte.
function agentStation(type, mode) {
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

// --- Validation des événements -------------------------------------------------------------------------------

function fieldIsValid(kind, value) {
  switch (kind) {
    case "s":
      return str(value) !== null;
    case "n":
      return posInt(value) !== null;
    case "id":
      return normalizeAgentId(value) !== undefined;
    case "source":
      return FINISH_SOURCES.includes(value);
    default:
      return false;
  }
}

// Retourne { kind: "ok", event } | { kind: "unknown" } (ignoré en silence) | { kind: "invalid", type, fields }.
function inspectEvent(raw, index) {
  if (!isPlainObject(raw)) return { kind: "invalid", type: "?", fields: ["événement"] };
  const type = typeof raw.type === "string" ? raw.type : "?";
  if (typeof raw.type === "string" && !EVENT_TYPES.includes(raw.type)) return { kind: "unknown" };
  if (typeof raw.type !== "string") return { kind: "invalid", type, fields: ["type"] };

  const missing = [];
  if (!Number.isInteger(raw.v) || raw.v < 1) missing.push("v");
  const t = typeof raw.ts === "string" ? toMs(raw.ts) : null;
  if (t === null) missing.push("ts");
  if (missing.length > 0) return { kind: "invalid", type, fields: missing };
  // Un producteur plus récent : on ne sait pas lire son schéma.
  if (raw.v > SCHEMA_VERSION) return { kind: "unknown" };

  const spec = REQUIRED_FIELDS[type];
  for (const [name, kind] of Object.entries(spec)) {
    if (!fieldIsValid(kind, raw[name])) missing.push(name);
  }
  if (missing.length > 0) return { kind: "invalid", type, fields: missing };

  return {
    kind: "ok",
    event: {
      type,
      t,
      i: index,
      sessionId: str(raw.sessionId),
      toolUseId: str(raw.toolUseId),
      agentId: normalizeAgentId(raw.agentId) || null,
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

// --- Instantané GitHub ---------------------------------------------------------------------------------------

const PR_STATE_RANK = { open: 3, merged: 2, closed: 1 };

function lower(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function labelNames(labels) {
  if (!Array.isArray(labels)) return [];
  const names = [];
  for (const l of labels) {
    const name = typeof l === "string" ? l : isPlainObject(l) ? l.name : null;
    if (typeof name === "string") names.push(name.trim());
  }
  return names;
}

function parseIssue(raw) {
  if (!isPlainObject(raw)) return null;
  const number = posInt(raw.number);
  if (number === null) return null;
  const labels = labelNames(raw.labels);
  let status = null;
  let retry = 0;
  for (const label of labels) {
    const s = /^status:(.+)$/.exec(label);
    if (s && status === null && STATUSES.includes(s[1])) status = s[1];
    const r = /^retry:(\d+)$/.exec(label);
    if (r) retry = Math.max(retry, Number.parseInt(r[1], 10));
  }
  if (status === null && STATUSES.includes(raw.status)) status = raw.status;
  if (retry === 0 && posInt(raw.retry) !== null) retry = raw.retry;
  const m = raw.milestone;
  const milestone = typeof m === "string" ? str(m) : isPlainObject(m) ? str(m.title) : null;
  return { number, title: str(raw.title), milestone, status, retry, closed: lower(raw.state) === "closed" };
}

function parseMilestone(raw) {
  if (!isPlainObject(raw)) return null;
  const number = posInt(raw.number);
  const title = str(raw.title);
  if (number === null || title === null) return null;
  return { number, title, state: lower(raw.state) === "closed" ? "closed" : "open" };
}

function parsePull(raw) {
  if (!isPlainObject(raw)) return null;
  const number = posInt(raw.number);
  const head = str(raw.head) ?? str(raw.headRefName);
  if (number === null || head === null) return null;
  const state = lower(raw.state);
  return {
    number,
    head,
    base: str(raw.base) ?? str(raw.baseRefName),
    title: str(raw.title),
    state: state === "merged" ? "merged" : state === "closed" ? "closed" : "open",
  };
}

function parseSnapshot(snapshot, nowMs) {
  const empty = { present: false, repo: null, fetchedAt: null, issues: [], milestones: [], pulls: [] };
  if (!isPlainObject(snapshot)) return empty;
  const list = (value, parse) => (Array.isArray(value) ? value.map(parse).filter((x) => x !== null) : []);
  const fetchedAt = toMs(snapshot.fetchedAt);
  return {
    present: true,
    repo: str(snapshot.repo),
    // Sans date de prise de vue, l'instantané est réputé pris à l'instant : il l'emporte sur tout le journal.
    fetchedAt: fetchedAt === null ? nowMs : fetchedAt,
    issues: list(snapshot.issues, parseIssue),
    milestones: list(snapshot.milestones, parseMilestone),
    pulls: list(snapshot.pulls, parsePull),
  };
}

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

// PR de la feature N : branche `feature/N-…`, la plus pertinente (ouverte > mergée > fermée, puis la plus récente).
function featurePrNumbers(pulls) {
  const best = new Map();
  for (const p of pulls) {
    const m = /^feature\/(\d+)(?:-|$)/.exec(p.head);
    if (!m) continue;
    const issue = Number.parseInt(m[1], 10);
    const current = best.get(issue);
    const better =
      !current ||
      PR_STATE_RANK[p.state] > PR_STATE_RANK[current.state] ||
      (PR_STATE_RANK[p.state] === PR_STATE_RANK[current.state] && p.number > current.number);
    if (better) best.set(issue, p);
  }
  return new Map([...best].map(([issue, p]) => [issue, p.number]));
}

// --- Agents : corrélation et cycle de vie (ADR 0004) ---------------------------------------------------------

function createAgentBook() {
  const agents = new Map(); // clé d'origine -> agent, dans l'ordre de création
  const byToolUse = new Map();
  const byAgentId = new Map();
  let seq = 0;

  function bindToolUse(a, toolUseId) {
    if (toolUseId && a.toolUseId === null) {
      a.toolUseId = toolUseId;
      byToolUse.set(toolUseId, a);
    }
  }

  function bindAgentId(a, agentId, binding) {
    if (!agentId) return;
    if (a.agentId === null) {
      a.agentId = agentId;
      a.binding = binding;
      byAgentId.set(agentId, a);
    } else if (a.agentId === agentId && binding === "exact") {
      a.binding = "exact";
    }
  }

  function create(ev) {
    const key = ev.toolUseId || ev.agentId;
    const a = {
      key,
      seq: seq++,
      toolUseId: null,
      agentId: null,
      binding: null,
      type: null,
      mode: null,
      issue: null,
      pr: null,
      attempt: null,
      sessionId: null,
      phase: "requested",
      since: ev.t,
      updatedAt: ev.t,
      finishedAt: null,
      verdict: null,
      block: null,
    };
    agents.set(key, a);
    bindToolUse(a, ev.toolUseId);
    bindAgentId(a, ev.agentId, "exact");
    return a;
  }

  function furthest(p, q) {
    return PHASE_ORDER[p] >= PHASE_ORDER[q] ? p : q;
  }

  // Fusionne `b` (connu seulement par son agentId) dans `a` (connu par son toolUseId).
  function merge(a, b) {
    agents.delete(b.key);
    byAgentId.set(b.agentId, a);
    a.agentId = b.agentId;
    a.binding = "exact";
    for (const f of ["type", "mode", "issue", "pr", "attempt", "sessionId", "verdict", "block"]) {
      if (a[f] === null) a[f] = b[f];
    }
    a.phase = furthest(a.phase, b.phase);
    if (b.finishedAt !== null && a.finishedAt === null) a.finishedAt = b.finishedAt;
    a.since = Math.min(a.since, b.since);
    a.updatedAt = Math.max(a.updatedAt, b.updatedAt);
  }

  // `b` avait pris l'agentId `X` par FIFO, mais `a` (le toolUseId fait foi) le revendique : on le lui rend.
  function steal(a, b) {
    const id = b.agentId;
    byAgentId.set(id, a);
    a.agentId = id;
    a.binding = "exact";
    a.phase = furthest(a.phase, b.phase);
    a.finishedAt = a.finishedAt === null ? b.finishedAt : a.finishedAt;
    a.verdict = a.verdict === null ? b.verdict : a.verdict;
    a.block = a.block === null ? b.block : a.block;
    a.updatedAt = Math.max(a.updatedAt, b.updatedAt);
    b.agentId = null;
    b.binding = null;
    b.phase = "requested";
    b.verdict = null;
    b.block = null;
    b.finishedAt = null;
    b.updatedAt = b.since;
  }

  function reconcile(a, b) {
    if (b.toolUseId === null && a.agentId === null) merge(a, b);
    else if (b.toolUseId !== null && b.binding === "fifo" && a.agentId === null) steal(a, b);
    // Deux agents déjà reliés chacun de façon certaine : conflit impossible, le premier gagne.
    return a;
  }

  // Plus ancien agent `requested` de ce type qui n'a pas encore d'agentId, dans la même session.
  function fifoCandidate(type, sessionId) {
    for (const a of agents.values()) {
      const sameSession = a.sessionId === null || sessionId === null || a.sessionId === sessionId;
      if (a.type === type && a.agentId === null && a.phase === "requested" && sameSession) return a;
    }
    return null;
  }

  function locate(ev) {
    let a = ev.toolUseId ? byToolUse.get(ev.toolUseId) : undefined;
    const b = ev.agentId ? byAgentId.get(ev.agentId) : undefined;
    if (a && b && a !== b) {
      a = reconcile(a, b);
    } else if (!a && b) {
      a = b;
      bindToolUse(a, ev.toolUseId);
    } else if (a && !b) {
      bindAgentId(a, ev.agentId, "exact");
    } else if (a && b) {
      bindAgentId(a, ev.agentId, "exact");
    }
    if (!a && !ev.toolUseId && ev.agentId && ev.agentType) {
      a = fifoCandidate(ev.agentType, ev.sessionId);
      if (a) bindAgentId(a, ev.agentId, "fifo");
    }
    return a || create(ev);
  }

  function isActive(a) {
    return a.phase !== "finished";
  }

  function finish(a, t) {
    if (a.phase === "finished") return;
    a.phase = "finished";
    a.finishedAt = t;
    a.updatedAt = t;
  }

  // Au plus un agent actif développeur/vérificateur/testeur par issue : le plus récent l'emporte.
  function enforceSingle(issue, t) {
    if (issue === null) return;
    const active = [...agents.values()].filter((a) => a.issue === issue && SINGLE_PER_ISSUE.has(a.type) && isActive(a));
    active.sort((x, y) => x.seq - y.seq);
    for (const older of active.slice(0, -1)) finish(older, t);
  }

  function enrich(a, ev) {
    if (a.sessionId === null) a.sessionId = ev.sessionId;
    if (a.type === null) a.type = ev.agentType;
    if (a.mode === null) a.mode = ev.mode;
    if (a.pr === null) a.pr = ev.pr;
    if (a.attempt === null) a.attempt = ev.attempt;
    if (a.verdict === null) a.verdict = ev.verdict;
    if (a.block === null) a.block = ev.block;
    if (a.issue === null && ev.issue !== null) {
      a.issue = ev.issue;
      enforceSingle(a.issue, ev.t);
    }
  }

  // Reprise (ADR 0008, règle 1) : un signal de `ts` strictement postérieur à la fin ouvre un nouveau cycle.
  function reopen(a, ev) {
    a.finishedAt = null;
    a.phase = ev.type === "agent.reported" ? "reported" : "running";
    a.verdict = null;
    a.block = null;
  }

  // Le mode d'un architecte se déduit du bloc de son rapport (ADR 0008, règle 4).
  function deduceMode(a) {
    if (a.type === "architecte" && a.block !== null && Object.prototype.hasOwnProperty.call(BLOCK_MODE, a.block)) {
      a.mode = BLOCK_MODE[a.block];
    }
  }

  function touch(a, t) {
    if (isActive(a)) a.updatedAt = Math.max(a.updatedAt, t);
  }

  return {
    apply(ev) {
      const a = locate(ev);
      if (a.phase === "finished" && a.finishedAt !== null && ev.t > a.finishedAt && REOPENING_EVENTS.has(ev.type)) {
        reopen(a, ev);
      }
      enrich(a, ev);
      deduceMode(a);
      touch(a, ev.t);
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
    },

    // Un `feature.status` vers `status` fait sortir de leur station les agents de cette issue.
    leaveStation(issue, status, t) {
      const target = status === "blocked" ? ESCALADE : stationForStatus(status);
      if (target === null) return;
      for (const a of agents.values()) {
        if (a.issue !== issue || !isActive(a)) continue;
        const station = agentStation(a.type, a.mode);
        if (station !== null && station !== target) finish(a, t);
      }
    },

    // Numéro de PR appris par la mission d'un agent, pour les features dont l'instantané n'a pas la PR.
    prByIssue() {
      const map = new Map();
      for (const a of agents.values()) if (a.issue !== null && a.pr !== null) map.set(a.issue, a.pr);
      return map;
    },

    list() {
      return [...agents.values()];
    },
  };
}

function presentAgents(all, nowMs, latestSession) {
  const out = [];
  for (const a of all) {
    const inSession = a.sessionId === null || latestSession === null || a.sessionId === latestSession;
    if (!inSession) continue;
    if (a.phase === "finished" && nowMs - a.finishedAt >= AGENT_FINISHED_TTL_MS) continue;
    const stale = a.phase !== "finished" && nowMs - a.updatedAt >= AGENT_UNKNOWN_AFTER_MS;
    out.push({
      id: a.key,
      type: a.type,
      mode: a.mode,
      issue: a.issue,
      pr: a.pr,
      attempt: a.attempt,
      station: agentStation(a.type, a.mode),
      phase: stale ? "unknown" : a.phase,
      since: iso(a.since),
      updatedAt: iso(a.updatedAt),
      finishedAt: iso(a.finishedAt),
      verdict: a.verdict,
      block: a.block,
      agentId: a.agentId,
      toolUseId: a.toolUseId,
    });
  }
  out.sort((x, y) => (x.since < y.since ? -1 : x.since > y.since ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return out;
}

// --- Réducteur -----------------------------------------------------------------------------------------------

// Avertissements fournis par l'appelant (`options.warnings`, par exemple les erreurs de `fetchSnapshot()` :
// GH_REPO, GH_CONFIG, GH_MISSING, GH_AUTH, GH_TIMEOUT, GH_PARSE). Seuls `code`, `message` et `at` sont recopiés :
// un éventuel détail brut (stderr de `gh`) n'entre jamais dans l'état (ADR 0005).
function externalWarnings(list, at) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list) {
    if (!isPlainObject(w)) continue;
    const code = str(w.code);
    const message = str(w.message);
    if (code === null || message === null) continue;
    const when = typeof w.at === "string" && toMs(w.at) !== null ? w.at : at;
    out.push({ code, message, at: when });
  }
  return out;
}

function reduce(snapshot, events, now, options) {
  const nowMs = toMs(now) ?? Date.now();
  const at = iso(nowMs);
  const snap = parseSnapshot(snapshot, nowMs);
  const warnings = externalWarnings(isPlainObject(options) ? options.warnings : undefined, at);
  const incomplete = new Map(); // type -> { count, fields: Set }

  // 1. Validation et tri chronologique (stable : à date égale, l'ordre du journal).
  const valid = [];
  (Array.isArray(events) ? events : []).forEach((raw, index) => {
    const r = inspectEvent(raw, index);
    if (r.kind === "ok") valid.push(r.event);
    else if (r.kind === "invalid") {
      const entry = incomplete.get(r.type) || { count: 0, fields: new Set() };
      entry.count += 1;
      r.fields.forEach((f) => entry.fields.add(f));
      incomplete.set(r.type, entry);
    }
  });
  valid.sort((x, y) => x.t - y.t || x.i - y.i);

  // 2. Base : l'instantané.
  const features = new Map();
  const prByIssue = featurePrNumbers(snap.pulls);
  for (const issue of snap.issues) {
    if (issue.status === null) continue;
    if (issue.closed && issue.status !== "done") continue;
    features.set(issue.number, {
      number: issue.number,
      title: issue.title,
      milestone: issue.milestone,
      status: issue.status,
      retry: issue.retry,
      pr: prByIssue.get(issue.number) ?? null,
    });
  }
  const milestones = new Map(snap.milestones.map((m) => [m.number, { ...m }]));
  const releases = snap.pulls
    .filter((p) => /^release\//.test(p.head))
    .map((p) => ({
      branch: p.head,
      pr: p.number,
      state: p.state,
      title: p.title,
      milestone: milestoneForBranch(p.head, snap.milestones),
    }));

  // 3. Rejeu du journal. Les agents suivent tout le journal ; features, milestones et releases seulement ce qui
  //    est postérieur à l'instantané (GitHub fait foi), et le journal seul s'il n'y a pas d'instantané.
  const book = createAgentBook();
  const lastStation = new Map(); // issue -> dernière station connue par le journal, hors `blocked`
  let latestSession = null;
  let latestSessionAt = -Infinity;

  for (const ev of valid) {
    try {
      if (ev.sessionId !== null && ev.t >= latestSessionAt) {
        latestSession = ev.sessionId;
        latestSessionAt = ev.t;
      }
      const fresh = !snap.present || ev.t > snap.fetchedAt;

      switch (ev.type) {
        case "agent.requested":
        case "agent.launched":
        case "agent.started":
        case "agent.reported":
        case "agent.finished":
          book.apply(ev);
          break;

        case "feature.status": {
          if (!STATUSES.includes(ev.status)) break;
          if (ev.status !== "blocked") lastStation.set(ev.issue, STATUS_STATION[ev.status]);
          book.leaveStation(ev.issue, ev.status, ev.t);
          if (!fresh) break;
          const f = features.get(ev.issue) || { number: ev.issue, title: null, milestone: null, status: null, retry: 0, pr: null };
          f.status = ev.status;
          if (ev.status === "done") f.retry = 0;
          features.set(ev.issue, f);
          break;
        }

        case "feature.retry": {
          if (!fresh) break;
          const f = features.get(ev.issue) || { number: ev.issue, title: null, milestone: null, status: null, retry: 0, pr: null };
          f.retry = ev.retry;
          features.set(ev.issue, f);
          break;
        }

        case "milestone.changed": {
          const m = milestones.get(Number.parseInt(ev.ref, 10));
          const state = lower(ev.status);
          if (fresh && m && (state === "open" || state === "closed")) m.state = state;
          break;
        }

        case "release.opened":
          if (fresh && !releases.some((r) => r.branch === ev.ref)) {
            releases.push({ branch: ev.ref, pr: null, state: "open", title: null, milestone: milestoneForBranch(ev.ref, snap.milestones) });
          }
          break;

        case "pr.merged":
          if (fresh) for (const r of releases) if (r.pr === ev.pr) r.state = "merged";
          break;

        default:
          // pr.opened, issue.created, issue.closed : reconnus, sans effet direct (voir l'en-tête du module).
          break;
      }
    } catch (error) {
      warnings.push({ code: "EVENT_ERROR", message: `événement ${ev.type} ignoré : ${error && error.message}`, at });
    }
  }

  // 4. Stations des features.
  const agentPrs = book.prByIssue();
  const closedMilestones = new Set([...milestones.values()].filter((m) => m.state === "closed").map((m) => m.title));
  const releasedMilestones = new Set(releases.filter((r) => r.state === "open" && r.milestone).map((r) => r.milestone));

  const featureList = [...features.values()]
    .filter((f) => f.status !== null)
    .sort((x, y) => x.number - y.number)
    .map((f) => {
      const pr = f.pr ?? agentPrs.get(f.number) ?? null;
      let station;
      let escalated = false;
      if (f.status === "blocked") {
        station = lastStation.get(f.number) || DEFAULT_BLOCKED_STATION;
        escalated = true;
      } else if (f.milestone && (closedMilestones.has(f.milestone) || (f.status === "done" && releasedMilestones.has(f.milestone)))) {
        station = "release";
      } else {
        station = STATUS_STATION[f.status];
      }
      return { number: f.number, title: f.title, milestone: f.milestone, status: f.status, retry: f.retry, pr, station, escalated };
    });

  const milestoneList = [...milestones.values()]
    .sort((x, y) => x.number - y.number)
    .map((m) => {
      const own = featureList.filter((f) => f.milestone === m.title);
      return { number: m.number, title: m.title, state: m.state, total: own.length, done: own.filter((f) => f.status === "done").length };
    });

  // 5. Avertissements.
  if (!snap.present) {
    warnings.push({ code: "SNAPSHOT_MISSING", message: "aucun instantané GitHub : état construit à partir du journal seul", at });
  } else if (nowMs - snap.fetchedAt > SNAPSHOT_STALE_AFTER_MS) {
    const minutes = Math.floor((nowMs - snap.fetchedAt) / 60000);
    warnings.push({ code: "SNAPSHOT_STALE", message: `instantané GitHub vieux de ${minutes} min`, at });
  }
  for (const [type, { count, fields }] of incomplete) {
    warnings.push({
      code: "EVENT_INCOMPLETE",
      message: `${count} événement(s) "${type}" ignoré(s) : champ obligatoire manquant ou invalide (${[...fields].join(", ")})`,
      at,
    });
  }

  return {
    repo: snap.repo,
    updatedAt: at,
    milestones: milestoneList,
    features: featureList,
    agents: presentAgents(book.list(), nowMs, latestSession),
    releases: releases.sort((x, y) => (x.branch < y.branch ? -1 : x.branch > y.branch ? 1 : 0)),
    warnings,
  };
}

module.exports = {
  reduce,
  stationForStatus,
  agentStation,
  STATIONS,
  STATUS_STATION,
  STATUSES,
  ESCALADE,
  DEFAULT_BLOCKED_STATION,
  AGENT_FINISHED_TTL_MS,
  AGENT_UNKNOWN_AFTER_MS,
  SNAPSHOT_STALE_AFTER_MS,
};
