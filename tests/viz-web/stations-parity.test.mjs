// Test de parité : les stations calculées par viz/public/js/state.js sont celles du réducteur serveur
// (viz/lib/reducer.cjs, ARCHITECTURE § 6). Le réducteur est chargé en lecture seule par createRequire :
// il n'est ni modifié ni réécrit, et ce test échoue dès que l'une des deux règles diverge.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import * as client from "../../viz/public/js/state.js";
import { at, ev, evt, stateOf, M1, M2, DEV, VERIF, TEST, ARCHI } from "./support.mjs";

const require = createRequire(import.meta.url);
const server = require("../../viz/lib/reducer.cjs");

const { init, apply } = client;

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
        const { model: next } = apply(model, { event: "evt", data: event });
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
      const next = apply(init(serverState(snap)), { event: "evt", data: event }).model.features[0];
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
      model = apply(model, { event: "evt", data: event }).model;
      const expected = serverState(snap, journal.slice(0, i + 1)).features[0];
      assert.deepEqual(placeOf(model.features[0]), placeOf(expected), `après l'événement ${i + 1}`);
    }
    assert.deepEqual(placeOf(model.features[0]), { station: "verification", escalated: true });

    // Sans station connue par le journal, le serveur retombe sur dev : c'est aussi le cas du client pour une feature inconnue.
    const lone = [ev("feature.status", 1, { issue: 9, status: "blocked" })];
    const loneSnap = { ...snapshot({ status: "ready" }), issues: [] };
    const loneExpected = serverState(loneSnap, lone).features[0];
    const loneNext = apply(init(serverState(loneSnap)), { event: "evt", data: lone[0] }).model.features[0];
    assert.deepEqual(placeOf(loneNext), placeOf(loneExpected));
    assert.deepEqual(placeOf(loneNext), { station: "dev", escalated: true });
  });

  test("le déblocage ramène la feature dans la file de sa station, comme le serveur", () => {
    const snap = snapshot({ status: "in-test" });
    const journal = [ev("feature.status", 1, { issue: 7, status: "blocked" }), ev("feature.status", 2, { issue: 7, status: "in-test" })];
    let model = init(serverState(snap));
    for (const event of journal) model = apply(model, { event: "evt", data: event }).model;
    assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, journal).features[0]));
    assert.deepEqual(placeOf(model.features[0]), { station: "test", escalated: false });
  });

  test("milestone.changed fermeture et réouverture, pour chaque statut", () => {
    for (const status of server.STATUSES) {
      const snap = snapshot({ status });
      const close = ev("milestone.changed", 5, { ref: "1", status: "closed" });
      const reopen = ev("milestone.changed", 6, { ref: "1", status: "open" });
      let model = init(serverState(snap));
      model = apply(model, { event: "evt", data: close }).model;
      assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, [close]).features[0]), `${status} fermé`);
      model = apply(model, { event: "evt", data: reopen }).model;
      assert.deepEqual(placeOf(model.features[0]), placeOf(serverState(snap, [close, reopen]).features[0]), `${status} rouvert`);
    }
  });

  test("release.opened puis pr.merged, pour chaque statut", () => {
    for (const status of server.STATUSES) {
      const snap = snapshot({ status, pulls: [releasePr("open")] });
      const snapNoRelease = snapshot({ status });
      const opened = ev("release.opened", 5, { ref: "release/m1-socle" });
      const expectedOpened = serverState(snapNoRelease, [opened]);
      const modelOpened = apply(init(serverState(snapNoRelease)), { event: "evt", data: opened }).model;
      assert.deepEqual(placeOf(modelOpened.features[0]), placeOf(expectedOpened.features[0]), `${status} après release.opened`);
      assert.deepEqual(modelOpened.releases.map((r) => [r.branch, r.state, r.milestone]), expectedOpened.releases.map((r) => [r.branch, r.state, r.milestone]));

      const merged = ev("pr.merged", 6, { pr: 40 });
      const expectedMerged = serverState(snap, [merged]);
      const modelMerged = apply(init(serverState(snap)), { event: "evt", data: merged }).model;
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
      model = apply(model, { event: "evt", data: event }).model;
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
      model = apply(model, { event: "evt", data: event }).model;
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
    for (const event of journal) model = apply(model, { event: "evt", data: event }).model;
    assert.deepEqual(placeOf(model.features[0]), placeOf(expected));
    assert.equal(model.features[0].status, expected.status);
    assert.equal(expected.status, "ready");
  });

  test("le client lit les mêmes événements complets que le serveur (messages evt construits par support.mjs)", () => {
    // Garde-fou du test lui-même : evt() produit bien un événement v1 accepté par le réducteur.
    const message = evt("feature.status", 5, { issue: 7, status: "done" });
    assert.equal(serverState(snapshot({ status: "ready" }), [message.data]).features[0].status, "done");
    assert.equal(apply(init(stateOf()), message).model.features[0].status, "done");
  });
});
