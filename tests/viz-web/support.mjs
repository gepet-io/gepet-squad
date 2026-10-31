// Aides communes aux tests de viz-web : construction d'états `/state`, d'événements v1 et de messages SSE.
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).

export const T0 = Date.parse("2026-10-30T10:00:00.000Z");
export const MIN = 60 * 1000;
export const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();

export const SESSION = "session-1";
export const DEV = "claude-gepet-squad:developpeur";
export const VERIF = "claude-gepet-squad:verificateur";
export const TEST = "claude-gepet-squad:testeur";
export const ARCHI = "claude-gepet-squad:architecte";

export const M1 = "M1 — Socle";
export const M2 = "M2 — API";

// Événement v1 ; `minutes` est le décalage par rapport à T0.
export function ev(type, minutes, fields = {}) {
  return { v: 1, ts: at(minutes), src: "hook", type, sessionId: SESSION, ...fields };
}

// Messages SSE tels que les produira viz-server (#8).
export const evt = (type, minutes, fields) => ({ event: "evt", data: ev(type, minutes, fields) });
export const snapshotMsg = (state) => ({ event: "snapshot", data: state });
export const warningMsg = (data) => ({ event: "warning", data });

// Feature au format `/state`, sans station (elle est calculée par `init`).
export function feature(number, status, extra = {}) {
  return { number, title: `Feature ${number}`, milestone: M1, status, retry: 0, pr: null, ...extra };
}

// Agent au format `/state`.
export function agent(id, extra = {}) {
  return {
    id, type: "developpeur", mode: null, issue: null, pr: null, attempt: null, station: "dev", phase: "running",
    since: at(0), updatedAt: at(0), finishedAt: null, verdict: null, block: null, agentId: null, toolUseId: id,
    ...extra,
  };
}

export function milestone(number, title, state = "open") {
  return { number, title, state, total: 0, done: 0 };
}

// État `/state` minimal.
export function stateOf(extra = {}) {
  return {
    repo: "o/r",
    updatedAt: at(0),
    milestones: [milestone(1, M1), milestone(2, M2)],
    features: [],
    agents: [],
    releases: [],
    warnings: [],
    ...extra,
  };
}

export function deepFreeze(value) {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
