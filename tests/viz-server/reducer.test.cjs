// Tests unitaires de viz/lib/reducer.cjs : statuts et stations, priorité GitHub, corrélation des agents,
// cycles complets rejoués à partir des fixtures de hooks (synchrone et arrière-plan), purge, robustesse au contrat.
// L'horloge est toujours injectée : aucun test ne dépend de l'heure réelle.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  reduce,
  STATIONS,
  STATUS_STATION,
  stationForStatus,
  AGENT_FINISHED_TTL_MS,
  AGENT_UNKNOWN_AFTER_MS,
} = require("../../viz/lib/reducer.cjs");
const { EVENT_TYPES } = require("../../hooks/lib/schema.cjs");
const { normalize } = require("../../hooks/lib/normalize.cjs");
const { ghCommandToEvents } = require("../../hooks/lib/gh-command.cjs");

const T0 = Date.parse("2026-10-30T10:00:00.000Z");
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();

const S1 = "session-1";
const S2 = "session-2";
const DEV = "claude-gepet-squad:developpeur";
const VERIF = "claude-gepet-squad:verificateur";
const TEST = "claude-gepet-squad:testeur";
const ARCHI = "claude-gepet-squad:architecte";

// Événement v1 complet ; `minutes` est le décalage par rapport à T0.
function ev(type, minutes, fields = {}) {
  return { v: 1, ts: at(minutes), src: "hook", type, sessionId: S1, ...fields };
}

const M1 = "M1 — Socle";
const M2 = "M2 — API";

// Issue au format de fetchSnapshot() (viz/lib/github.cjs).
function issue(number, status, extra = {}) {
  return {
    number,
    title: `Feature ${number}`,
    state: status === "done" ? "closed" : "open",
    labels: status ? [`status:${status}`] : [],
    status,
    retry: null,
    milestone: M1,
    milestoneNumber: 1,
    ...extra,
  };
}

function pull(number, head, state = "open", base = "develop") {
  return { number, title: `PR ${number}`, state, head, base, url: `https://github.com/o/r/pull/${number}`, draft: false, mergedAt: null };
}

function snapshot(issues, extra = {}) {
  return {
    repo: "o/r",
    fetchedAt: at(0),
    issues,
    milestones: [
      { number: 1, title: M1, state: "open", openIssues: 0, closedIssues: 0, dueOn: null },
      { number: 2, title: M2, state: "open", openIssues: 0, closedIssues: 0, dueOn: null },
    ],
    pulls: [],
    ...extra,
  };
}

const featureOf = (state, number) => state.features.find((f) => f.number === number);
const agentsOf = (state) => state.agents;
const withoutWarnings = (state) => ({ ...state, warnings: [] });

describe("forme de l'état /state", () => {
  test("renvoie toutes les clés du contrat, avec l'horloge injectée", () => {
    const state = reduce(snapshot([issue(1, "ready")]), [], at(5));
    assert.deepEqual(Object.keys(state).sort(), ["agents", "features", "milestones", "releases", "repo", "updatedAt", "warnings"]);
    assert.equal(state.repo, "o/r");
    assert.equal(state.updatedAt, at(5));
    assert.deepEqual(state.warnings, []);
    assert.deepEqual(state.agents, []);
    assert.deepEqual(state.releases, []);
    assert.deepEqual(featureOf(state, 1), {
      number: 1,
      title: "Feature 1",
      milestone: M1,
      status: "ready",
      retry: 0,
      pr: null,
      station: "roadmap",
      escalated: false,
    });
    assert.deepEqual(state.milestones[0], { number: 1, title: M1, state: "open", total: 1, done: 0 });
  });

  test("est déterministe, indépendant de l'ordre du journal, et ne modifie pas ses arguments", () => {
    const snap = snapshot([issue(1, "ready"), issue(2, "in-progress")]);
    const events = [
      ev("feature.status", 2, { issue: 1, status: "in-progress" }),
      ev("agent.requested", 3, { toolUseId: "t1", agentType: DEV, issue: 1 }),
      ev("feature.status", 4, { issue: 2, status: "in-review" }),
    ];
    const frozen = structuredClone({ snap, events });
    const deepFreeze = (o) => {
      if (o && typeof o === "object") Object.values(o).forEach(deepFreeze);
      return Object.freeze(o);
    };
    deepFreeze(frozen);

    const expected = reduce(snap, events, at(5));
    assert.deepEqual(reduce(frozen.snap, frozen.events, at(5)), expected);
    assert.deepEqual(reduce(snap, [...events].reverse(), at(5)), expected);
    assert.equal(expected.warnings.length, 0);
  });

  test("accepte les formes alternatives de l'instantané (labels en objets, headRefName, états en majuscules)", () => {
    const snap = {
      repo: "o/r",
      fetchedAt: at(0),
      issues: [{ number: 4, title: "T", state: "OPEN", labels: [{ name: "status:in-review" }, { name: "retry:2" }], milestone: { title: M1 } }],
      milestones: [{ number: 1, title: M1, state: "OPEN" }],
      pulls: [{ number: 44, headRefName: "feature/4-t", baseRefName: "develop", state: "OPEN", title: "x" }],
    };
    const f = featureOf(reduce(snap, [], at(1)), 4);
    assert.equal(f.status, "in-review");
    assert.equal(f.retry, 2);
    assert.equal(f.milestone, M1);
    assert.equal(f.pr, 44);
  });
});

describe("statut -> station (ARCHITECTURE § 6)", () => {
  const expected = [
    ["backlog", "roadmap"],
    ["ready", "roadmap"],
    ["in-progress", "dev"],
    ["changes-requested", "dev"],
    ["in-review", "verification"],
    ["in-test", "test"],
    ["done", "merge"],
  ];
  for (const [status, station] of expected) {
    test(`${status} -> ${station}`, () => {
      const state = reduce(snapshot([issue(1, status)]), [], at(1));
      assert.equal(featureOf(state, 1).station, station);
      assert.equal(featureOf(state, 1).escalated, false);
      assert.equal(stationForStatus(status), station);
    });
  }

  test("la table couvre exactement les statuts connus et des stations connues", () => {
    assert.deepEqual(Object.keys(STATUS_STATION).sort(), expected.map(([s]) => s).sort());
    for (const station of Object.values(STATUS_STATION)) assert.ok(STATIONS.includes(station));
    assert.equal(stationForStatus("blocked"), null);
    assert.equal(stationForStatus("inconnu"), null);
  });

  test("un milestone fermé place ses features à la station Release", () => {
    const snap = snapshot([issue(1, "done", { milestone: M2, milestoneNumber: 2 }), issue(2, "done")], {
      milestones: [
        { number: 1, title: M1, state: "open" },
        { number: 2, title: M2, state: "closed" },
      ],
    });
    const state = reduce(snap, [], at(1));
    assert.equal(featureOf(state, 1).station, "release");
    assert.equal(featureOf(state, 2).station, "merge");
    assert.deepEqual(state.milestones.map((m) => [m.number, m.state, m.total, m.done]), [
      [1, "open", 1, 1],
      [2, "closed", 1, 1],
    ]);
  });

  test("une PR release/* ouverte place les features done de son milestone à Release, pas les autres", () => {
    const snap = snapshot([issue(1, "done"), issue(2, "in-review"), issue(3, "done", { milestone: M2, milestoneNumber: 2 })], {
      pulls: [pull(50, "release/m1-socle", "open", "main")],
    });
    const state = reduce(snap, [], at(1));
    assert.equal(featureOf(state, 1).station, "release");
    assert.equal(featureOf(state, 2).station, "verification");
    assert.equal(featureOf(state, 3).station, "merge");
    assert.deepEqual(state.releases, [{ branch: "release/m1-socle", pr: 50, state: "open", title: "PR 50", milestone: M1 }]);
  });

  test("release.opened postérieur à l'instantané place les features done à Release ; antérieur, il est ignoré", () => {
    const snap = snapshot([issue(1, "done"), issue(2, "in-test")]);
    const after = reduce(snap, [ev("release.opened", 3, { ref: "release/m1-socle" })], at(5));
    assert.equal(featureOf(after, 1).station, "release");
    assert.equal(featureOf(after, 2).station, "test");
    assert.deepEqual(after.releases, [{ branch: "release/m1-socle", pr: null, state: "open", title: null, milestone: M1 }]);

    const before = reduce(snap, [ev("release.opened", -3, { ref: "release/m1-socle" })], at(5));
    assert.equal(featureOf(before, 1).station, "merge");
    assert.deepEqual(before.releases, []);
  });

  test("pr.merged sur la PR d'une release la passe à merged, et la sort de la station Release en attente", () => {
    const snap = snapshot([issue(1, "done")], { pulls: [pull(50, "release/m1-socle", "open", "main")] });
    const state = reduce(snap, [ev("pr.merged", 2, { pr: 50 })], at(5));
    assert.equal(state.releases[0].state, "merged");
    assert.equal(featureOf(state, 1).station, "merge");
  });

  test("milestone.changed postérieur ferme le milestone (ref = numéro en chaîne) ; une ref non numérique est sans effet", () => {
    const snap = snapshot([issue(1, "done")]);
    const closed = reduce(snap, [ev("milestone.changed", 2, { ref: "1", status: "closed" })], at(5));
    assert.equal(closed.milestones[0].state, "closed");
    assert.equal(featureOf(closed, 1).station, "release");

    const noop = reduce(snap, [ev("milestone.changed", 2, { ref: M1, status: "closed" }), ev("milestone.changed", 3, { ref: "1" })], at(5));
    assert.equal(noop.milestones[0].state, "open");
  });

  test("les issues sans status:* et les issues fermées sans status:done ne sont pas des features", () => {
    const snap = snapshot([
      issue(1, null),
      issue(2, "in-test", { state: "closed" }),
      issue(3, "in-test"),
      issue(4, "done"),
    ]);
    assert.deepEqual(reduce(snap, [], at(1)).features.map((f) => f.number), [3, 4]);
  });
});

describe("instantané : cas limites de fetchSnapshot()", () => {
  test("un status inconnu (status:bizarre) est traité comme absent, sans planter", () => {
    const snap = snapshot([
      issue(1, "bizarre", { labels: ["status:bizarre"] }),
      issue(2, null, { labels: ["status:bizarre", "status:in-review"] }),
      issue(3, "ready", { retry: 2 }),
    ]);
    const state = reduce(snap, [], at(1));
    assert.deepEqual(state.features.map((f) => [f.number, f.status, f.retry]), [[2, "in-review", 0], [3, "ready", 2]]);
  });

  test("la PR d'une feature se déduit de la branche feature/<n>-… de pulls[].head (même règle que pr.opened)", () => {
    const snap = snapshot([issue(7, "in-review"), issue(8, "in-review"), issue(9, "in-review")], {
      pulls: [
        pull(60, "feature/7-ajouter-une-tache"),
        pull(61, "feature/8"),
        pull(62, "feature/80-autre"),
        pull(63, "bugfix/9-x"),
        pull(64, "release/m1-socle", "open", "main"),
      ],
    });
    const state = reduce(snap, [], at(1));
    assert.deepEqual(state.features.map((f) => [f.number, f.pr]), [[7, 60], [8, 61], [9, null]]);
  });
});

describe("blocked : zone escalade accolée à la dernière station connue", () => {
  test("sans journal, la zone est accolée à Dev", () => {
    const f = featureOf(reduce(snapshot([issue(9, "blocked")]), [], at(1)), 9);
    assert.equal(f.status, "blocked");
    assert.equal(f.station, "dev");
    assert.equal(f.escalated, true);
  });

  test("avec journal, elle est accolée à la dernière station connue (hors blocked)", () => {
    const events = [
      ev("feature.status", -30, { issue: 9, status: "in-progress" }),
      ev("feature.status", -20, { issue: 9, status: "in-test" }),
      ev("feature.status", -10, { issue: 9, status: "blocked" }),
    ];
    const f = featureOf(reduce(snapshot([issue(9, "blocked")]), events, at(1)), 9);
    assert.equal(f.station, "test");
    assert.equal(f.escalated, true);
  });

  test("avec un blocked postérieur à l'instantané, le journal donne la station d'origine", () => {
    const snap = snapshot([issue(9, "in-review")]);
    const events = [ev("feature.status", 3, { issue: 9, status: "blocked" })];
    const f = featureOf(reduce(snap, [ev("feature.status", -5, { issue: 9, status: "in-review" }), ...events], at(5)), 9);
    assert.equal(f.status, "blocked");
    assert.equal(f.station, "verification");
    assert.equal(f.escalated, true);
  });

  test("le journal d'une autre issue ne compte pas", () => {
    const events = [ev("feature.status", -10, { issue: 8, status: "in-test" })];
    assert.equal(featureOf(reduce(snapshot([issue(9, "blocked")]), events, at(1)), 9).station, "dev");
  });

  test("blocked l'emporte sur un milestone fermé", () => {
    const snap = snapshot([issue(9, "blocked")], { milestones: [{ number: 1, title: M1, state: "closed" }] });
    const f = featureOf(reduce(snap, [], at(1)), 9);
    assert.equal(f.station, "dev");
    assert.equal(f.escalated, true);
  });
});

describe("priorité GitHub", () => {
  test("un feature.status plus récent que l'instantané déplace la feature", () => {
    const snap = snapshot([issue(3, "in-progress")], { fetchedAt: at(10) });
    const state = reduce(snap, [ev("feature.status", 12, { issue: 3, status: "in-review" })], at(15));
    assert.equal(featureOf(state, 3).status, "in-review");
    assert.equal(featureOf(state, 3).station, "verification");
  });

  test("un feature.status antérieur à l'instantané est ignoré", () => {
    const snap = snapshot([issue(3, "in-progress")], { fetchedAt: at(10) });
    const state = reduce(snap, [ev("feature.status", 5, { issue: 3, status: "in-test" })], at(15));
    assert.equal(featureOf(state, 3).status, "in-progress");
    assert.equal(featureOf(state, 3).station, "dev");
  });

  test("un nouvel instantané qui contredit le journal l'emporte", () => {
    const events = [ev("feature.status", 12, { issue: 3, status: "in-review" })];
    const first = reduce(snapshot([issue(3, "in-progress")], { fetchedAt: at(10) }), events, at(15));
    assert.equal(featureOf(first, 3).station, "verification");
    const second = reduce(snapshot([issue(3, "in-progress")], { fetchedAt: at(20) }), events, at(21));
    assert.equal(featureOf(second, 3).status, "in-progress");
    assert.equal(featureOf(second, 3).station, "dev");
  });

  test("un événement à la date exacte de l'instantané est déjà dans l'instantané", () => {
    const snap = snapshot([issue(3, "in-progress")], { fetchedAt: at(10) });
    const state = reduce(snap, [ev("feature.status", 10, { issue: 3, status: "done" })], at(11));
    assert.equal(featureOf(state, 3).status, "in-progress");
  });

  test("le retry vient du label, puis de feature.retry postérieur ; done le remet à zéro", () => {
    const snap = snapshot([issue(3, "changes-requested", { retry: 1, labels: ["status:changes-requested", "retry:1"] })]);
    assert.equal(featureOf(reduce(snap, [], at(1)), 3).retry, 1);
    assert.equal(featureOf(reduce(snap, [ev("feature.retry", 2, { issue: 3, retry: 2 })], at(3)), 3).retry, 2);
    assert.equal(featureOf(reduce(snap, [ev("feature.retry", -2, { issue: 3, retry: 3 })], at(3)), 3).retry, 1);
    const done = reduce(snap, [ev("feature.retry", 2, { issue: 3, retry: 2 }), ev("feature.status", 4, { issue: 3, status: "done" })], at(5));
    assert.equal(featureOf(done, 3).retry, 0);
  });

  test("une feature inconnue de l'instantané mais créée depuis est reprise du journal ; sans instantané, tout vient du journal", () => {
    const withSnap = reduce(snapshot([]), [ev("feature.status", 3, { issue: 30, status: "ready" })], at(5));
    assert.deepEqual(featureOf(withSnap, 30), {
      number: 30, title: null, milestone: null, status: "ready", retry: 0, pr: null, station: "roadmap", escalated: false,
    });
    const old = reduce(snapshot([]), [ev("feature.status", -3, { issue: 30, status: "ready" })], at(5));
    assert.equal(featureOf(old, 30), undefined);

    const noSnap = reduce(null, [ev("feature.status", -3, { issue: 30, status: "in-test" })], at(5));
    assert.equal(featureOf(noSnap, 30).station, "test");
    assert.equal(noSnap.repo, null);
  });

  test("la PR d'une feature vient de l'instantané (ouverte avant mergée), sinon de la mission d'un agent", () => {
    const snap = snapshot([issue(3, "in-review"), issue(4, "in-review"), issue(5, "in-review")], {
      pulls: [pull(30, "feature/3-a", "closed"), pull(31, "feature/3-a", "open"), pull(32, "feature/3-a", "merged"), pull(40, "feature/4-b", "merged"), pull(41, "feature/4-b", "closed")],
    });
    const events = [ev("agent.requested", 1, { toolUseId: "t1", agentType: VERIF, issue: 5, pr: 55 })];
    const state = reduce(snap, events, at(2));
    assert.equal(featureOf(state, 3).pr, 31);
    assert.equal(featureOf(state, 4).pr, 40);
    assert.equal(featureOf(state, 5).pr, 55);
  });
});

describe("corrélation des agents", () => {
  test("toolUseId puis agentId : un seul agent suit requested -> running -> reported -> finished", () => {
    const base = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, mode: "IMPLEMENTATION", issue: 3, attempt: 1 }),
      ev("agent.launched", 2, { toolUseId: "tA", agentId: "agent-aaa", agentType: DEV }),
      ev("agent.started", 3, { agentId: "aaa", agentType: DEV }),
      ev("agent.reported", 4, { agentId: "agent-aaa", block: "RAPPORT_DEV", verdict: "LIVRÉ" }),
      ev("agent.finished", 5, { agentId: "aaa", source: "stop" }),
    ];
    const phases = [];
    for (let n = 1; n <= base.length; n += 1) {
      const agents = agentsOf(reduce(snapshot([]), base.slice(0, n), at(6)));
      assert.equal(agents.length, 1, `après ${n} événement(s)`);
      phases.push(agents[0].phase);
    }
    assert.deepEqual(phases, ["requested", "running", "running", "reported", "finished"]);

    const [a] = agentsOf(reduce(snapshot([]), base, at(6)));
    assert.deepEqual(a, {
      id: "tA", type: "developpeur", mode: "IMPLEMENTATION", issue: 3, pr: null, attempt: 1, station: "dev",
      phase: "finished", since: at(1), updatedAt: at(5), finishedAt: at(5), verdict: "LIVRÉ", block: "RAPPORT_DEV",
      agentId: "aaa", toolUseId: "tA",
    });
  });

  test("FIFO par agentType : un SubagentStart sans toolUseId rejoint le plus ancien agent requested du même type", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 1 }),
      ev("agent.requested", 2, { toolUseId: "tB", agentType: DEV, issue: 2 }),
      ev("agent.requested", 3, { toolUseId: "tC", agentType: VERIF, issue: 3 }),
      ev("agent.started", 4, { agentId: "x1", agentType: DEV }),
      ev("agent.started", 5, { agentId: "x2", agentType: DEV }),
    ];
    const byId = Object.fromEntries(agentsOf(reduce(snapshot([]), events, at(6))).map((a) => [a.id, a]));
    assert.equal(byId.tA.agentId, "x1");
    assert.equal(byId.tA.phase, "running");
    assert.equal(byId.tB.agentId, "x2");
    assert.equal(byId.tB.phase, "running");
    assert.equal(byId.tC.agentId, null);
    assert.equal(byId.tC.phase, "requested");
    assert.equal(Object.keys(byId).length, 3);
  });

  test("FIFO aussi pour un rapport sans toolUseId", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: VERIF, issue: 1 }),
      ev("agent.reported", 2, { agentId: "v1", agentType: VERIF, verdict: "PASS" }),
    ];
    const [a] = agentsOf(reduce(snapshot([]), events, at(5)));
    assert.equal(a.id, "tA");
    assert.equal(a.agentId, "v1");
    assert.equal(a.phase, "reported");
    assert.equal(a.verdict, "PASS");
  });

  test("le FIFO ne rapproche pas des agents de sessions différentes", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tB", agentType: VERIF, issue: 2, sessionId: S1 }),
      ev("agent.started", 2, { agentId: "v2", agentType: VERIF, sessionId: S2 }),
    ];
    const agents = agentsOf(reduce(snapshot([]), events, at(5)));
    assert.deepEqual(agents.map((a) => a.id), ["v2"], "tB (session S1, plus ancienne) est purgé, v2 n'a pas absorbé tB");
    assert.equal(agents[0].issue, null);
    assert.equal(agents[0].type, "verificateur");
    assert.equal(agents[0].phase, "running");
  });

  test("un agent connu seulement par son agentId est créé ; un launched qui arrive ensuite lui ajoute le toolUseId", () => {
    const events = [
      ev("agent.started", 1, { agentId: "orph", agentType: TEST }),
      ev("agent.launched", 2, { toolUseId: "tZ", agentId: "orph" }),
    ];
    const agents = agentsOf(reduce(snapshot([]), events, at(3)));
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "orph");
    assert.equal(agents[0].toolUseId, "tZ");
    assert.equal(agents[0].type, "testeur");
  });

  test("un agentId pris à tort par FIFO est rendu quand un toolUseId le revendique", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 1 }),
      ev("agent.requested", 2, { toolUseId: "tB", agentType: DEV, issue: 2 }),
      ev("agent.started", 3, { agentId: "X", agentType: DEV }), // FIFO : rejoint tA
      ev("agent.reported", 4, { agentId: "X", verdict: "LIVRÉ" }),
      ev("agent.launched", 5, { toolUseId: "tB", agentId: "X" }), // le toolUseId fait foi : X est à tB
    ];
    const byId = Object.fromEntries(agentsOf(reduce(snapshot([]), events, at(6))).map((a) => [a.id, a]));
    assert.equal(byId.tB.agentId, "X");
    assert.equal(byId.tB.phase, "reported");
    assert.equal(byId.tB.verdict, "LIVRÉ");
    assert.equal(byId.tA.agentId, null);
    assert.equal(byId.tA.phase, "requested");
    assert.equal(byId.tA.verdict, null);
  });

  test("un agent connu par son agentId seul est fusionné avec l'agent du toolUseId (sessions différentes)", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 1 }),
      ev("agent.started", 2, { agentId: "X", agentType: DEV, sessionId: S1 }),
    ];
    // Même session : FIFO, un seul agent.
    assert.equal(agentsOf(reduce(snapshot([]), events, at(3))).length, 1);

    const split = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 1, sessionId: S1 }),
      ev("agent.started", 2, { agentId: "X", agentType: DEV, sessionId: S2 }),
      ev("agent.launched", 3, { toolUseId: "tA", agentId: "X", sessionId: S1 }),
    ];
    const agents = agentsOf(reduce(snapshot([]), split, at(4)));
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "tA");
    assert.equal(agents[0].agentId, "X");
    assert.equal(agents[0].issue, 1);
    assert.equal(agents[0].phase, "running");
  });

  test("au plus un agent actif developpeur/verificateur/testeur par issue : le plus récent remplace l'ancien", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 7 }),
      ev("agent.requested", 2, { toolUseId: "tB", agentType: VERIF, issue: 7 }),
      ev("agent.requested", 2, { toolUseId: "tC", agentType: DEV, issue: 8 }),
      ev("agent.requested", 3, { toolUseId: "tD", agentType: ARCHI, issue: 7, mode: "ESCALADE" }),
    ];
    const byId = Object.fromEntries(agentsOf(reduce(snapshot([]), events, at(4))).map((a) => [a.id, a]));
    assert.equal(byId.tA.phase, "finished");
    assert.equal(byId.tA.finishedAt, at(2));
    assert.equal(byId.tB.phase, "requested");
    assert.equal(byId.tC.phase, "requested", "une autre issue n'est pas touchée");
    assert.equal(byId.tD.phase, "requested", "l'architecte n'est pas concerné");
  });

  // Adapté pour l'ADR 0008 : ce test figeait aussi `reported`/`started` tardifs après la fin, qui rouvrent
  // désormais un cycle (voir « reprise d'un agent »). Il ne garde que l'idempotence du `finished` en double.
  test("agent.finished en double (sans réactivation) : le premier signal gagne, les suivants n'ajoutent qu'un verdict manquant", () => {
    const start = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: VERIF, issue: 7 }),
      ev("agent.launched", 2, { toolUseId: "tA", agentId: "a1" }),
    ];
    const first = reduce(snapshot([]), [...start, ev("agent.finished", 3, { agentId: "a1", source: "stop" })], at(4));
    const again = reduce(
      snapshot([]),
      [
        ...start,
        ev("agent.finished", 3, { agentId: "a1", source: "stop" }),
        ev("agent.finished", 3.5, { agentId: "a1", toolUseId: "tA", source: "tool", verdict: "PASS", block: "RAPPORT_VERIFICATION" }),
        ev("agent.finished", 3.7, { agentId: "a1", source: "stop", verdict: "FAIL" }),
      ],
      at(4),
    );
    assert.equal(agentsOf(first).length, 1);
    assert.equal(agentsOf(again).length, 1);
    const [a] = agentsOf(again);
    assert.equal(a.phase, "finished");
    assert.equal(a.finishedAt, at(3), "la date de fin ne bouge pas");
    assert.equal(a.updatedAt, at(3));
    assert.equal(a.verdict, "PASS", "le verdict manquant est ajouté, puis jamais écrasé");
    assert.equal(a.block, "RAPPORT_VERIFICATION");
    assert.deepEqual({ ...a, verdict: null, block: null }, { ...agentsOf(first)[0], verdict: null, block: null });
  });

  test("un feature.status qui fait sortir l'issue de la station de l'agent le marque finished", () => {
    const events = [
      ev("feature.status", 0, { issue: 3, status: "in-progress" }),
      ev("agent.requested", 1, { toolUseId: "tD", agentType: DEV, issue: 3 }),
      ev("feature.status", 2, { issue: 3, status: "changes-requested" }), // même station Dev : l'agent reste
      ev("agent.requested", 2.5, { toolUseId: "tR", agentType: ARCHI, mode: "REVUE_ROADMAP" }), // sans issue : intouchable
    ];
    const during = Object.fromEntries(agentsOf(reduce(snapshot([]), events, at(3))).map((a) => [a.id, a]));
    assert.equal(during.tD.phase, "requested");
    assert.equal(during.tR.station, "roadmap");

    const after = Object.fromEntries(
      agentsOf(reduce(snapshot([]), [...events, ev("feature.status", 4, { issue: 3, status: "in-review" })], at(5))).map((a) => [a.id, a]),
    );
    assert.equal(after.tD.phase, "finished");
    assert.equal(after.tD.finishedAt, at(4));
    assert.equal(after.tR.phase, "requested");
  });

  test("le statut qui mène à blocked termine l'agent d'issue ; l'architecte ESCALADE y reste", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tV", agentType: VERIF, issue: 3 }),
      ev("feature.status", 2, { issue: 3, status: "blocked" }),
      ev("agent.requested", 3, { toolUseId: "tE", agentType: ARCHI, mode: "ESCALADE", issue: 3 }),
    ];
    const byId = Object.fromEntries(agentsOf(reduce(snapshot([]), events, at(4))).map((a) => [a.id, a]));
    assert.equal(byId.tV.phase, "finished");
    assert.equal(byId.tE.phase, "requested");
    assert.equal(byId.tE.station, "escalade");
    const after = Object.fromEntries(
      agentsOf(reduce(snapshot([]), [...events, ev("feature.status", 5, { issue: 3, status: "in-progress" })], at(6))).map((a) => [a.id, a]),
    );
    assert.equal(after.tE.phase, "finished");
  });

  test("l'exclusion d'un agent par feature.status s'applique même si l'événement précède l'instantané", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tD", agentType: DEV, issue: 3 }),
      ev("feature.status", 2, { issue: 3, status: "in-review" }),
    ];
    const snap = snapshot([issue(3, "in-review")], { fetchedAt: at(10) });
    assert.equal(agentsOf(reduce(snap, events, at(11)))[0].phase, "finished");
  });

  test("sans signal depuis 45 min, l'agent passe en unknown sans être déclaré fini ; un nouveau signal le ranime", () => {
    const events = [ev("agent.requested", 0, { toolUseId: "tA", agentType: DEV, issue: 3 }), ev("agent.launched", 1, { toolUseId: "tA", agentId: "a1" })];
    const phaseAt = (minutes, evs = events) => agentsOf(reduce(snapshot([issue(3, "in-progress")]), evs, at(minutes)))[0];
    assert.equal(AGENT_UNKNOWN_AFTER_MS, 45 * MIN);
    assert.equal(phaseAt(45.99).phase, "running");
    assert.equal(phaseAt(46).phase, "unknown");
    assert.equal(phaseAt(500).phase, "unknown");
    assert.equal(phaseAt(500).finishedAt, null);
    assert.equal(phaseAt(500).updatedAt, at(1));

    const revived = [...events, ev("agent.reported", 60, { agentId: "a1", verdict: "LIVRÉ" })];
    assert.equal(phaseAt(100, revived).phase, "reported");
    assert.equal(phaseAt(105, revived).phase, "unknown");
  });

  test("un agent terminé n'est jamais marqué unknown", () => {
    const events = [ev("agent.started", 0, { agentId: "a1", agentType: DEV }), ev("agent.finished", 1, { agentId: "a1", source: "stop" })];
    assert.equal(agentsOf(reduce(null, events, at(5)))[0].phase, "finished");
  });
});

describe("purge des agents", () => {
  test("seule la session la plus récente est conservée", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "old", agentType: DEV, issue: 1, sessionId: S1 }),
      ev("agent.requested", 2, { toolUseId: "oldDone", agentType: VERIF, issue: 2, sessionId: S1 }),
      ev("agent.finished", 3, { agentId: "z", agentType: VERIF, source: "stop", sessionId: S1 }),
      ev("agent.requested", 5, { toolUseId: "new", agentType: DEV, issue: 3, sessionId: S2 }),
    ];
    assert.deepEqual(agentsOf(reduce(null, events, at(6))).map((a) => a.id), ["new"]);
  });

  test("la session la plus récente est celle du dernier événement, même une commande gh", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "a", agentType: DEV, issue: 1, sessionId: S1 }),
      ev("feature.status", 4, { issue: 1, status: "in-progress", sessionId: S2 }),
    ];
    assert.deepEqual(agentsOf(reduce(null, events, at(6))), []);
  });

  test("les agents non terminés de la session courante sont tous conservés, y compris unknown", () => {
    const events = [
      ev("agent.requested", 0, { toolUseId: "a", agentType: DEV, issue: 1 }),
      ev("agent.requested", 1, { toolUseId: "b", agentType: DEV, issue: 2 }),
    ];
    const agents = agentsOf(reduce(null, events, at(200)));
    assert.deepEqual(agents.map((a) => [a.id, a.phase]), [["a", "unknown"], ["b", "unknown"]]);
  });

  test("les agents terminés de la session courante restent 10 min, puis sont retirés", () => {
    const events = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 1 }),
      ev("agent.finished", 2, { toolUseId: "tA", agentId: "a1", source: "tool" }),
      ev("agent.requested", 3, { toolUseId: "tB", agentType: DEV, issue: 2 }),
    ];
    assert.equal(AGENT_FINISHED_TTL_MS, 10 * MIN);
    const ids = (minutes) => agentsOf(reduce(null, events, at(minutes))).map((a) => a.id);
    assert.deepEqual(ids(11.99), ["tA", "tB"]);
    assert.deepEqual(ids(12), ["tB"]);
    assert.deepEqual(ids(60), ["tB"]);
  });

  test("les agents sont triés par première apparition", () => {
    const events = [
      ev("agent.requested", 2, { toolUseId: "b", agentType: DEV, issue: 2 }),
      ev("agent.requested", 1, { toolUseId: "a", agentType: DEV, issue: 1 }),
    ];
    assert.deepEqual(agentsOf(reduce(null, events, at(3))).map((a) => a.id), ["a", "b"]);
  });
});

// --- Reprise d'un agent : cycle de vie non monotone (ADR 0008) ----------------------------------------------

describe("reprise d'un agent (ADR 0008)", () => {
  // Un cycle complet de développeur (lancé, rapporté, fini à at(4)) que les tests prolongent.
  const devCycle = () => [
    ev("agent.requested", 1, { toolUseId: "tA", agentType: DEV, issue: 7, mode: "IMPLEMENTATION" }),
    ev("agent.launched", 2, { toolUseId: "tA", agentId: "a1" }),
    ev("agent.reported", 3, { agentId: "a1", block: "RAPPORT_DEV", verdict: "LIVRÉ" }),
    ev("agent.finished", 4, { agentId: "a1", source: "stop" }),
  ];
  const only = (events, minutes) => {
    const agents = agentsOf(reduce(null, events, at(minutes)));
    assert.equal(agents.length, 1, "un seul agent visuel, quel que soit le nombre de cycles");
    return agents[0];
  };

  describe("réactivation par un signal de ts strictement postérieur à finishedAt", () => {
    const cases = [
      {
        name: "agent.started",
        signal: (m) => ev("agent.started", m, { agentId: "a1", agentType: DEV }),
        phase: "running",
        block: null,
        verdict: null,
      },
      {
        name: "agent.launched",
        signal: (m) => ev("agent.launched", m, { toolUseId: "tA", agentId: "a1" }),
        phase: "running",
        block: null,
        verdict: null,
      },
      {
        name: "agent.reported",
        signal: (m) => ev("agent.reported", m, { agentId: "a1", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
        phase: "reported",
        block: "RAPPORT_DEV",
        verdict: "BLOQUÉ",
      },
    ];

    for (const c of cases) {
      test(`${c.name} ouvre un nouveau cycle : finishedAt à null, bonne phase, block/verdict du nouveau cycle`, () => {
        const before = only(devCycle(), 5);
        assert.equal(before.phase, "finished");
        assert.equal(before.block, "RAPPORT_DEV");
        assert.equal(before.verdict, "LIVRÉ");

        const a = only([...devCycle(), c.signal(5)], 6);
        assert.equal(a.phase, c.phase);
        assert.equal(a.finishedAt, null);
        assert.equal(a.block, c.block);
        assert.equal(a.verdict, c.verdict);
        assert.equal(a.updatedAt, at(5), "updatedAt suit le dernier signal, tous cycles confondus");
        assert.equal(a.id, "tA", "id reste celui du premier cycle");
        assert.equal(a.since, at(1), "since reste celui du premier cycle");
        assert.equal(a.agentId, "a1");
        assert.equal(a.type, "developpeur");
        assert.equal(a.issue, 7);
        assert.equal(a.mode, "IMPLEMENTATION", "le mode d'un développeur ne change pas");
      });

      test(`${c.name} de ts égal à finishedAt ou antérieur ne rouvre rien`, () => {
        const a = only([...devCycle(), c.signal(4)], 6);
        assert.equal(a.phase, "finished");
        assert.equal(a.finishedAt, at(4));
        assert.equal(a.block, "RAPPORT_DEV");
        assert.equal(a.verdict, "LIVRÉ");
      });
    }

    test("la réactivation d'un agent qui n'est pas fini est sans effet de cycle (pas de remise à zéro du rapport)", () => {
      const events = devCycle().slice(0, 3); // reported, pas encore finished
      const a = only([...events, ev("agent.started", 3.5, { agentId: "a1", agentType: DEV })], 4);
      assert.equal(a.phase, "reported", "started ne fait jamais reculer la phase d'un agent actif");
      assert.equal(a.block, "RAPPORT_DEV");
      assert.equal(a.verdict, "LIVRÉ");
    });
  });

  describe("réouverture puis clôture", () => {
    test("un agent.finished clôt le cycle rouvert, avec la date de ce cycle", () => {
      const events = [
        ...devCycle(),
        ev("agent.started", 5, { agentId: "a1", agentType: DEV }),
        ev("agent.reported", 6, { agentId: "a1", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
        ev("agent.finished", 7, { agentId: "a1", source: "stop" }),
      ];
      const a = only(events, 8);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(7));
      assert.equal(a.updatedAt, at(7));
      assert.equal(a.verdict, "BLOQUÉ", "le verdict est celui du dernier cycle");
      assert.equal(a.since, at(1));
      assert.equal(a.id, "tA");
    });

    test("deux réouvertures successives sont clôturées chacune par leur finished", () => {
      const events = [
        ...devCycle(),
        ev("agent.started", 5, { agentId: "a1", agentType: DEV }),
        ev("agent.finished", 6, { agentId: "a1", source: "stop" }),
        ev("agent.reported", 7, { agentId: "a1", block: "RAPPORT_DEV", verdict: "LIVRÉ" }),
        ev("agent.finished", 8, { agentId: "a1", source: "stop" }),
      ];
      const phasesAt = (n, minutes) => {
        const a = only(events.slice(0, n), minutes);
        return [a.phase, a.finishedAt];
      };
      assert.deepEqual(phasesAt(4, 5), ["finished", at(4)]);
      assert.deepEqual(phasesAt(5, 5), ["running", null]);
      assert.deepEqual(phasesAt(6, 6), ["finished", at(6)]);
      assert.deepEqual(phasesAt(7, 7), ["reported", null]);
      assert.deepEqual(phasesAt(8, 8), ["finished", at(8)]);
    });

    test("un feature.status qui fait sortir l'issue de la station clôt le cycle rouvert (signal 6)", () => {
      const events = [
        ev("feature.status", 0, { issue: 7, status: "in-progress" }),
        ...devCycle(),
        ev("agent.started", 5, { agentId: "a1", agentType: DEV }),
      ];
      assert.equal(only(events, 5.5).phase, "running");
      const a = only([...events, ev("feature.status", 6, { issue: 7, status: "in-review" })], 7);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(6));
      assert.equal(a.since, at(1));
    });

    test("un feature.status qui garde l'issue dans la station de l'agent ne clôt pas le cycle rouvert", () => {
      const events = [...devCycle(), ev("agent.started", 5, { agentId: "a1", agentType: DEV }), ev("feature.status", 6, { issue: 7, status: "changes-requested" })];
      assert.equal(only(events, 7).phase, "running");
    });
  });

  describe("fins en double et rapports tardifs : ils complètent, ils ne rouvrent rien", () => {
    test("un finished reçu sur un agent déjà fini ne change ni la phase ni finishedAt, et ne complète que ce qui manque", () => {
      const events = [
        ev("agent.requested", 1, { toolUseId: "tA", agentType: VERIF, issue: 7 }),
        ev("agent.launched", 2, { toolUseId: "tA", agentId: "a1" }),
        ev("agent.finished", 3, { agentId: "a1", source: "stop" }),
        ev("agent.finished", 3.5, { agentId: "a1", source: "tool", block: "RAPPORT_VERIFICATION", verdict: "PASS" }),
        ev("agent.finished", 3.8, { agentId: "a1", source: "stop", block: "AUTRE", verdict: "FAIL" }),
      ];
      const a = only(events, 4);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(3));
      assert.equal(a.updatedAt, at(3));
      assert.equal(a.block, "RAPPORT_VERIFICATION");
      assert.equal(a.verdict, "PASS", "le premier verdict reçu reste");
    });

    test("un reported de ts égal à finishedAt (écriture tardive du cycle clos) complète block/verdict sans rouvrir", () => {
      const events = [...devCycle().slice(0, 2), ev("agent.finished", 3, { agentId: "a1", source: "stop" }), ev("agent.reported", 3, { agentId: "a1", block: "RAPPORT_DEV", verdict: "LIVRÉ" })];
      const a = only(events, 4);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(3));
      assert.equal(a.block, "RAPPORT_DEV");
      assert.equal(a.verdict, "LIVRÉ");
    });

    test("un reported tardif n'écrase pas le block/verdict du cycle clos", () => {
      const a = only([...devCycle(), ev("agent.reported", 4, { agentId: "a1", block: "AUTRE", verdict: "BLOQUÉ" })], 5);
      assert.equal(a.phase, "finished");
      assert.equal(a.block, "RAPPORT_DEV");
      assert.equal(a.verdict, "LIVRÉ");
    });

    test("un reported de ts antérieur à finishedAt, écrit après le finished, est classé avant lui : même état final", () => {
      const inOrder = [...devCycle().slice(0, 2), ev("agent.reported", 3, { agentId: "a1", block: "RAPPORT_DEV", verdict: "LIVRÉ" }), ev("agent.finished", 4, { agentId: "a1", source: "stop" })];
      const lateWrite = [inOrder[0], inOrder[1], inOrder[3], inOrder[2]];
      const a = only(lateWrite, 5);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(4));
      assert.equal(a.block, "RAPPORT_DEV");
      assert.deepEqual(a, only(inOrder, 5));
    });
  });

  describe("tri par ts, ordre du journal pour les ex-æquo", () => {
    test("les événements agent.* sont appliqués par ts, quel que soit l'ordre d'écriture", () => {
      const events = [
        ...devCycle(),
        ev("agent.started", 5, { agentId: "a1", agentType: DEV }),
        ev("agent.reported", 6, { agentId: "a1", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
        ev("agent.finished", 7, { agentId: "a1", source: "stop" }),
      ];
      const expected = only(events, 8);
      assert.equal(expected.phase, "finished");
      assert.equal(expected.verdict, "BLOQUÉ");
      assert.deepEqual(only([...events].reverse(), 8), expected);
      const shuffled = [events[5], events[2], events[0], events[6], events[4], events[1], events[3]];
      assert.deepEqual(only(shuffled, 8), expected);
    });

    test("à ts égal, l'ordre du journal départage : started puis finished clôt, finished puis started rouvre", () => {
      const base = devCycle(); // fini à at(4)
      const startedFirst = [...base, ev("agent.started", 5, { agentId: "a1", agentType: DEV }), ev("agent.finished", 5, { agentId: "a1", source: "stop" })];
      const finishedFirst = [...base, ev("agent.finished", 5, { agentId: "a1", source: "stop" }), ev("agent.started", 5, { agentId: "a1", agentType: DEV })];
      const a = only(startedFirst, 6);
      assert.equal(a.phase, "finished");
      assert.equal(a.finishedAt, at(5));
      const b = only(finishedFirst, 6);
      assert.equal(b.phase, "running", "le finished de ts 5 est un doublon du cycle clos à at(4) ; le started rouvre ensuite");
      assert.equal(b.finishedAt, null);
    });

    test("launched avant ou après started, à ts égal ou presque : même agent, même état", () => {
      const requested = ev("agent.requested", 1, { toolUseId: "tQ", agentType: ARCHI, mode: "CADRAGE_QUESTIONS" });
      const started = (m) => ev("agent.started", m, { agentId: "q1", agentType: ARCHI });
      const launched = (m) => ev("agent.launched", m, { toolUseId: "tQ", agentId: "q1", agentType: ARCHI });
      const variants = [
        [requested, started(2), launched(2)],
        [requested, launched(2), started(2)],
        [requested, started(2), launched(2.0004)],
        [requested, launched(2.0004), started(2)],
      ];
      const states = variants.map((v) => only(v, 3));
      for (const a of states) {
        assert.equal(a.id, "tQ");
        assert.equal(a.agentId, "q1");
        assert.equal(a.toolUseId, "tQ");
        assert.equal(a.phase, "running");
        assert.equal(a.mode, "CADRAGE_QUESTIONS");
      }
    });
  });

  describe("architecte : mode et station déduits du block", () => {
    const table = [
      ["QUESTIONS", "CADRAGE_QUESTIONS", "cadrage"],
      ["PROPOSITION", "CADRAGE_PROPOSITION", "cadrage"],
      ["PITCH", "CADRAGE_FINALISATION", "cadrage"],
      ["VERDICT_ROADMAP", "REVUE_ROADMAP", "roadmap"],
      ["ESCALADE", "ESCALADE", "escalade"],
    ];
    for (const [block, mode, station] of table) {
      test(`${block} -> mode ${mode}, station ${station}`, () => {
        // Un architecte repris : le mode d'origine (CADRAGE_QUESTIONS ou autre) cède la place à celui du rapport.
        const events = [
          ev("agent.requested", 1, { toolUseId: "tR", agentType: ARCHI, mode: block === "QUESTIONS" ? "REVUE_ROADMAP" : "CADRAGE_QUESTIONS" }),
          ev("agent.launched", 2, { toolUseId: "tR", agentId: "r1" }),
          ev("agent.finished", 3, { agentId: "r1", source: "stop" }),
          ev("agent.reported", 4, { agentId: "r1", block }),
        ];
        const a = only(events, 5);
        assert.equal(a.phase, "reported");
        assert.equal(a.block, block);
        assert.equal(a.mode, mode);
        assert.equal(a.station, station);
      });
    }

    test("sans mode dans la mission (agent connu par SubagentStart seul), le block donne le mode", () => {
      const a = only([ev("agent.started", 1, { agentId: "r1", agentType: ARCHI }), ev("agent.reported", 2, { agentId: "r1", block: "PITCH" })], 3);
      assert.equal(a.mode, "CADRAGE_FINALISATION");
      assert.equal(a.station, "cadrage");
    });

    test("une reprise sans rapport garde le mode du cycle précédent", () => {
      const events = [
        ev("agent.requested", 1, { toolUseId: "tR", agentType: ARCHI, mode: "CADRAGE_QUESTIONS" }),
        ev("agent.launched", 2, { toolUseId: "tR", agentId: "r1" }),
        ev("agent.reported", 3, { agentId: "r1", block: "QUESTIONS" }),
        ev("agent.finished", 4, { agentId: "r1", source: "stop" }),
        ev("agent.started", 5, { agentId: "r1", agentType: ARCHI }),
      ];
      const a = only(events, 6);
      assert.equal(a.phase, "running");
      assert.equal(a.block, null);
      assert.equal(a.mode, "CADRAGE_QUESTIONS");
      assert.equal(a.station, "cadrage");
    });

    test("un block inconnu ou un autre type d'agent ne change ni le mode ni la station", () => {
      const archi = only([ev("agent.requested", 1, { toolUseId: "tR", agentType: ARCHI, mode: "CADRAGE_QUESTIONS" }), ev("agent.reported", 2, { toolUseId: "tR", agentId: "r1", block: "RAPPORT_DEV" })], 3);
      assert.equal(archi.mode, "CADRAGE_QUESTIONS");
      assert.equal(archi.station, "cadrage");
      // Un développeur qui rend un bloc nommé comme un bloc d'architecte reste développeur.
      const dev = only([ev("agent.requested", 1, { toolUseId: "tD", agentType: DEV, issue: 3, mode: "IMPLEMENTATION" }), ev("agent.reported", 2, { toolUseId: "tD", agentId: "d1", block: "PROPOSITION" })], 3);
      assert.equal(dev.mode, "IMPLEMENTATION");
      assert.equal(dev.station, "dev");
    });

    test("les clés héritées d'Object.prototype ne sont pas prises pour un block", () => {
      const a = only([ev("agent.requested", 1, { toolUseId: "tR", agentType: ARCHI, mode: "CADRAGE_QUESTIONS" }), ev("agent.reported", 2, { toolUseId: "tR", agentId: "r1", block: "constructor" })], 3);
      assert.equal(a.mode, "CADRAGE_QUESTIONS");
    });
  });

  describe("unknown et purge s'appliquent au dernier cycle", () => {
    test("passage en unknown : 45 min après le dernier signal du cycle rouvert, pas après la fin du premier", () => {
      const events = [...devCycle(), ev("agent.started", 20, { agentId: "a1", agentType: DEV })];
      assert.equal(only(events, 20 + 44.99).phase, "running");
      const stale = only(events, 20 + 45);
      assert.equal(stale.phase, "unknown");
      assert.equal(stale.finishedAt, null);
      assert.equal(stale.updatedAt, at(20));
    });

    test("purge : un agent rouvert reste affiché bien au-delà des 10 min qui suivent sa première fin", () => {
      const events = [...devCycle(), ev("agent.started", 20, { agentId: "a1", agentType: DEV })];
      assert.deepEqual(agentsOf(reduce(null, devCycle(), at(30))), [], "sans reprise, l'agent fini à at(4) est purgé");
      assert.equal(only(events, 30).phase, "running");
    });

    test("purge : 10 min après la fin du dernier cycle, pas avant", () => {
      const events = [...devCycle(), ev("agent.started", 20, { agentId: "a1", agentType: DEV }), ev("agent.finished", 25, { agentId: "a1", source: "stop" })];
      assert.equal(only(events, 34.99).phase, "finished");
      assert.deepEqual(agentsOf(reduce(null, events, at(35))), []);
    });
  });

  describe("rejeu de la capture réelle du 2026-10-30 (tests/fixtures/journal/capture-reprise.jsonl)", () => {
    const FIXTURE = path.join(__dirname, "..", "fixtures", "journal", "capture-reprise.jsonl");
    const lines = fs.readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l.trim() !== "");
    const journal = lines.map((l) => JSON.parse(l));
    const A = "a152ecd0174a7c035";
    const B = "a7181e1aa24ee1883";
    const agentOf = (state, agentId) => state.agents.find((a) => a.agentId === agentId);
    // État après les n premières lignes du journal, à l'heure de la n-ième.
    const prefix = (n) => reduce(null, journal.slice(0, n), journal[n - 1].ts);

    test("la fixture a 14 lignes v1 et ne contient que des champs de métadonnées", () => {
      assert.equal(journal.length, 14);
      assert.ok(journal.every((e) => e.v === 1 && e.src === "hook" && typeof e.ts === "string"));
      const allowed = new Set(["v", "ts", "src", "type", "sessionId", "toolUseId", "agentId", "agentType", "mode", "block", "source"]);
      for (const e of journal) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `champ inattendu : ${k}`);
    });

    test("état final : a152… fini avec PROPOSITION / CADRAGE_PROPOSITION, a718… fini avec QUESTIONS", () => {
      const state = reduce(null, journal, "2026-10-30T14:18:00.000Z");
      assert.deepEqual(state.warnings.map((w) => w.code), ["SNAPSHOT_MISSING"], "aucun événement de la capture n'est ignoré");
      assert.equal(state.agents.length, 2);
      const a = agentOf(state, A);
      assert.equal(a.phase, "finished");
      assert.equal(a.block, "PROPOSITION");
      assert.equal(a.mode, "CADRAGE_PROPOSITION");
      assert.equal(a.station, "cadrage");
      assert.equal(a.type, "architecte");
      assert.equal(a.id, "toolu_01TgFJ174zajsWqDbJDYBTR2", "id reste la clé du premier cycle");
      assert.equal(a.toolUseId, "toolu_01TgFJ174zajsWqDbJDYBTR2");
      assert.equal(a.since, "2026-10-30T14:13:03.588Z");
      assert.equal(a.updatedAt, "2026-10-30T14:16:08.735Z");
      assert.equal(a.finishedAt, "2026-10-30T14:16:08.735Z");

      const b = agentOf(state, B);
      assert.equal(b.phase, "finished");
      assert.equal(b.block, "QUESTIONS");
      assert.equal(b.mode, "CADRAGE_QUESTIONS");
      assert.equal(b.id, "toolu_011uY1fsUab3NjGKWBDc4j83");
      assert.equal(b.since, "2026-10-30T14:17:12.254Z");
      assert.equal(b.finishedAt, "2026-10-30T14:17:41.086Z");
      assert.deepEqual(state.agents.map((x) => x.agentId), [A, B], "triés par since");
    });

    test("deux réactivations de a152… : 14:14:22 (started) et 14:16:05 (reported), chaque fin les clôt", () => {
      const steps = [];
      for (let n = 1; n <= 9; n += 1) {
        const a = agentOf(prefix(n), A) ?? prefix(n).agents[0];
        steps.push([n, a.phase, a.finishedAt, a.block, a.mode]);
      }
      assert.deepEqual(steps, [
        [1, "requested", null, null, "CADRAGE_QUESTIONS"],
        [2, "running", null, null, "CADRAGE_QUESTIONS"],
        [3, "running", null, null, "CADRAGE_QUESTIONS"],
        [4, "reported", null, "QUESTIONS", "CADRAGE_QUESTIONS"],
        [5, "finished", "2026-10-30T14:13:36.390Z", "QUESTIONS", "CADRAGE_QUESTIONS"],
        [6, "running", null, null, "CADRAGE_QUESTIONS"], // 14:14:22 : première réactivation (started)
        [7, "finished", "2026-10-30T14:15:36.614Z", null, "CADRAGE_QUESTIONS"], // fin de tour sans rapport
        [8, "reported", null, "PROPOSITION", "CADRAGE_PROPOSITION"], // 14:16:05 : seconde réactivation (reported sans started)
        [9, "finished", "2026-10-30T14:16:08.735Z", "PROPOSITION", "CADRAGE_PROPOSITION"],
      ]);
      assert.equal(prefix(6).agents[0].updatedAt, "2026-10-30T14:14:22.168Z");
      assert.equal(prefix(8).agents[0].updatedAt, "2026-10-30T14:16:05.572Z");
      for (let n = 1; n <= 9; n += 1) {
        const a = prefix(n).agents[0];
        assert.equal(a.id, "toolu_01TgFJ174zajsWqDbJDYBTR2");
        assert.equal(a.since, "2026-10-30T14:13:03.588Z");
      }
    });

    test("le second architecte n'est jamais confondu avec le premier repris", () => {
      const after = prefix(10);
      assert.equal(after.agents.length, 2);
      assert.equal(after.agents[0].phase, "finished");
      assert.equal(after.agents[1].phase, "requested");
      const running = prefix(12);
      assert.equal(agentOf(running, B).id, "toolu_011uY1fsUab3NjGKWBDc4j83");
      assert.equal(agentOf(running, B).phase, "running");
      assert.equal(agentOf(running, A).phase, "finished");
    });

    test("le résultat ne dépend pas de l'ordre d'écriture du journal", () => {
      const now = "2026-10-30T14:18:00.000Z";
      const expected = reduce(null, journal, now);
      assert.deepEqual(reduce(null, [...journal].reverse(), now), expected);
      // started et launched au même ts (hooks async), dans un sens ou dans l'autre : même agent, même état final.
      const tied = journal.map((e, i) => (i === 2 ? { ...e, ts: journal[1].ts } : e));
      const swapped = [...tied];
      [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
      assert.deepEqual(reduce(null, swapped, now), reduce(null, tied, now));
      assert.equal(reduce(null, swapped, now).agents.length, 2);
      assert.equal(agentOf(reduce(null, swapped, now), A).toolUseId, "toolu_01TgFJ174zajsWqDbJDYBTR2");
      assert.equal(agentOf(reduce(null, swapped, now), A).phase, "finished");
    });

    test("purge à 10 min après la dernière fin de chaque agent (le dernier cycle)", () => {
      const ids = (now) => reduce(null, journal, now).agents.map((a) => a.agentId);
      assert.deepEqual(ids("2026-10-30T14:26:08.734Z"), [A, B]);
      assert.deepEqual(ids("2026-10-30T14:26:08.735Z"), [B]);
      assert.deepEqual(ids("2026-10-30T14:27:41.086Z"), []);
    });
  });
});

// --- Cycles complets, rejoués à partir des fixtures de #2 ---------------------------------------------------

const HOOK_FIXTURES = path.join(__dirname, "..", "fixtures", "hooks");
const hook = (name, minutes, patch = {}) => {
  const payload = { ...JSON.parse(fs.readFileSync(path.join(HOOK_FIXTURES, `${name}.json`), "utf8")), ...patch };
  const event = normalize(payload, { now: at(minutes) });
  assert.ok(event, `la fixture ${name} doit donner un événement`);
  return event;
};
const gh = (command, minutes, session = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13") => {
  const events = ghCommandToEvents(command, { now: at(minutes), sessionId: session });
  assert.ok(events.length > 0, command);
  return events;
};

describe("cycles complets rejoués à partir des fixtures", () => {
  const snap = () =>
    snapshot([issue(7, "ready", { title: "Ajouter une tâche" })], {
      fetchedAt: at(-5),
      pulls: [pull(12, "feature/7-ajouter-une-tache")],
    });
  const stateAfter = (events, minutes) => reduce(snap(), events, at(minutes));
  // L'instantané du cycle date d'avant le premier événement : on ignore son avertissement de péremption.
  const fresh = (warnings) => warnings.filter((w) => w.code !== "SNAPSHOT_STALE");

  test("cycle en arrière-plan : développeur lancé async, SubagentStart, SubagentStop, puis passage en revue", () => {
    const events = [
      ...gh("gh issue edit 7 --repo acme/demo-todo --remove-label status:ready --add-label status:in-progress", 0),
      hook("pre-tool-use-agent", 1),
      hook("post-tool-use-agent-async-launched", 2),
      hook("subagent-start", 3),
      hook("subagent-stop", 20),
      ...gh("gh issue edit 7 --repo acme/demo-todo --remove-label status:in-progress --add-label status:in-review", 21),
    ];
    const snapshotsOfPhases = [2, 3, 4, 5].map((n) => {
      const state = stateAfter(events.slice(0, n), 25);
      assert.equal(state.agents.length, 1, `après ${n} événement(s)`);
      return [state.agents[0].phase, featureOf(state, 7).station];
    });
    assert.deepEqual(snapshotsOfPhases, [
      ["requested", "dev"],
      ["running", "dev"],
      ["running", "dev"],
      ["finished", "dev"],
    ]);

    const final = stateAfter(events, 25);
    assert.deepEqual(fresh(final.warnings), []);
    assert.equal(featureOf(final, 7).station, "verification");
    assert.equal(featureOf(final, 7).pr, 12);
    assert.deepEqual(final.agents, [
      {
        id: "toolu_01Aq8Zp3Xv5Rk2Nm7Ls9Wd4T",
        type: "developpeur",
        mode: "IMPLEMENTATION",
        issue: 7,
        pr: null,
        attempt: null,
        station: "dev",
        phase: "finished",
        since: at(1),
        updatedAt: at(20),
        finishedAt: at(20),
        verdict: "LIVRÉ",
        block: null,
        agentId: "a4d2c8f1e0b3a297",
        toolUseId: "toolu_01Aq8Zp3Xv5Rk2Nm7Ls9Wd4T",
      },
    ]);
  });

  test("cycle en arrière-plan sans SubagentStop : le passage de l'issue en revue clôt l'agent", () => {
    const events = [
      ...gh("gh issue edit 7 --repo acme/demo-todo --add-label status:in-progress", 0),
      hook("pre-tool-use-agent", 1),
      hook("post-tool-use-agent-async-launched", 2),
      ...gh("gh issue edit 7 --repo acme/demo-todo --remove-label status:in-progress --add-label status:in-review", 9),
    ];
    const state = stateAfter(events, 10);
    assert.equal(state.agents.length, 1);
    assert.equal(state.agents[0].phase, "finished");
    assert.equal(state.agents[0].finishedAt, at(9));
    assert.equal(featureOf(state, 7).status, "in-review");
  });

  test("cycle synchrone : vérificateur requested, rapport, fin par PostToolUse, passage en test, merge", () => {
    const startPayload = {
      ...JSON.parse(fs.readFileSync(path.join(HOOK_FIXTURES, "subagent-start.json"), "utf8")),
      agent_id: "b7e1f4a2c9d83056",
      agent_type: VERIF,
    };
    const events = [
      ...gh("gh issue edit 7 --repo acme/demo-todo --remove-label status:in-progress --add-label status:in-review", 0),
      hook("pre-tool-use-agent-verificateur", 1),
      normalize(startPayload, { now: at(2) }),
      hook("pre-tool-use-subagent-handback", 8),
      hook("post-tool-use-agent-completed", 9),
      ...gh("gh issue edit 7 --repo acme/demo-todo --remove-label status:in-review --add-label status:in-test", 10),
    ];
    assert.ok(events.every(Boolean));

    const mid = stateAfter(events.slice(0, 4), 8.5);
    assert.deepEqual(mid.agents.map((a) => [a.phase, a.agentId, a.verdict, a.block]), [
      ["reported", "b7e1f4a2c9d83056", "PASS", "RAPPORT_VERIFICATION"],
    ]);
    assert.equal(featureOf(mid, 7).station, "verification");

    const final = stateAfter(events, 12);
    assert.equal(final.agents.length, 1, "le handback, le start et la fin partagent un seul agent");
    const [a] = final.agents;
    assert.equal(a.id, "toolu_01Bc4Yq6Tn8Hj3Mp5Rw2Vx9K");
    assert.equal(a.type, "verificateur");
    assert.equal(a.issue, 7);
    assert.equal(a.pr, 12);
    assert.equal(a.attempt, 2);
    assert.equal(a.phase, "finished");
    assert.equal(a.finishedAt, at(9));
    assert.equal(a.verdict, "PASS");
    assert.equal(featureOf(final, 7).station, "test");
    assert.deepEqual(fresh(final.warnings), []);
  });

  test("un cycle complet de bout en bout : développeur, vérificateur, testeur, merge, mergé sur develop", () => {
    const events = [
      ...gh("gh issue edit 7 --repo acme/demo-todo --add-label status:in-progress", 0),
      ev("agent.requested", 1, { toolUseId: "d1", agentType: DEV, issue: 7, mode: "IMPLEMENTATION" }),
      ev("agent.launched", 2, { toolUseId: "d1", agentId: "d1a" }),
      ev("agent.finished", 3, { agentId: "d1a", source: "stop", verdict: "LIVRÉ" }),
      ...gh("gh issue edit 7 --repo acme/demo-todo --add-label status:in-review", 4, S1),
      ev("agent.requested", 5, { toolUseId: "v1", agentType: VERIF, issue: 7, pr: 12 }),
      ev("agent.finished", 7, { toolUseId: "v1", agentId: "v1a", source: "tool" }),
      ...gh("gh issue edit 7 --repo acme/demo-todo --add-label status:in-test", 8, S1),
      ev("agent.requested", 9, { toolUseId: "t1", agentType: TEST, issue: 7, pr: 12 }),
      ev("agent.started", 10, { agentId: "t1a", agentType: TEST }),
      ...gh("gh pr merge 12 --repo acme/demo-todo --squash --delete-branch && gh issue close 7 --repo acme/demo-todo && gh issue edit 7 --repo acme/demo-todo --remove-label status:in-test --add-label status:done", 12, S1),
    ];
    const state = stateAfter(events, 12.5);
    assert.equal(featureOf(state, 7).status, "done");
    assert.equal(featureOf(state, 7).station, "merge");
    assert.deepEqual(state.agents.map((a) => [a.type, a.phase]), [
      ["developpeur", "finished"],
      ["verificateur", "finished"],
      ["testeur", "finished"],
    ]);
    assert.deepEqual(fresh(state.warnings), []);
  });
});

// --- Robustesse au contrat ----------------------------------------------------------------------------------

describe("robustesse au contrat (ARCHITECTURE § 6)", () => {
  const SNAP = snapshot([issue(3, "in-progress")], { fetchedAt: at(1), pulls: [pull(50, "release/m1-socle", "open", "main")] });
  const NOW = at(6);

  // Un événement complet par type, avec ses champs obligatoires (tableau « Champs par type »).
  const COMPLETE = {
    "agent.requested": { toolUseId: "tX", agentType: DEV, issue: 3 },
    "agent.launched": { toolUseId: "tX", agentId: "aX" },
    "agent.started": { agentId: "aX", agentType: DEV },
    "agent.reported": { agentId: "aX" },
    "agent.finished": { agentId: "aX", source: "stop" },
    "feature.status": { issue: 3, status: "in-review" },
    "feature.retry": { issue: 3, retry: 2 },
    "issue.created": { ref: M1 },
    "issue.closed": { issue: 3 },
    "pr.opened": { ref: "feature/3-x" },
    "release.opened": { ref: "release/m2-api" },
    "pr.merged": { pr: 50 },
    "milestone.changed": { ref: "1", status: "closed" },
  };
  const REQUIRED = {
    "agent.requested": ["toolUseId", "agentType"],
    "agent.launched": ["toolUseId", "agentId"],
    "agent.started": ["agentId", "agentType"],
    "agent.reported": ["agentId"],
    "agent.finished": ["agentId", "source"],
    "feature.status": ["issue", "status"],
    "feature.retry": ["issue", "retry"],
    "issue.created": ["ref"],
    "issue.closed": ["issue"],
    "pr.opened": ["ref"],
    "release.opened": ["ref"],
    "pr.merged": ["pr"],
    "milestone.changed": ["ref"],
  };
  const NO_DIRECT_EFFECT = new Set(["issue.created", "issue.closed", "pr.opened"]);
  const baseline = withoutWarnings(reduce(SNAP, [], NOW));

  test("le tableau de test couvre exactement les types du schéma", () => {
    assert.deepEqual(Object.keys(COMPLETE).sort(), [...EVENT_TYPES].sort());
    assert.deepEqual(Object.keys(REQUIRED).sort(), [...EVENT_TYPES].sort());
  });

  for (const type of EVENT_TYPES) {
    test(`${type} complet est pris en compte`, () => {
      const state = reduce(SNAP, [ev(type, 5, COMPLETE[type])], NOW);
      assert.deepEqual(state.warnings, []);
      if (NO_DIRECT_EFFECT.has(type)) assert.deepEqual(state, baseline);
      else assert.notDeepEqual(withoutWarnings(state), baseline);
    });

    for (const field of REQUIRED[type]) {
      test(`${type} sans ${field} est ignoré : état inchangé, sans exception`, () => {
        const { [field]: _removed, ...partial } = COMPLETE[type]; // eslint-disable-line no-unused-vars
        const state = reduce(SNAP, [ev(type, 5, partial)], NOW);
        assert.deepEqual(withoutWarnings(state), baseline);
        assert.equal(state.warnings.length, 1);
        assert.equal(state.warnings[0].code, "EVENT_INCOMPLETE");
        assert.match(state.warnings[0].message, new RegExp(type.replace(".", "\\.")));
        assert.match(state.warnings[0].message, new RegExp(field));
      });
    }
  }

  test("des champs obligatoires de mauvais type sont traités comme manquants", () => {
    const bad = [
      ev("feature.status", 5, { issue: "3", status: "in-review" }),
      ev("feature.status", 5, { issue: 0, status: "in-review" }),
      ev("feature.status", 5, { issue: 3, status: "" }),
      ev("feature.retry", 5, { issue: 3, retry: 0 }),
      ev("feature.retry", 5, { issue: 3, retry: "2" }),
      ev("agent.finished", 5, { agentId: "aX", source: "autre" }),
      ev("agent.started", 5, { agentId: "agent-", agentType: DEV }),
      ev("pr.merged", 5, { pr: -4 }),
    ];
    const state = reduce(SNAP, bad, NOW);
    assert.deepEqual(withoutWarnings(state), baseline);
    assert.deepEqual(state.warnings.map((w) => w.code), ["EVENT_INCOMPLETE", "EVENT_INCOMPLETE", "EVENT_INCOMPLETE", "EVENT_INCOMPLETE", "EVENT_INCOMPLETE"]);
  });

  test("feature.retry porte retry et non attempt", () => {
    const state = reduce(SNAP, [ev("feature.retry", 5, { issue: 3, attempt: 2 })], NOW);
    assert.equal(featureOf(state, 3).retry, 0);
    assert.equal(state.warnings[0].code, "EVENT_INCOMPLETE");
    assert.equal(featureOf(reduce(SNAP, [ev("feature.retry", 5, { issue: 3, retry: 2 })], NOW), 3).retry, 2);
  });

  test("un type inconnu, une version future ou un événement non objet sont ignorés sans exception", () => {
    const junk = [
      ev("agent.exploded", 5, { agentId: "aX" }),
      { ...ev("feature.status", 5, { issue: 3, status: "done" }), v: 2 },
      null,
      undefined,
      42,
      "feature.status",
      [],
      {},
      { type: "feature.status" },
      { v: 1, type: "feature.status", issue: 3, status: "done" },
      { v: 1, ts: "pas une date", type: "feature.status", issue: 3, status: "done" },
      { v: 1, ts: at(5), type: { x: 1 } },
    ];
    const state = reduce(SNAP, junk, NOW);
    assert.deepEqual(withoutWarnings(state), baseline);
    assert.ok(state.warnings.every((w) => w.code === "EVENT_INCOMPLETE"));
    assert.ok(!state.warnings.some((w) => /exploded/.test(w.message)), "un type inconnu ne produit pas d'avertissement");
  });

  test("un événement invalide entre deux événements valides ne perturbe pas les autres", () => {
    const good = [ev("feature.status", 4, { issue: 3, status: "in-review" }), ev("agent.requested", 5, { toolUseId: "t1", agentType: DEV, issue: 3 })];
    const noisy = [good[0], ev("agent.finished", 4.5, { source: "stop" }), good[1]];
    assert.deepEqual(withoutWarnings(reduce(SNAP, noisy, NOW)), withoutWarnings(reduce(SNAP, good, NOW)));
  });

  test("agent.reported sans block est accepté", () => {
    const events = [ev("agent.requested", 1, { toolUseId: "t1", agentType: DEV, issue: 3 }), ev("agent.reported", 2, { agentId: "aX", agentType: DEV })];
    const state = reduce(SNAP, events, NOW);
    assert.deepEqual(state.warnings, []);
    assert.equal(state.agents[0].phase, "reported");
    assert.equal(state.agents[0].block, null);
    assert.equal(state.agents[0].agentId, "aX");
  });

  for (const verdict of ["PASS", "FAIL", "LIVRÉ", "BLOQUÉ", "APPROUVÉ", "À REVOIR"]) {
    test(`le verdict ${verdict} est accepté et conservé`, () => {
      const events = [
        ev("agent.requested", 1, { toolUseId: "t1", agentType: ARCHI, mode: "REVUE_ROADMAP" }),
        ev("agent.reported", 2, { agentId: "aX", agentType: ARCHI, block: "VERDICT_ROADMAP", verdict }),
      ];
      const state = reduce(SNAP, events, NOW);
      assert.deepEqual(state.warnings, []);
      assert.equal(state.agents[0].verdict, verdict);
      assert.equal(state.agents[0].phase, "reported");
    });
  }

  test("ref s'interprète selon le type : branche, titre de milestone ou numéro de milestone", () => {
    const events = [
      ev("pr.opened", 2, { ref: "feature/3-x", issue: 3 }),
      ev("issue.created", 3, { ref: M2, status: "ready" }),
      ev("release.opened", 4, { ref: "release/m2-api" }),
      ev("milestone.changed", 5, { ref: "2", status: "closed" }),
    ];
    const state = reduce(SNAP, events, NOW);
    assert.deepEqual(state.features.map((f) => f.number), [3], "ni pr.opened ni issue.created ne créent une feature");
    assert.deepEqual(state.releases.map((r) => r.branch), ["release/m1-socle", "release/m2-api"]);
    assert.equal(state.releases[1].milestone, M2);
    assert.deepEqual(state.milestones.map((m) => m.state), ["open", "closed"]);
  });

  test("un statut inconnu dans feature.status est ignoré", () => {
    const state = reduce(SNAP, [ev("feature.status", 5, { issue: 3, status: "teleporte" })], NOW);
    assert.equal(featureOf(state, 3).status, "in-progress");
  });

  test("des arguments absents ou invalides ne font pas lever d'exception", () => {
    for (const args of [[], [undefined, undefined, undefined], [null, null, null], ["x", "y", "z"], [{}, {}, {}], [[], 3, NaN], [{ issues: "x", milestones: 4, pulls: {} }, [], at(1)]]) {
      const state = reduce(...args);
      assert.deepEqual(Object.keys(state).sort(), ["agents", "features", "milestones", "releases", "repo", "updatedAt", "warnings"]);
      assert.deepEqual([state.features, state.agents, state.milestones, state.releases], [[], [], [], []]);
    }
  });

  test("des éléments d'instantané mal formés sont écartés", () => {
    const snap = {
      repo: "o/r",
      fetchedAt: at(0),
      issues: [null, 3, { number: "x" }, { number: 5, labels: "status:done" }, { number: 6, title: "ok", labels: ["status:ready", 12, null], state: "open" }],
      milestones: [null, { number: 1 }, { title: "sans numéro" }],
      pulls: [null, { number: 1 }, { head: "x" }],
    };
    const state = reduce(snap, [], at(1));
    assert.deepEqual(state.features.map((f) => f.number), [6]);
    assert.deepEqual(state.milestones, []);
    assert.deepEqual(state.releases, []);
  });
});

describe("warnings[]", () => {
  test("transmet les avertissements de l'appelant (GH_*) avec code, message et date, sans détail brut", () => {
    const codes = ["GH_REPO", "GH_CONFIG", "GH_MISSING", "GH_AUTH", "GH_TIMEOUT", "GH_PARSE"];
    const external = codes.map((code) => ({ code, message: `message ${code}`, detail: "stderr secret", token: "ghp_x" }));
    const extra = [{ code: "GH_AUTH", message: "daté", at: at(2) }, null, { code: "", message: "x" }, { code: "X" }];
    const state = reduce(snapshot([], { fetchedAt: at(5) }), [], at(6), { warnings: [...external, ...extra] });
    assert.deepEqual(state.warnings, [
      ...codes.map((code) => ({ code, message: `message ${code}`, at: at(6) })),
      { code: "GH_AUTH", message: "daté", at: at(2) },
    ]);
    assert.ok(!JSON.stringify(state).includes("secret"));
    assert.deepEqual(reduce(snapshot([]), [], at(1), { warnings: "x" }).warnings, []);
  });

  test("vide quand tout va bien", () => {
    assert.deepEqual(reduce(snapshot([issue(1, "ready")]), [ev("feature.status", 1, { issue: 1, status: "in-progress" })], at(2)).warnings, []);
  });

  test("SNAPSHOT_MISSING sans instantané, daté de l'horloge injectée", () => {
    assert.deepEqual(reduce(null, [], at(7)).warnings, [
      { code: "SNAPSHOT_MISSING", message: "aucun instantané GitHub : état construit à partir du journal seul", at: at(7) },
    ]);
  });

  test("SNAPSHOT_STALE au-delà de 5 min sans recalage, pas avant", () => {
    const snap = snapshot([], { fetchedAt: at(0) });
    assert.deepEqual(reduce(snap, [], at(5)).warnings, []);
    const [w] = reduce(snap, [], at(8)).warnings;
    assert.equal(w.code, "SNAPSHOT_STALE");
    assert.equal(w.at, at(8));
    assert.match(w.message, /8 min/);
  });

  test("EVENT_INCOMPLETE : un avertissement par type, avec le nombre d'événements et les champs en cause", () => {
    const events = [
      ev("feature.status", 1, { issue: 1 }),
      ev("feature.status", 2, { status: "done" }),
      ev("feature.status", 3, {}),
      ev("pr.merged", 4, {}),
      ev("agent.exploded", 5, {}),
    ];
    const warnings = reduce(snapshot([], { fetchedAt: at(5) }), events, at(6)).warnings;
    assert.deepEqual(warnings, [
      {
        code: "EVENT_INCOMPLETE",
        message: '3 événement(s) "feature.status" ignoré(s) : champ obligatoire manquant ou invalide (status, issue)',
        at: at(6),
      },
      {
        code: "EVENT_INCOMPLETE",
        message: '1 événement(s) "pr.merged" ignoré(s) : champ obligatoire manquant ou invalide (pr)',
        at: at(6),
      },
    ]);
  });

  test("l'horloge injectée est la seule source de temps (aucune dérive d'un appel à l'autre)", () => {
    const events = [ev("agent.requested", 0, { toolUseId: "t", agentType: DEV, issue: 1 })];
    const a = reduce(null, events, new Date(T0 + 50 * MIN));
    const b = reduce(null, events, T0 + 50 * MIN);
    const c = reduce(null, events, at(50));
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    assert.equal(a.agents[0].phase, "unknown");
  });
});

describe("préfixe des agents : nouveau (gepet-squad:) et ancien (claude-gepet-squad:)", () => {
  const typeOf = (agentType) => reduce(snapshot([]), [ev("agent.requested", 1, { toolUseId: "tP", agentType, issue: 3 })], at(2)).agents[0].type;

  for (const [agentType, expected] of [
    ["gepet-squad:developpeur", "developpeur"],
    ["claude-gepet-squad:developpeur", "developpeur"],
    ["gepet-squad:architecte", "architecte"],
    ["claude-gepet-squad:verificateur", "verificateur"],
  ]) {
    test(`${agentType} -> type court ${expected}`, () => {
      assert.equal(typeOf(agentType), expected);
    });
  }

  test("un autre plugin ou un préfixe approchant n'est pas réduit au nom court d'un agent de la squad", () => {
    for (const agentType of ["autre-plugin:architecte", "claude-gepet-squad-evil:x", "gepet-squad-evil:developpeur"]) {
      const type = typeOf(agentType);
      assert.equal(type, agentType, agentType);
      assert.ok(!["architecte", "developpeur", "verificateur", "testeur"].includes(type));
    }
  });

  test("la variante developpeur-outille s'affiche comme un développeur, au poste dev", () => {
    assert.equal(typeOf("gepet-squad:developpeur-outille"), "developpeur");
    const state = reduce(snapshot([]), [ev("agent.requested", 1, { toolUseId: "tO", agentType: "gepet-squad:developpeur-outille", issue: 3 })], at(2));
    assert.equal(state.agents[0].station, "dev");
  });

  test("un agent d'un autre plugin ne prend pas la station d'un agent de la squad", () => {
    const state = reduce(snapshot([]), [ev("agent.requested", 1, { toolUseId: "tX", agentType: "autre-plugin:developpeur", issue: 3 })], at(2));
    assert.notEqual(state.agents[0].type, "developpeur");
    assert.notEqual(state.agents[0].station, "dev");
  });

  test("les deux préfixes donnent le même agent, y compris dans un même journal", () => {
    const mixed = [
      ev("agent.requested", 1, { toolUseId: "tA", agentType: "gepet-squad:developpeur", mode: "IMPLEMENTATION", issue: 3, attempt: 1 }),
      ev("agent.launched", 2, { toolUseId: "tA", agentId: "agent-aaa", agentType: "gepet-squad:developpeur" }),
      ev("agent.started", 3, { agentId: "aaa", agentType: "claude-gepet-squad:developpeur" }),
      ev("agent.finished", 4, { agentId: "aaa", source: "stop" }),
    ];
    const withPrefix = (prefix) => mixed.map((e) => (e.agentType ? { ...e, agentType: e.agentType.replace(/^(claude-)?gepet-squad:/, prefix) } : e));
    const legacy = reduce(snapshot([]), withPrefix("claude-gepet-squad:"), at(5)).agents;
    const modern = reduce(snapshot([]), withPrefix("gepet-squad:"), at(5)).agents;
    const both = reduce(snapshot([]), mixed, at(5)).agents;
    assert.equal(legacy.length, 1);
    assert.deepEqual(modern, legacy);
    assert.deepEqual(both, legacy);
    assert.equal(legacy[0].type, "developpeur");
    assert.equal(legacy[0].phase, "finished");
  });
});
