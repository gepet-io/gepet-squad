// Test de parité : les stations calculées par viz/public/js/state.js sont celles du réducteur serveur
// (viz/lib/reducer.cjs, ARCHITECTURE § 6). Le réducteur est chargé en lecture seule par createRequire :
// il n'est ni modifié ni réécrit, et ce test échoue dès que l'une des deux règles diverge.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import * as client from "../../viz/public/js/state.js";
import { at, ev, evt, sse, stateOf, M1, M2, DEV, VERIF, TEST, ARCHI } from "./support.mjs";

const require = createRequire(import.meta.url);
const server = require("../../viz/lib/reducer.cjs");

const { init, apply, tick } = client;

// Instantané au format de fetchSnapshot() : une feature, deux milestones, des PR optionnelles.
function snapshot({ status, milestone = M1, milestones = [["open"], ["open"]], pulls = [] }) {
  return {
    repo: "o/r",
    fetchedAt: at(0),
    issues: [
      {
        number: 7,
        title: "Feature 7",
        state: "open",
        labels: [`status:${status}`],
        status,
        retry: null,
        milestone,
        milestoneNumber: 1,
      },
    ],
    milestones: milestones.map(([state], i) => ({ number: i + 1, title: i === 0 ? M1 : M2, state, openIssues: 0, closedIssues: 0, dueOn: null })),
    pulls,
  };
}

const releasePr = (state) => ({ number: 40, title: "Release M1", state, head: "release/m1-socle", base: "main", url: "", draft: false, mergedAt: null });

// Les contextes de milestone qui font varier la station Release.
const CONTEXTS = {
  "milestone ouvert": {},
  "milestone fermé": { milestones: [["closed"], ["open"]] },
  "milestone ouvert avec PR de release ouverte": { pulls: [releasePr("open")] },
  "milestone ouvert avec PR de release mergée": { pulls: [releasePr("merged")] },
  "autre milestone fermé": { milestones: [["open"], ["closed"]] },
};

// État que le client reçoit du serveur pour un instantané donné (sans événement).
const serverState = (snap, events = [], now = at(30)) => server.reduce(snap, events, now);

const placeOf = (f) => ({ station: f.station, escalated: f.escalated });

describe("parité des tables de correspondance", () => {
  test("stations, statuts et zone d'escalade sont les mêmes que ceux du réducteur", () => {
    assert.deepEqual([...client.STATIONS], [...server.STATIONS]);
    assert.deepEqual({ ...client.STATUS_STATION }, { ...server.STATUS_STATION });
    assert.deepEqual([...client.STATUSES], [...server.STATUSES]);
    assert.equal(client.ESCALADE, server.ESCALADE);
    assert.equal(client.DEFAULT_BLOCKED_STATION, server.DEFAULT_BLOCKED_STATION);
    assert.equal(client.AGENT_FINISHED_TTL_MS, server.AGENT_FINISHED_TTL_MS);
    assert.equal(client.AGENT_UNKNOWN_AFTER_MS, server.AGENT_UNKNOWN_AFTER_MS);
  });

  test("couvre les 7 statuts `status:*` et `blocked`", () => {
    assert.deepEqual([...server.STATUSES].sort(), ["backlog", "blocked", "changes-requested", "done", "in-progress", "in-review", "in-test", "ready"]);
  });

  test("stationForStatus donne la même station pour chaque statut, et null pour un statut inconnu", () => {
    for (const status of [...server.STATUSES, "inconnu", "", undefined, "toString", "__proto__"]) {
      assert.equal(client.stationForStatus(status), server.stationForStatus(status), String(status));
    }
  });

  test("agentStation donne la même station pour chaque type d'agent et chaque MODE", () => {
    const types = ["developpeur", "verificateur", "testeur", "architecte", "inconnu", null];
    const modes = ["IMPLEMENTATION", "CORRECTIF", "CADRAGE_INITIAL", "CADRAGE_ROADMAP", "REVUE_ROADMAP", "ESCALADE", "AUTRE", null, undefined];
    for (const type of types) {
      for (const mode of modes) assert.equal(client.agentStation(type, mode), server.agentStation(type, mode), `${type} / ${mode}`);
    }
  });
});

describe("parité des stations des features, état initial", () => {
  for (const [name, context] of Object.entries(CONTEXTS)) {
    for (const status of server.STATUSES) {
      test(`${status}, ${name}`, () => {
        const fromServer = serverState(snapshot({ status, ...context }));
        const f = fromServer.features[0];
        // Le client recalcule la station depuis le statut et le milestone, sans reprendre celle du serveur.
        const withoutStation = { ...f };
        delete withoutStation.station;
        const model = init({ ...fromServer, features: [withoutStation] });
        assert.deepEqual(placeOf(model.features[0]), placeOf(f));
        // Et il garde la même quand le serveur la lui donne.
        assert.deepEqual(placeOf(init(fromServer).features[0]), placeOf(f));
      });
    }
  }

  test("un milestone fermé place toutes les features à Release, sauf blocked qui l'emporte", () => {
    for (const status of server.STATUSES) {
      const f = serverState(snapshot({ status, milestones: [["closed"], ["open"]] })).features[0];
      assert.deepEqual(placeOf(f), status === "blocked" ? { station: "dev", escalated: true } : { station: "release", escalated: false });
      assert.deepEqual(placeOf(init(serverState(snapshot({ status, milestones: [["closed"], ["open"]] }))).features[0]), placeOf(f));
    }
  });

  test("une PR de release ouverte ne place à Release que les features done", () => {
    for (const status of server.STATUSES) {
      const f = serverState(snapshot({ status, pulls: [releasePr("open")] })).features[0];
      assert.equal(f.station === "release", status === "done", status);
    }
  });
});

describe("parité des stations des features, par événement SSE", () => {
  // Pour chaque statut visé, depuis chaque statut de départ : le serveur rejoue l'événement, le client l'applique.
  for (const from of server.STATUSES) {
    for (const to of server.STATUSES) {
      test(`feature.status ${from} -> ${to}`, () => {
        const snap = snapshot({ status: from });
        const event = ev("feature.status", 5, { issue: 7, status: to });
        const expected = serverState(snap, [event]).features[0];
        const model = init(serverState(snap));
        const { model: next } = apply(model, sse("evt", event));
        assert.deepEqual(placeOf(next.features[0]), placeOf(expected));
        assert.equal(next.features[0].status, expected.status);
        assert.equal(next.features[0].retry, expected.retry);
      });
    }
  }

  test("feature.status d'une feature absente de l'instantané", () => {
    for (const to of server.STATUSES) {
      const snap = { ...snapshot({ status: "ready" }), issues: [] };
      const event = ev("feature.status", 5, { issue: 7, status: to });
      const expected = serverState(snap, [event]).features[0];
      const next = apply(init(serverState(snap)), sse("evt", event)).model.features[0];
      assert.deepEqual(placeOf(next), placeOf(expected), to);
    }
  });

  test("station d'accolement de blocked : dernière station connue par le journal, sinon dev", () => {
    const snap = snapshot({ status: "ready" });
    const journal = [
      ev("feature.status", 1, { issue: 7, status: "in-progress" }),
      ev("feature.status", 2, { issue: 7, status: "in-review" }),
      ev("feature.status", 3, { issue: 7, status: "blocked" }),
    ];
    let model = init(serverState(snap));
    for (const [i, event] of journal.entries()) {
      model = apply(model, sse("evt", event)).model;
      const expected = serverState(snap, journal.slice(0, i + 1)).features[0];
      assert.deepEqual(placeOf(model.features[0]), placeOf(expected), `après l'événement ${i + 1}`);
    }
    assert.deepEqual(placeOf(model.features[0]), { station: "verification", escalated: true });

    // Sans station connue par le journal, le serveur retombe sur dev : c'est aussi le cas du client pour une feature inconnue.
    const lone = [ev("feature.status", 1, { issue: 9, status: "blocked" })];
    const loneSnap = { ...snapshot({ status: "ready" }), issues: [] };
    const loneExpected = serverState(loneSnap, lone).features[0];
    const loneNext = apply(init(serverState(loneSnap)), sse("evt", lone[0])).model.features[0];
    assert.deepEqual(placeOf(loneNext), placeOf(loneExpected));
    assert.deepEqual(placeOf(loneNext), { station: "dev", escalated: true });
  });

  test("le déblocage ramène la feature dans la file de sa station, comme le serveur", () => {
    const snap = snapshot({ status: "in-test" });
    const journal = [ev("feature.status", 1, { issue: 7, status: "blocked" }), ev("feature.status", 2, { issue: 7, status: "in-test" })];
    let model = init(serverState(snap));
    for (const event of journal) model = apply(model, sse("evt", event)).model;
    assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, journal).features[0]));
    assert.deepEqual(placeOf(model.features[0]), { station: "test", escalated: false });
  });

  test("milestone.changed fermeture et réouverture, pour chaque statut", () => {
    for (const status of server.STATUSES) {
      const snap = snapshot({ status });
      const close = ev("milestone.changed", 5, { ref: "1", status: "closed" });
      const reopen = ev("milestone.changed", 6, { ref: "1", status: "open" });
      let model = init(serverState(snap));
      model = apply(model, sse("evt", close)).model;
      assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, [close]).features[0]), `${status} fermé`);
      model = apply(model, sse("evt", reopen)).model;
      assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, [close, reopen]).features[0]), `${status} rouvert`);
    }
  });

  test("release.opened puis pr.merged, pour chaque statut", () => {
    for (const status of server.STATUSES) {
      const snap = snapshot({ status, pulls: [releasePr("open")] });
      const snapNoRelease = snapshot({ status });
      const opened = ev("release.opened", 5, { ref: "release/m1-socle" });
      const expectedOpened = serverState(snapNoRelease, [opened]);
      const modelOpened = apply(init(serverState(snapNoRelease)), sse("evt", opened)).model;
      assert.deepEqual(placeOf(modelOpened.features[0]), placeOf(expectedOpened.features[0]), `${status} après release.opened`);
      assert.deepEqual(modelOpened.releases.map((r) => [r.branch, r.state, r.milestone]), expectedOpened.releases.map((r) => [r.branch, r.state, r.milestone]));

      const merged = ev("pr.merged", 6, { pr: 40 });
      const expectedMerged = serverState(snap, [merged]);
      const modelMerged = apply(init(serverState(snap)), sse("evt", merged)).model;
      assert.deepEqual(placeOf(modelMerged.features[0]), placeOf(expectedMerged.features[0]), `${status} après pr.merged`);
      assert.deepEqual(modelMerged.releases.map((r) => r.state), expectedMerged.releases.map((r) => r.state));
    }
  });

  test("totaux des milestones : mêmes total et done que le serveur après chaque événement", () => {
    const snap = {
      ...snapshot({ status: "ready" }),
      issues: [1, 2, 3].map((n) => ({ number: n, title: `F${n}`, state: "open", labels: ["status:in-progress"], status: "in-progress", retry: null, milestone: n < 3 ? M1 : M2, milestoneNumber: n < 3 ? 1 : 2 })),
    };
    const journal = [
      ev("feature.status", 1, { issue: 1, status: "done" }),
      ev("feature.status", 2, { issue: 3, status: "done" }),
      ev("feature.status", 3, { issue: 4, status: "ready" }),
    ];
    let model = init(serverState(snap));
    journal.forEach((event, i) => {
      model = apply(model, sse("evt", event)).model;
      const expected = serverState(snap, journal.slice(0, i + 1));
      assert.deepEqual(model.milestones.map((m) => [m.number, m.total, m.done]), expected.milestones.map((m) => [m.number, m.total, m.done]));
    });
  });
});

describe("parité du cycle de vie des agents", () => {
  test("rejeu d'un cycle complet en arrière-plan : mêmes phases, stations et verdict que le serveur", () => {
    const snap = snapshot({ status: "in-progress" });
    const journal = [
      ev("agent.requested", 1, { toolUseId: "tu1", agentType: DEV, mode: "IMPLEMENTATION", issue: 7, attempt: 1 }),
      ev("agent.launched", 2, { toolUseId: "tu1", agentId: "agent-abc" }),
      ev("agent.started", 3, { agentId: "abc", agentType: DEV }),
      ev("agent.reported", 4, { agentId: "abc", block: "RAPPORT_DEV", verdict: "LIVRÉ" }),
      ev("agent.finished", 5, { agentId: "abc", source: "stop" }),
      ev("feature.status", 6, { issue: 7, status: "in-review" }),
      ev("agent.requested", 7, { toolUseId: "tu2", agentType: VERIF, mode: "VERIFICATION", issue: 7 }),
      ev("agent.started", 8, { agentId: "def", agentType: VERIF }),
      ev("agent.finished", 9, { agentId: "def", source: "tool", toolUseId: "tu2" }),
      ev("agent.requested", 10, { toolUseId: "tu3", agentType: ARCHI, mode: "REVUE_ROADMAP" }),
      ev("agent.requested", 11, { toolUseId: "tu4", agentType: TEST, issue: 8 }),
    ];
    const summary = (agents) => agents.map((a) => [a.id, a.type, a.station, a.phase, a.issue, a.verdict, a.block, a.agentId, a.toolUseId]);
    let model = init(serverState(snap, []));
    journal.forEach((event, i) => {
      model = apply(model, sse("evt", event)).model;
      const expected = serverState(snap, journal.slice(0, i + 1), at(11));
      assert.deepEqual(summary(model.agents), summary(expected.agents), `après l'événement ${i + 1} (${event.type})`);
      assert.deepEqual(placeOf(model.features[0]), placeOf(expected.features[0]), `feature après ${event.type}`);
    });
  });
});

describe("parité de la lecture des événements", () => {
  test("un événement incomplet est ignoré des deux côtés, un type inconnu aussi", () => {
    const snap = snapshot({ status: "ready" });
    const journal = [
      ev("feature.status", 1, { status: "done" }),
      ev("feature.inconnu", 2, { issue: 7 }),
      { ...ev("feature.status", 3, { issue: 7, status: "done" }), v: 2 },
      ev("feature.status", 4, { issue: 7, status: "n-importe-quoi" }),
    ];
    const expected = serverState(snap, journal).features[0];
    let model = init(serverState(snap));
    for (const event of journal) model = apply(model, sse("evt", event)).model;
    assert.deepEqual(placeOf(model.features[0]), placeOf(expected));
    assert.equal(model.features[0].status, expected.status);
    assert.equal(expected.status, "ready");
  });

  test("le client lit les mêmes événements complets que le serveur (messages evt construits par support.mjs)", () => {
    // Garde-fou du test lui-même : evt() produit bien un événement v1 accepté par le réducteur.
    const message = evt("feature.status", 5, { issue: 7, status: "done" });
    assert.equal(serverState(snapshot({ status: "ready" }), [JSON.parse(message.data)]).features[0].status, "done");
    assert.equal(apply(init(stateOf()), message).model.features[0].status, "done");
  });
});

// --- Reprise d'un agent (ADR 0008) : la capture réelle et la sonde du vérificateur, événement par événement -------

const CAPTURE = readFileSync(new URL("../fixtures/journal/capture-reprise.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

// Instantané vide : les agents ne viennent que du journal.
const EMPTY_SNAPSHOT = { repo: "o/r", fetchedAt: "2026-10-30T14:00:00.000Z", issues: [], milestones: [], pulls: [] };

// Ce que le client doit partager avec le serveur pour chaque agent : phase, block, mode, station, et l'identité du cycle.
const agentView = (agents) =>
  agents.map((a) => ({
    id: a.id,
    type: a.type,
    mode: a.mode,
    station: a.station,
    phase: a.phase,
    block: a.block,
    verdict: a.verdict,
    issue: a.issue,
    since: a.since,
    updatedAt: a.updatedAt,
    finishedAt: a.finishedAt,
    agentId: a.agentId,
    toolUseId: a.toolUseId,
  }));

// Rejoue `journal` : le client reçoit un événement à la fois, le serveur rejoue le journal tronqué. Compare après CHAQUE événement.
function replayAndCompare(journal, label, snap = EMPTY_SNAPSHOT) {
  let model = init(server.reduce(snap, [], journal[0].ts));
  journal.forEach((event, i) => {
    model = apply(model, sse("evt", event)).model;
    const expected = server.reduce(snap, journal.slice(0, i + 1), event.ts);
    assert.deepEqual(agentView(model.agents), agentView(expected.agents), `${label} : après l'événement ${i + 1} (${event.type} ${event.ts})`);
  });
  return model;
}

describe("parité de la reprise d'agent (ADR 0008), capture réelle", () => {
  test("la capture compte 14 événements, dont une reprise par SendMessage", () => {
    assert.equal(CAPTURE.length, 14);
    assert.deepEqual(
      CAPTURE.filter((e) => e.agentId === "a152ecd0174a7c035").map((e) => e.type),
      ["agent.started", "agent.launched", "agent.reported", "agent.finished", "agent.started", "agent.finished", "agent.reported", "agent.finished"],
    );
  });

  test("après chaque événement, phase, block, mode et station de chaque agent sont ceux du serveur", () => {
    const model = replayAndCompare(CAPTURE, "capture");
    // État final attendu par l'ADR 0008 : l'architecte repris finit en PROPOSITION, pas en QUESTIONS.
    const resumed = model.agents.find((a) => a.agentId === "a152ecd0174a7c035");
    assert.deepEqual(
      [resumed.id, resumed.phase, resumed.block, resumed.mode, resumed.station, resumed.finishedAt, resumed.since],
      ["toolu_01TgFJ174zajsWqDbJDYBTR2", "finished", "PROPOSITION", "CADRAGE_PROPOSITION", "cadrage", "2026-10-30T14:16:08.735Z", "2026-10-30T14:13:03.588Z"],
    );
    const other = model.agents.find((a) => a.agentId === "a7181e1aa24ee1883");
    assert.deepEqual([other.phase, other.block, other.mode], ["finished", "QUESTIONS", "CADRAGE_QUESTIONS"]);
  });

  test("la reprise est visible au passage : finished -> running (14:14:22) puis finished -> reported (14:16:05)", () => {
    let model = init(server.reduce(EMPTY_SNAPSHOT, [], CAPTURE[0].ts));
    const phases = [];
    for (const event of CAPTURE) {
      const r = apply(model, sse("evt", event));
      model = r.model;
      for (const t of r.transitions) if (t.kind === "agent-phase" && t.id === "toolu_01TgFJ174zajsWqDbJDYBTR2") phases.push([event.ts.slice(11, 19), t.from, t.to]);
    }
    assert.deepEqual(phases, [
      ["14:13:04", "requested", "running"],
      ["14:13:33", "running", "reported"],
      ["14:13:36", "reported", "finished"],
      ["14:14:22", "finished", "running"],
      ["14:15:36", "running", "finished"],
      ["14:16:05", "finished", "reported"],
      ["14:16:08", "reported", "finished"],
    ]);
  });

  test("un lot de la capture, reçu dans le désordre, donne l'état du serveur", () => {
    const shuffled = [...CAPTURE].reverse();
    const model = apply(init(server.reduce(EMPTY_SNAPSHOT, [], CAPTURE[0].ts)), sse("evt", shuffled)).model;
    const expected = server.reduce(EMPTY_SNAPSHOT, shuffled, CAPTURE.at(-1).ts);
    assert.deepEqual(agentView(model.agents), agentView(expected.agents));
  });

  test("tick purge au dernier cycle, comme le serveur : l'architecte repris est retiré 10 min après sa dernière fin", () => {
    const model = replayAndCompare(CAPTURE, "capture");
    const ids = (agents) => agents.map((a) => a.id);
    // 14:16:08.735 est la dernière fin du premier architecte (pas 14:13:36) ; 14:17:41.086 celle du second.
    for (const now of ["2026-10-30T14:17:41.086Z", "2026-10-30T14:26:08.734Z", "2026-10-30T14:26:08.735Z", "2026-10-30T14:27:41.085Z", "2026-10-30T14:27:41.086Z"]) {
      assert.deepEqual(ids(tick(model, now).model.agents), ids(server.reduce(EMPTY_SNAPSHOT, CAPTURE, now).agents), `à ${now}`);
    }
    assert.deepEqual(ids(tick(model, "2026-10-30T14:26:08.735Z").model.agents), ["toolu_011uY1fsUab3NjGKWBDc4j83"]);
  });
});

describe("parité de la reprise d'agent (ADR 0008), sonde du vérificateur : LIVRÉ, puis reprise, puis BLOQUÉ", () => {
  const snap = { ...EMPTY_SNAPSHOT, issues: [{ number: 7, title: "F7", state: "open", labels: ["status:in-progress"], status: "in-progress", retry: null, milestone: M1, milestoneNumber: 1 }] };
  const probe = [
    ev("agent.requested", 1, { toolUseId: "tu1", agentType: DEV, mode: "IMPLEMENTATION", issue: 7, attempt: 1 }),
    ev("agent.launched", 2, { toolUseId: "tu1", agentId: "agent-abc" }),
    ev("agent.started", 2.01, { agentId: "abc", agentType: DEV }),
    ev("agent.reported", 3, { agentId: "abc", block: "RAPPORT_DEV", verdict: "LIVRÉ" }),
    ev("agent.finished", 4, { agentId: "abc", source: "stop" }),
    ev("agent.started", 5, { agentId: "abc", agentType: DEV }),
    ev("agent.reported", 6, { agentId: "abc", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
    ev("agent.finished", 7, { agentId: "abc", source: "stop" }),
    ev("agent.finished", 8, { agentId: "abc", source: "tool", toolUseId: "tu1" }),
  ];

  test("après chaque événement, le client et le serveur ont les mêmes agents", () => {
    const model = replayAndCompare(probe, "sonde", snap);
    const a = model.agents[0];
    assert.deepEqual([a.phase, a.verdict, a.finishedAt, a.since], ["finished", "BLOQUÉ", at(7), at(1)]);
  });

  test("un agent repris puis silencieux passe en `unknown` à 45 min de son dernier signal, jamais purgé", () => {
    const journal = probe.slice(0, 6); // reprise à 5 min, plus aucun signal
    const model = replayAndCompare(journal, "sonde", snap);
    for (const now of [at(5 + 10), at(5 + 44), at(5 + 45), at(5 + 120)]) {
      assert.deepEqual(agentView(tick(model, now).model.agents), agentView(server.reduce(snap, journal, now).agents), `à ${now}`);
    }
    assert.equal(tick(model, at(5 + 45)).model.agents[0].phase, "unknown");
  });
});
