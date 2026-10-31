// Tests unitaires de viz/public/js/state.js : init, messages `evt` / `snapshot` / `warning`, transitions à animer,
// cycle de vie et corrélation des agents, robustesse. Le module est pur : aucune horloge, aucun DOM.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  init,
  apply,
  tick,
  diff,
  placeOf,
  AGENT_FINISHED_TTL_MS,
  AGENT_UNKNOWN_AFTER_MS,
} from "../../viz/public/js/state.js";
import {
  at,
  ev,
  evt,
  sse,
  snapshotMsg,
  warningMsg,
  feature,
  milestone,
  stateOf,
  deepFreeze,
  M1,
  M2,
  DEV,
  VERIF,
  ARCHI,
} from "./support.mjs";

const featureOf = (model, number) => model.features.find((f) => f.number === number);
const agentOf = (model, id) => model.agents.find((a) => a.id === id);

// Applique une suite de messages et renvoie le dernier résultat, plus toutes les transitions dans l'ordre.
function run(model, messages) {
  let current = model;
  const all = [];
  let last = { model, transitions: [] };
  for (const message of messages) {
    last = apply(current, message);
    current = last.model;
    all.push(...last.transitions);
  }
  return { model: current, transitions: last.transitions, all };
}

describe("init(state)", () => {
  test("construit le modèle à partir de /state, avec stations calculées et totaux des milestones", () => {
    const model = init(
      stateOf({
        features: [feature(2, "in-progress"), feature(1, "done"), feature(3, "ready", { milestone: M2 })],
        agents: [],
      }),
    );
    assert.equal(model.repo, "o/r");
    assert.equal(model.updatedAt, at(0));
    assert.deepEqual(
      model.features.map((f) => [f.number, f.station, f.escalated]),
      [
        [1, "merge", false],
        [2, "dev", false],
        [3, "roadmap", false],
      ],
    );
    assert.deepEqual(model.milestones.map((m) => [m.number, m.total, m.done]), [[1, 2, 1], [2, 1, 0]]);
    assert.deepEqual(model.lastStation, {});
  });

  test("ne modifie pas son argument et renvoie une copie indépendante", () => {
    const state = deepFreeze(stateOf({ features: [feature(1, "ready")] }));
    const model = init(state);
    model.features[0].status = "done";
    assert.equal(state.features[0].status, "ready");
  });

  test("trie les features par numéro et les agents par date de début", () => {
    const agent = (id, since) => ({ id, type: "developpeur", mode: null, issue: null, pr: null, attempt: null, station: "dev", phase: "running", since, updatedAt: since, finishedAt: null, verdict: null, block: null, agentId: null, toolUseId: id });
    const model = init(stateOf({ features: [feature(9, "ready"), feature(3, "ready")], agents: [agent("b", at(2)), agent("a", at(1))] }));
    assert.deepEqual(model.features.map((f) => f.number), [3, 9]);
    assert.deepEqual(model.agents.map((a) => a.id), ["a", "b"]);
  });

  test("écarte les entrées invalides sans lever d'exception", () => {
    const model = init(
      stateOf({
        features: [feature(1, "ready"), { number: "x", status: "ready" }, { number: 2, status: "inconnu" }, null, 7],
        milestones: [milestone(1, M1), { number: 2 }, "m"],
        agents: [null, { type: "developpeur" }],
        releases: [{ pr: 1 }, null],
        warnings: [{ code: "GH_AUTH" }, { code: "GH_AUTH", message: "pas connecté" }],
      }),
    );
    assert.deepEqual(model.features.map((f) => f.number), [1]);
    assert.equal(model.milestones.length, 1);
    assert.deepEqual(model.agents, []);
    assert.deepEqual(model.releases, []);
    assert.deepEqual(model.warnings.map((w) => w.code), ["GH_AUTH"]);
    for (const bad of [undefined, null, 42, "x", [], {}]) {
      const empty = init(bad);
      assert.deepEqual(empty.features, []);
      assert.equal(empty.repo, null);
    }
  });

  test("conserve la station d'accolement d'une feature bloquée fournie par le serveur, et l'ignore si elle est invalide", () => {
    const model = init(
      stateOf({
        features: [feature(1, "blocked", { station: "test", escalated: true }), feature(2, "blocked", { station: "release" }), feature(3, "blocked")],
      }),
    );
    assert.deepEqual(model.features.map((f) => [f.station, f.escalated]), [["test", true], ["dev", true], ["dev", true]]);
  });
});

describe("apply : snapshot", () => {
  test("remplace entièrement l'état et renvoie les transitions de la différence", () => {
    const agent = { id: "a1", type: "developpeur", mode: null, issue: 1, pr: null, attempt: null, station: "dev", phase: "running", since: at(0), updatedAt: at(0), finishedAt: null, verdict: null, block: null, agentId: "x", toolUseId: "a1" };
    const before = init(stateOf({ features: [feature(1, "in-progress"), feature(2, "ready")], agents: [agent], warnings: [{ code: "GH_AUTH", message: "m", at: at(0) }] }));
    const next = stateOf({ repo: "o/autre", updatedAt: at(9), features: [feature(2, "in-review"), feature(3, "backlog")] });
    const { model, transitions } = apply(before, snapshotMsg(next));

    assert.equal(model.repo, "o/autre");
    assert.deepEqual(model.features.map((f) => [f.number, f.station]), [[2, "verification"], [3, "roadmap"]]);
    assert.deepEqual(model.agents, []);
    assert.deepEqual(model.warnings, []);
    assert.deepEqual(model.lastStation, {});
    assert.deepEqual(transitions, [
      { kind: "feature-remove", id: 1, from: "dev", to: null },
      { kind: "feature-move", id: 2, from: "roadmap", to: "verification" },
      { kind: "feature-add", id: 3, from: null, to: "roadmap" },
      { kind: "agent-remove", id: "a1", from: "dev", to: null },
    ]);
  });

  test("un snapshot identique ne produit aucune transition", () => {
    const state = stateOf({ features: [feature(1, "in-progress")] });
    const before = init(state);
    assert.deepEqual(apply(before, snapshotMsg(state)).transitions, []);
  });

  test("signale les changements de milestone, de release et de retry", () => {
    const before = init(stateOf({ features: [feature(1, "in-progress", { retry: 1 })], releases: [{ branch: "release/m1-x", pr: 5, state: "open", title: null, milestone: M1 }] }));
    const next = stateOf({
      milestones: [milestone(1, M1, "closed"), milestone(2, M2)],
      features: [feature(1, "in-progress", { retry: 2 })],
      releases: [
        { branch: "release/m1-x", pr: 5, state: "merged", title: null, milestone: M1 },
        { branch: "release/m2-y", pr: null, state: "open", title: null, milestone: M2 },
      ],
    });
    const { transitions } = apply(before, snapshotMsg(next));
    assert.deepEqual(transitions, [
      { kind: "milestone", id: 1, from: "open", to: "closed" },
      { kind: "release", id: "release/m1-x", from: "open", to: "merged" },
      { kind: "release", id: "release/m2-y", from: null, to: "open" },
      { kind: "feature-move", id: 1, from: "dev", to: "release" },
      { kind: "feature-retry", id: 1, from: 1, to: 2 },
    ]);
  });

  test("rejette un snapshot qui n'est pas un objet : modèle inchangé, sauf un avertissement EVENT_ERROR", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    for (const data of [null, 3, "pas du json", [1]]) {
      const r = apply(model, snapshotMsg(data));
      assert.deepEqual(r.model.features, model.features);
      assert.deepEqual(r.model.warnings.map((w) => w.code), ["EVENT_ERROR"], JSON.stringify(data));
      assert.match(r.model.warnings[0].message, /snapshot/);
      assert.deepEqual(r.transitions, []);
    }
  });
});

describe("apply : warning", () => {
  test("ajoute l'avertissement { code, message, at }, sans transition, et sans modifier le modèle d'origine", () => {
    const model = init(stateOf());
    const one = apply(model, warningMsg({ code: "GH_TIMEOUT", message: "gh trop lent", at: at(1) }));
    assert.deepEqual(one.model.warnings, [{ code: "GH_TIMEOUT", message: "gh trop lent", at: at(1) }]);
    assert.deepEqual(one.transitions, []);
    const two = apply(one.model, warningMsg({ code: "GH_AUTH", message: "a", at: at(2), detail: "stderr brut" }));
    assert.deepEqual(two.model.warnings.map((w) => w.code), ["GH_TIMEOUT", "GH_AUTH"]);
    assert.deepEqual(Object.keys(two.model.warnings[1]), ["code", "message", "at"], "seuls code, message et at sont recopiés");
    assert.equal(model.warnings.length, 0);
  });

  test("ne duplique pas un avertissement identique et borne la liste", () => {
    let model = init(stateOf());
    const w = (code, message) => warningMsg({ code, message, at: at(1) });
    for (let i = 0; i < 3; i++) model = apply(model, w("GH_AUTH", "même")).model;
    assert.equal(model.warnings.length, 1);
    for (let i = 0; i < 80; i++) model = apply(model, w("GH_PARSE", `m${i}`)).model;
    assert.equal(model.warnings.length, 50);
    assert.equal(model.warnings.at(-1).message, "m79");
  });

  test("un snapshot efface les avertissements (gh a récupéré)", () => {
    const model = apply(init(stateOf()), warningMsg({ code: "GH_AUTH", message: "x", at: at(1) })).model;
    assert.equal(apply(model, snapshotMsg(stateOf())).model.warnings.length, 0);
  });

  test("rejette toute autre forme d'avertissement par EVENT_ERROR : liste, { warnings }, champ manquant ou vide, at invalide", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const ok = { code: "GH_AUTH", message: "m", at: at(1) };
    const bad = [
      [ok],
      { warnings: [ok] },
      { code: "GH_AUTH", message: "m" },
      { code: "GH_AUTH", at: at(1) },
      { message: "m", at: at(1) },
      { ...ok, code: "  " },
      { ...ok, message: 4 },
      { ...ok, at: "pas une date" },
      { ...ok, at: 12 },
      {},
      4,
      null,
    ];
    for (const data of bad) {
      const r = apply(model, warningMsg(data));
      assert.deepEqual(r.model.warnings.map((w) => [w.code, w.message]), [["EVENT_ERROR", 'message SSE "warning" ignoré : data n\'a pas la forme { code, message, at }']], JSON.stringify(data));
      assert.deepEqual(r.model.features, model.features);
      assert.deepEqual(r.transitions, []);
    }
  });
});

describe("apply : evt feature.status", () => {
  test("déplace la feature et renvoie la transition", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "in-progress" }));
    assert.equal(featureOf(r.model, 1).station, "dev");
    assert.equal(featureOf(model, 1).station, "roadmap", "le modèle d'origine est inchangé");
    assert.deepEqual(r.transitions, [{ kind: "feature-move", id: 1, from: "roadmap", to: "dev" }]);
    assert.equal(r.model.updatedAt, at(1));
  });

  test("un changement de statut dans la même station est une transition de statut", () => {
    const model = init(stateOf({ features: [feature(1, "in-progress")] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "changes-requested" }));
    assert.deepEqual(r.transitions, [{ kind: "feature-status", id: 1, from: "in-progress", to: "changes-requested" }]);
    assert.equal(featureOf(r.model, 1).station, "dev");
  });

  test("suit tout le pipeline", () => {
    const model = init(stateOf({ features: [feature(1, "backlog")] }));
    const steps = [
      ["ready", "roadmap"],
      ["in-progress", "dev"],
      ["in-review", "verification"],
      ["in-test", "test"],
      ["done", "merge"],
    ];
    let current = model;
    steps.forEach(([status, station], i) => {
      current = apply(current, evt("feature.status", i + 1, { issue: 1, status })).model;
      assert.equal(featureOf(current, 1).station, station, status);
    });
  });

  test("une feature inconnue est créée, sans titre ni milestone", () => {
    const r = apply(init(stateOf()), evt("feature.status", 1, { issue: 9, status: "ready" }));
    assert.deepEqual(featureOf(r.model, 9), { number: 9, title: null, milestone: null, status: "ready", retry: 0, pr: null, station: "roadmap", escalated: false });
    assert.deepEqual(r.transitions, [{ kind: "feature-add", id: 9, from: null, to: "roadmap" }]);
  });

  test("ignore un statut inconnu", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "n-importe-quoi" }));
    assert.deepEqual(r.model.features, model.features);
    assert.deepEqual(r.transitions, []);
  });

  test("`done` remet le compteur de retry à 0 et met à jour les totaux du milestone", () => {
    const model = init(stateOf({ features: [feature(1, "in-test", { retry: 2 })] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "done" }));
    assert.equal(featureOf(r.model, 1).retry, 0);
    assert.deepEqual(r.transitions, [
      { kind: "feature-move", id: 1, from: "test", to: "merge" },
      { kind: "feature-retry", id: 1, from: 2, to: 0 },
    ]);
    assert.deepEqual(r.model.milestones[0], { number: 1, title: M1, state: "open", total: 1, done: 1 });
  });

  test("une feature d'un milestone fermé reste à la station Release", () => {
    const model = init(stateOf({ milestones: [milestone(1, M1, "closed"), milestone(2, M2)], features: [feature(1, "in-progress")] }));
    assert.equal(featureOf(model, 1).station, "release");
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "in-review" }));
    assert.equal(featureOf(r.model, 1).station, "release");
    assert.deepEqual(r.transitions, [{ kind: "feature-status", id: 1, from: "in-progress", to: "in-review" }]);
  });
});

describe("apply : evt blocked et zone d'escalade", () => {
  test("une feature bloquée passe en zone d'escalade ; sans station connue par les événements, elle est accolée à dev (comme le serveur)", () => {
    const model = init(stateOf({ features: [feature(1, "in-review")] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "blocked" }));
    const f = featureOf(r.model, 1);
    assert.deepEqual([f.status, f.escalated, f.station, placeOf(f)], ["blocked", true, "dev", "escalade"]);
    assert.deepEqual(r.transitions, [{ kind: "feature-move", id: 1, from: "verification", to: "escalade" }]);
  });

  test("la station d'accolement est la dernière station connue par les événements", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const r = run(model, [
      evt("feature.status", 1, { issue: 1, status: "in-progress" }),
      evt("feature.status", 2, { issue: 1, status: "in-review" }),
      evt("feature.status", 3, { issue: 1, status: "blocked" }),
    ]);
    assert.equal(featureOf(r.model, 1).station, "verification");
    assert.equal(r.model.lastStation[1], "verification");
  });

  test("une feature bloquée inconnue est accolée à dev", () => {
    const r = apply(init(stateOf()), evt("feature.status", 1, { issue: 4, status: "blocked" }));
    assert.deepEqual([featureOf(r.model, 4).station, featureOf(r.model, 4).escalated], ["dev", true]);
  });

  test("un deuxième blocked garde la station d'accolement et ne produit pas de transition", () => {
    const r1 = run(init(stateOf({ features: [feature(1, "in-progress")] })), [
      evt("feature.status", 1, { issue: 1, status: "in-test" }),
      evt("feature.status", 2, { issue: 1, status: "blocked" }),
    ]);
    assert.equal(featureOf(r1.model, 1).station, "test");
    const r2 = apply(r1.model, evt("feature.status", 3, { issue: 1, status: "blocked" }));
    assert.equal(featureOf(r2.model, 1).station, "test");
    assert.deepEqual(r2.transitions, []);
  });

  test("le déblocage ramène la feature dans la file de sa station", () => {
    const blocked = apply(init(stateOf({ features: [feature(1, "in-test")] })), evt("feature.status", 1, { issue: 1, status: "blocked" })).model;
    const r = apply(blocked, evt("feature.status", 2, { issue: 1, status: "in-review" }));
    assert.deepEqual([featureOf(r.model, 1).station, featureOf(r.model, 1).escalated], ["verification", false]);
    assert.deepEqual(r.transitions, [{ kind: "feature-move", id: 1, from: "escalade", to: "verification" }]);
  });

  test("blocked l'emporte sur un milestone fermé", () => {
    const model = init(stateOf({ milestones: [milestone(1, M1, "closed"), milestone(2, M2)], features: [feature(1, "in-progress")] }));
    const r = apply(model, evt("feature.status", 1, { issue: 1, status: "blocked" }));
    assert.deepEqual([featureOf(r.model, 1).escalated, featureOf(r.model, 1).station], [true, "dev"]);
    assert.deepEqual(r.transitions, [{ kind: "feature-move", id: 1, from: "release", to: "escalade" }]);
  });
});

describe("apply : evt feature.retry, milestone.changed, release.opened, pr.merged", () => {
  test("feature.retry met à jour le compteur", () => {
    const model = init(stateOf({ features: [feature(1, "changes-requested")] }));
    const r = apply(model, evt("feature.retry", 1, { issue: 1, retry: 2 }));
    assert.equal(featureOf(r.model, 1).retry, 2);
    assert.deepEqual(r.transitions, [{ kind: "feature-retry", id: 1, from: 0, to: 2 }]);
  });

  test("feature.retry d'une feature inconnue est sans effet", () => {
    const model = init(stateOf());
    const r = apply(model, evt("feature.retry", 1, { issue: 5, retry: 1 }));
    assert.deepEqual(r.model.features, []);
    assert.deepEqual(r.transitions, []);
  });

  test("milestone.changed ferme le milestone : toutes ses features vont à Release, et reviennent à sa réouverture", () => {
    const model = init(stateOf({ features: [feature(1, "done"), feature(2, "in-progress"), feature(3, "in-progress", { milestone: M2 })] }));
    const closed = apply(model, evt("milestone.changed", 1, { ref: "1", status: "closed" }));
    assert.deepEqual(closed.model.features.map((f) => f.station), ["release", "release", "dev"]);
    assert.deepEqual(closed.transitions, [
      { kind: "milestone", id: 1, from: "open", to: "closed" },
      { kind: "feature-move", id: 1, from: "merge", to: "release" },
      { kind: "feature-move", id: 2, from: "dev", to: "release" },
    ]);
    const reopened = apply(closed.model, evt("milestone.changed", 2, { ref: "1", status: "open" }));
    assert.deepEqual(reopened.model.features.map((f) => f.station), ["merge", "dev", "dev"]);
    assert.equal(reopened.transitions.length, 3);
  });

  test("milestone.changed ignore un milestone inconnu ou un état invalide", () => {
    const model = init(stateOf({ features: [feature(1, "done")] }));
    assert.equal(apply(model, evt("milestone.changed", 1, { ref: "99", status: "closed" })).transitions.length, 0);
    assert.equal(apply(model, evt("milestone.changed", 1, { ref: "1", status: "weird" })).transitions.length, 0);
    assert.equal(apply(model, evt("milestone.changed", 1, { ref: "1" })).transitions.length, 0);
  });

  test("release.opened : seules les features done du milestone passent à Release", () => {
    const model = init(stateOf({ features: [feature(1, "done"), feature(2, "in-progress")] }));
    const r = apply(model, evt("release.opened", 1, { ref: "release/m1-socle" }));
    assert.deepEqual(r.model.releases, [{ branch: "release/m1-socle", pr: null, state: "open", title: null, milestone: M1 }]);
    assert.deepEqual(r.model.features.map((f) => f.station), ["release", "dev"]);
    assert.deepEqual(r.transitions, [
      { kind: "release", id: "release/m1-socle", from: null, to: "open" },
      { kind: "feature-move", id: 1, from: "merge", to: "release" },
    ]);
    assert.deepEqual(apply(r.model, evt("release.opened", 2, { ref: "release/m1-socle" })).transitions, []);
  });

  test("pr.merged d'une PR de release la marque mergée et ramène les features done à Merge", () => {
    const model = init(
      stateOf({
        features: [feature(1, "done")],
        releases: [{ branch: "release/m1-socle", pr: 40, state: "open", title: "R", milestone: M1 }],
      }),
    );
    assert.equal(featureOf(model, 1).station, "release");
    const r = apply(model, evt("pr.merged", 1, { pr: 40 }));
    assert.deepEqual(r.transitions, [
      { kind: "release", id: "release/m1-socle", from: "open", to: "merged" },
      { kind: "feature-move", id: 1, from: "release", to: "merge" },
    ]);
    assert.deepEqual(apply(model, evt("pr.merged", 1, { pr: 41 })).transitions, []);
  });

  test("pr.opened, issue.created et issue.closed sont reconnus sans effet", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    for (const message of [
      evt("pr.opened", 1, { ref: "feature/1-x", issue: 1 }),
      evt("issue.created", 1, { ref: M1 }),
      evt("issue.closed", 1, { issue: 1 }),
    ]) {
      const r = apply(model, message);
      assert.deepEqual(r.transitions, []);
      assert.deepEqual(r.model.features, model.features);
      assert.deepEqual(r.model.warnings, []);
    }
  });
});

describe("apply : evt agents", () => {
  const requested = (minutes, fields) => evt("agent.requested", minutes, { toolUseId: "tu1", agentType: DEV, mode: "IMPLEMENTATION", issue: 5, attempt: 1, ...fields });

  test("rejoue le cycle de vie complet d'un agent en arrière-plan, avec ses transitions", () => {
    const model = init(stateOf({ features: [feature(5, "in-progress")] }));

    const r1 = apply(model, requested(1));
    assert.deepEqual(r1.transitions, [{ kind: "agent-add", id: "tu1", from: null, to: "dev" }]);
    assert.deepEqual(agentOf(r1.model, "tu1"), {
      id: "tu1", type: "developpeur", mode: "IMPLEMENTATION", issue: 5, pr: null, attempt: 1, station: "dev", phase: "requested",
      since: at(1), updatedAt: at(1), finishedAt: null, verdict: null, block: null, agentId: null, toolUseId: "tu1", sessionId: "session-1", binding: null,
    });

    const r2 = apply(r1.model, evt("agent.launched", 2, { toolUseId: "tu1", agentId: "agent-abc" }));
    assert.deepEqual(r2.transitions, [{ kind: "agent-phase", id: "tu1", from: "requested", to: "running" }]);
    assert.equal(agentOf(r2.model, "tu1").agentId, "abc");

    const r3 = apply(r2.model, evt("agent.started", 3, { agentId: "abc", agentType: DEV }));
    assert.deepEqual(r3.transitions, []);
    assert.equal(agentOf(r3.model, "tu1").updatedAt, at(3));
    assert.equal(r3.model.agents.length, 1);

    const r4 = apply(r3.model, evt("agent.reported", 4, { agentId: "abc", block: "RAPPORT_DEV", verdict: "LIVRÉ" }));
    assert.deepEqual(r4.transitions, [{ kind: "agent-phase", id: "tu1", from: "running", to: "reported" }]);
    assert.deepEqual([agentOf(r4.model, "tu1").verdict, agentOf(r4.model, "tu1").block], ["LIVRÉ", "RAPPORT_DEV"]);

    const r5 = apply(r4.model, evt("agent.finished", 5, { agentId: "abc", source: "stop" }));
    assert.deepEqual(r5.transitions, [{ kind: "agent-phase", id: "tu1", from: "reported", to: "finished" }]);
    assert.deepEqual([agentOf(r5.model, "tu1").phase, agentOf(r5.model, "tu1").finishedAt], ["finished", at(5)]);
  });

  test("agent.finished est idempotent : le premier signal de fin gagne, un verdict manquant est ajouté", () => {
    const model = run(init(stateOf()), [requested(1), evt("agent.launched", 2, { toolUseId: "tu1", agentId: "abc" }), evt("agent.finished", 3, { agentId: "abc", source: "stop" })]).model;
    const r = apply(model, evt("agent.finished", 9, { toolUseId: "tu1", agentId: "abc", source: "tool", verdict: "PASS" }));
    const a = agentOf(r.model, "tu1");
    assert.deepEqual([a.phase, a.finishedAt, a.updatedAt, a.verdict], ["finished", at(3), at(3), "PASS"]);
    assert.deepEqual(r.transitions, []);
  });

  test("agent.started sans requested crée l'agent, qu'un agent.launched relie ensuite par toolUseId", () => {
    const r = run(init(stateOf()), [
      evt("agent.started", 1, { agentId: "agent-xyz", agentType: VERIF }),
      evt("agent.launched", 2, { toolUseId: "tu9", agentId: "xyz" }),
    ]);
    assert.equal(r.model.agents.length, 1);
    assert.deepEqual([r.model.agents[0].id, r.model.agents[0].toolUseId, r.model.agents[0].agentId, r.model.agents[0].type], ["xyz", "tu9", "xyz", "verificateur"]);
  });

  test("fusionne deux entrées quand l'agentId et le toolUseId se rejoignent", () => {
    const r = run(init(stateOf()), [
      requested(1, { toolUseId: "tuA", issue: null }),
      // Type différent : pas de FIFO, l'agent est créé à part.
      evt("agent.started", 2, { agentId: "Y", agentType: VERIF }),
      evt("agent.launched", 3, { toolUseId: "tuA", agentId: "Y" }),
    ]);
    assert.equal(r.model.agents.length, 1);
    const a = r.model.agents[0];
    assert.deepEqual([a.id, a.agentId, a.type, a.phase, a.since], ["tuA", "Y", "developpeur", "running", at(1)]);
  });

  test("relie par FIFO un agent.started sans toolUseId au plus ancien agent demandé de même type", () => {
    const r = run(init(stateOf()), [
      requested(1, { toolUseId: "tu1", issue: 5 }),
      requested(2, { toolUseId: "tu2", issue: 6 }),
      evt("agent.started", 3, { agentId: "X", agentType: DEV }),
    ]);
    assert.deepEqual(r.model.agents.map((a) => [a.id, a.agentId, a.phase]), [["tu1", "X", "running"], ["tu2", null, "requested"]]);
  });

  test("le toolUseId fait foi : un agentId pris par FIFO est rendu à l'agent qui le revendique", () => {
    const r = run(init(stateOf()), [
      requested(1, { toolUseId: "tu1", issue: 5 }),
      requested(2, { toolUseId: "tu2", issue: 6 }),
      evt("agent.started", 3, { agentId: "X", agentType: DEV }),
      evt("agent.launched", 4, { toolUseId: "tu2", agentId: "X" }),
    ]);
    assert.deepEqual(r.model.agents.map((a) => [a.id, a.agentId, a.phase]), [["tu1", null, "requested"], ["tu2", "X", "running"]]);
  });

  test("le FIFO respecte la session", () => {
    const r = run(init(stateOf()), [
      requested(1, { toolUseId: "tu1", sessionId: "s1" }),
      evt("agent.started", 2, { agentId: "X", agentType: DEV, sessionId: "s2" }),
    ]);
    assert.equal(r.model.agents.length, 2);
  });

  test("un seul agent actif développeur/vérificateur/testeur par issue : le plus récent l'emporte", () => {
    const r = run(init(stateOf()), [
      requested(1, { toolUseId: "tu1", issue: 5 }),
      evt("agent.requested", 2, { toolUseId: "tuV", agentType: VERIF, issue: 5 }),
      requested(3, { toolUseId: "tu2", issue: 5 }),
      requested(4, { toolUseId: "tu3", issue: 6 }),
    ]);
    assert.deepEqual(
      r.model.agents.map((a) => [a.id, a.phase]),
      [["tu1", "finished"], ["tuV", "finished"], ["tu2", "requested"], ["tu3", "requested"]],
    );
    // La dernière demande (issue 6) ne touche pas aux agents de l'issue 5.
    assert.deepEqual(r.transitions, [{ kind: "agent-add", id: "tu3", from: null, to: "dev" }]);

    const third = run(init(stateOf()), [requested(1, { toolUseId: "tu1", issue: 5 }), evt("agent.requested", 2, { toolUseId: "tuV", agentType: VERIF, issue: 5 })]);
    assert.deepEqual(third.transitions, [
      { kind: "agent-phase", id: "tu1", from: "requested", to: "finished" },
      { kind: "agent-add", id: "tuV", from: null, to: "verification" },
    ]);
  });

  test("un feature.status qui sort l'issue de la station de l'agent le termine", () => {
    const model = run(init(stateOf({ features: [feature(5, "in-progress")] })), [
      requested(1),
      evt("agent.launched", 2, { toolUseId: "tu1", agentId: "abc" }),
    ]).model;
    const same = apply(model, evt("feature.status", 3, { issue: 5, status: "changes-requested" }));
    assert.equal(agentOf(same.model, "tu1").phase, "running", "toujours en dev");

    const r = apply(model, evt("feature.status", 3, { issue: 5, status: "in-review" }));
    assert.equal(agentOf(r.model, "tu1").phase, "finished");
    assert.equal(agentOf(r.model, "tu1").finishedAt, at(3));
    assert.deepEqual(r.transitions, [
      { kind: "feature-move", id: 5, from: "dev", to: "verification" },
      { kind: "agent-phase", id: "tu1", from: "running", to: "finished" },
    ]);
  });

  test("l'architecte est placé selon son MODE", () => {
    const model = init(stateOf());
    const place = (mode) => apply(model, evt("agent.requested", 1, { toolUseId: "t", agentType: ARCHI, mode })).model.agents[0].station;
    assert.equal(place("CADRAGE_INITIAL"), "cadrage");
    assert.equal(place("CADRAGE_ROADMAP"), "cadrage");
    assert.equal(place("REVUE_ROADMAP"), "roadmap");
    assert.equal(place("ESCALADE"), "escalade");
    assert.equal(place("AUTRE"), null);
  });

  test("le préfixe du plugin est retiré du type, et les agents sont triés par début", () => {
    const r = run(init(stateOf()), [
      evt("agent.requested", 5, { toolUseId: "b", agentType: "testeur" }),
      evt("agent.requested", 2, { toolUseId: "a", agentType: VERIF }),
    ]);
    assert.deepEqual(r.model.agents.map((a) => [a.id, a.type]), [["a", "verificateur"], ["b", "testeur"]]);
  });

  test("un agent.reported tardif (ts <= finishedAt) ne rouvre rien : il complète seulement le verdict manquant", () => {
    const model = run(init(stateOf()), [requested(1), evt("agent.finished", 2, { toolUseId: "tu1", agentId: "abc", source: "tool" })]).model;
    for (const minutes of [2, 1.5]) {
      const r = apply(model, evt("agent.reported", minutes, { agentId: "abc", verdict: "PASS" }));
      const a = agentOf(r.model, "tu1");
      assert.deepEqual([a.phase, a.finishedAt, a.verdict], ["finished", at(2), "PASS"], `reported à ${minutes} min`);
      assert.deepEqual(r.transitions, []);
    }
  });
});

describe("apply : reprise d'un agent (ADR 0008)", () => {
  const DONE = { block: "RAPPORT_DEV", verdict: "LIVRÉ" };
  // Premier cycle complet d'un développeur : LIVRÉ à 3 min, fin à 4 min.
  const firstCycle = () =>
    run(init(stateOf({ features: [feature(5, "in-progress")] })), [
      evt("agent.requested", 1, { toolUseId: "tu1", agentType: DEV, mode: "IMPLEMENTATION", issue: 5, attempt: 1 }),
      evt("agent.launched", 2, { toolUseId: "tu1", agentId: "abc" }),
      evt("agent.reported", 3, { agentId: "abc", ...DONE }),
      evt("agent.finished", 4, { agentId: "abc", source: "stop" }),
    ]).model;

  test("un started postérieur à la fin rouvre le cycle : finishedAt et verdict repartent de null, id et since restent", () => {
    const finished = firstCycle();
    assert.deepEqual([agentOf(finished, "tu1").phase, agentOf(finished, "tu1").verdict, agentOf(finished, "tu1").finishedAt], ["finished", "LIVRÉ", at(4)]);

    const r = apply(finished, evt("agent.started", 5, { agentId: "abc", agentType: DEV }));
    const a = agentOf(r.model, "tu1");
    assert.deepEqual(
      [a.id, a.since, a.phase, a.finishedAt, a.verdict, a.block, a.updatedAt, a.agentId],
      ["tu1", at(1), "running", null, null, null, at(5), "abc"],
    );
    assert.equal(r.model.agents.length, 1);
    assert.deepEqual(r.transitions, [{ kind: "agent-phase", id: "tu1", from: "finished", to: "running" }]);
  });

  test("un launched postérieur à la fin rouvre aussi le cycle", () => {
    const r = apply(firstCycle(), evt("agent.launched", 5, { toolUseId: "tu1", agentId: "abc" }));
    assert.deepEqual([agentOf(r.model, "tu1").phase, agentOf(r.model, "tu1").finishedAt, agentOf(r.model, "tu1").verdict], ["running", null, null]);
  });

  test("un reported postérieur à la fin rouvre le cycle directement en `reported`, avec son verdict", () => {
    const r = apply(firstCycle(), evt("agent.reported", 5, { agentId: "abc", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }));
    const a = agentOf(r.model, "tu1");
    assert.deepEqual([a.phase, a.finishedAt, a.verdict, a.block], ["reported", null, "BLOQUÉ", "RAPPORT_DEV"]);
    assert.deepEqual(r.transitions, [{ kind: "agent-phase", id: "tu1", from: "finished", to: "reported" }]);
  });

  test("scénario de la sonde : LIVRÉ, puis reprise, puis BLOQUÉ", () => {
    const r = run(firstCycle(), [
      evt("agent.started", 5, { agentId: "abc", agentType: DEV }),
      evt("agent.reported", 6, { agentId: "abc", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
      evt("agent.finished", 7, { agentId: "abc", source: "stop" }),
    ]);
    const a = agentOf(r.model, "tu1");
    assert.deepEqual([a.phase, a.verdict, a.block, a.finishedAt, a.updatedAt, a.since], ["finished", "BLOQUÉ", "RAPPORT_DEV", at(7), at(7), at(1)]);
    assert.deepEqual(r.all.filter((t) => t.kind === "agent-phase").map((t) => `${t.from}>${t.to}`), ["finished>running", "running>reported", "reported>finished"]);
  });

  test("clôture : un finished clôt le cycle rouvert ; un finished en double ne fait que compléter block et verdict", () => {
    const reopened = apply(firstCycle(), evt("agent.started", 5, { agentId: "abc", agentType: DEV })).model;
    const closed = apply(reopened, evt("agent.finished", 6, { agentId: "abc", source: "stop" })).model;
    assert.deepEqual([agentOf(closed, "tu1").phase, agentOf(closed, "tu1").finishedAt, agentOf(closed, "tu1").verdict], ["finished", at(6), null]);

    const dup = apply(closed, evt("agent.finished", 9, { agentId: "abc", source: "tool", verdict: "PASS", block: "RAPPORT_VERIF" }));
    const a = agentOf(dup.model, "tu1");
    assert.deepEqual([a.phase, a.finishedAt, a.updatedAt, a.verdict, a.block], ["finished", at(6), at(6), "PASS", "RAPPORT_VERIF"]);
    assert.deepEqual(dup.transitions, []);

    // Un finished en double ne remplace pas un verdict déjà présent.
    const again = apply(dup.model, evt("agent.finished", 10, { agentId: "abc", source: "tool", verdict: "FAIL" }));
    assert.equal(agentOf(again.model, "tu1").verdict, "PASS");
  });

  test("un signal de ts égal ou antérieur à la fin ne rouvre rien", () => {
    const finished = firstCycle();
    for (const minutes of [4, 3.5]) {
      const r = apply(finished, evt("agent.started", minutes, { agentId: "abc", agentType: DEV }));
      assert.deepEqual([agentOf(r.model, "tu1").phase, agentOf(r.model, "tu1").finishedAt], ["finished", at(4)], `started à ${minutes} min`);
    }
  });

  test("le mode et la station d'un architecte se déduisent du block de son rapport", () => {
    const base = run(init(stateOf()), [
      evt("agent.requested", 1, { toolUseId: "ta", agentType: ARCHI, mode: "CADRAGE_QUESTIONS" }),
      evt("agent.started", 1.1, { agentId: "arch", agentType: ARCHI }),
      evt("agent.reported", 2, { agentId: "arch", agentType: ARCHI, block: "QUESTIONS" }),
      evt("agent.finished", 3, { agentId: "arch", source: "stop" }),
    ]).model;
    assert.deepEqual([agentOf(base, "ta").mode, agentOf(base, "ta").station], ["CADRAGE_QUESTIONS", "cadrage"]);

    const blocks = [["PROPOSITION", "CADRAGE_PROPOSITION", "cadrage"], ["PITCH", "CADRAGE_FINALISATION", "cadrage"], ["VERDICT_ROADMAP", "REVUE_ROADMAP", "roadmap"], ["ESCALADE", "ESCALADE", "escalade"]];
    for (const [block, mode, station] of blocks) {
      const r = apply(base, evt("agent.reported", 5, { agentId: "arch", agentType: ARCHI, block }));
      const a = agentOf(r.model, "ta");
      assert.deepEqual([a.phase, a.mode, a.station, a.block], ["reported", mode, station, block], block);
    }
    // Un bloc RAPPORT_* ne change ni le mode ni la station des autres agents.
    const dev = firstCycle();
    assert.deepEqual([agentOf(dev, "tu1").mode, agentOf(dev, "tu1").station], ["IMPLEMENTATION", "dev"]);
  });

  test("un lot d'événements est appliqué trié par ts, quel que soit l'ordre de réception", () => {
    const batch = [
      ev("agent.finished", 7, { agentId: "abc", source: "stop" }),
      ev("agent.reported", 3, { agentId: "abc", ...DONE }),
      ev("agent.launched", 2, { toolUseId: "tu1", agentId: "abc" }),
      ev("agent.finished", 4, { agentId: "abc", source: "stop" }),
      ev("agent.started", 5, { agentId: "abc", agentType: DEV }),
      ev("agent.requested", 1, { toolUseId: "tu1", agentType: DEV, mode: "IMPLEMENTATION", issue: 5, attempt: 1 }),
      ev("agent.reported", 6, { agentId: "abc", block: "RAPPORT_DEV", verdict: "BLOQUÉ" }),
    ];
    const start = init(stateOf({ features: [feature(5, "in-progress")] }));
    const shuffled = apply(start, sse("evt", batch)).model;
    const ordered = apply(start, sse("evt", [...batch].sort((x, y) => x.ts.localeCompare(y.ts)))).model;
    assert.deepEqual(shuffled, ordered);
    const a = agentOf(shuffled, "tu1");
    assert.deepEqual([a.phase, a.verdict, a.finishedAt, a.since], ["finished", "BLOQUÉ", at(7), at(1)]);
    assert.equal(shuffled.updatedAt, at(7));
  });

  test("à ts égal, l'ordre reçu est conservé, et les événements invalides d'un lot sont signalés sans bloquer les autres", () => {
    const r = apply(init(stateOf()), sse("evt", [ev("agent.started", 1, { agentId: "x", agentType: DEV }), ev("agent.finished", 1, { agentId: "x", source: "stop" }), { v: 1, type: "agent.finished" }]));
    assert.equal(agentOf(r.model, "x").phase, "finished");
    assert.deepEqual(r.model.warnings.map((w) => w.code), ["EVENT_INCOMPLETE"]);
    assert.equal(apply(init(stateOf()), sse("evt", [])).model.agents.length, 0);
  });
});

describe("tick(model, now) : horloge des agents", () => {
  const base = () => run(init(stateOf()), [evt("agent.requested", 0, { toolUseId: "tu1", agentType: DEV, issue: 5 }), evt("agent.launched", 0, { toolUseId: "tu1", agentId: "abc" })]).model;

  test("passe en `unknown` un agent silencieux depuis 45 min, sans le terminer", () => {
    const model = base();
    const early = tick(model, T(AGENT_UNKNOWN_AFTER_MS - 1));
    assert.equal(early.model, model);
    assert.deepEqual(early.transitions, []);

    const late = tick(model, T(AGENT_UNKNOWN_AFTER_MS));
    assert.equal(agentOf(late.model, "tu1").phase, "unknown");
    assert.equal(agentOf(late.model, "tu1").finishedAt, null);
    assert.deepEqual(late.transitions, [{ kind: "agent-phase", id: "tu1", from: "running", to: "unknown" }]);
  });

  test("un nouveau signal ranime un agent `unknown`", () => {
    const unknown = tick(base(), T(AGENT_UNKNOWN_AFTER_MS)).model;
    const r = apply(unknown, evt("agent.started", 50, { agentId: "abc", agentType: DEV }));
    assert.equal(agentOf(r.model, "tu1").phase, "running");
    assert.deepEqual(r.transitions, [{ kind: "agent-phase", id: "tu1", from: "unknown", to: "running" }]);
  });

  test("retire un agent terminé depuis 10 min", () => {
    const model = apply(base(), evt("agent.finished", 5, { agentId: "abc", source: "stop" })).model;
    const finishedAt = Date.parse(at(5));
    assert.equal(tick(model, finishedAt + AGENT_FINISHED_TTL_MS - 1).model, model);
    const r = tick(model, finishedAt + AGENT_FINISHED_TTL_MS);
    assert.deepEqual(r.model.agents, []);
    assert.deepEqual(r.transitions, [{ kind: "agent-remove", id: "tu1", from: "dev", to: null }]);
  });

  test("un agent réactivé n'est pas retiré, et l'horloge repart de son dernier cycle (ADR 0008)", () => {
    // Fin à 5 min, reprise à 8 min, nouvelle fin à 20 min.
    const model = run(base(), [
      evt("agent.finished", 5, { agentId: "abc", source: "stop" }),
      evt("agent.started", 8, { agentId: "abc", agentType: DEV }),
    ]).model;
    const firstFinish = Date.parse(at(5));

    // Plus de 10 min après la première fin : l'agent travaille, il reste.
    const stillThere = tick(model, firstFinish + AGENT_FINISHED_TTL_MS + 60 * 1000);
    assert.equal(stillThere.model, model);
    assert.equal(agentOf(stillThere.model, "tu1").phase, "running");

    // Silencieux depuis 45 min après son dernier signal (8 min) : `unknown`, pas retiré.
    const unknown = tick(model, Date.parse(at(8)) + AGENT_UNKNOWN_AFTER_MS);
    assert.equal(agentOf(unknown.model, "tu1").phase, "unknown");
    assert.deepEqual(unknown.transitions, [{ kind: "agent-phase", id: "tu1", from: "running", to: "unknown" }]);

    // Une fois le dernier cycle clos, la purge compte 10 min depuis la dernière fin.
    const closed = apply(model, evt("agent.finished", 20, { agentId: "abc", source: "stop" })).model;
    const lastFinish = Date.parse(at(20));
    assert.equal(tick(closed, lastFinish + AGENT_FINISHED_TTL_MS - 1).model, closed);
    assert.deepEqual(tick(closed, lastFinish + AGENT_FINISHED_TTL_MS).model.agents, []);
  });

  test("accepte une Date ou une chaîne ISO, et ignore une horloge invalide", () => {
    const model = base();
    assert.equal(tick(model, new Date(T(AGENT_UNKNOWN_AFTER_MS))).transitions.length, 1);
    assert.equal(tick(model, at(60)).transitions.length, 1);
    for (const bad of [undefined, null, "n'importe quoi", NaN]) assert.equal(tick(model, bad).model, model);
  });

  function T(ms) {
    return Date.parse(at(0)) + ms;
  }
});

describe("robustesse", () => {
  test("ignore les types inconnus et les versions futures en silence", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    for (const data of [ev("feature.inconnu", 1, { issue: 1 }), { ...ev("feature.status", 1, { issue: 1, status: "done" }), v: 2 }]) {
      const r = apply(model, sse("evt", data));
      assert.equal(r.model, model);
      assert.deepEqual(r.transitions, []);
    }
  });

  test("un événement incomplet est signalé une seule fois par EVENT_INCOMPLETE et n'a aucun autre effet", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const bad = evt("feature.status", 1, { status: "done" });
    const r1 = apply(model, bad);
    const r2 = apply(r1.model, bad);
    assert.deepEqual(r2.model.features, model.features);
    assert.equal(r2.model.warnings.length, 1);
    assert.equal(r2.model.warnings[0].code, "EVENT_INCOMPLETE");
    assert.match(r2.model.warnings[0].message, /feature\.status.*issue/);
    assert.deepEqual(r1.transitions, []);

    const noSource = apply(model, evt("agent.finished", 1, { agentId: "a" }));
    assert.match(noSource.model.warnings[0].message, /source/);
    const noTs = apply(model, sse("evt", { v: 1, type: "feature.status", issue: 1, status: "done" }));
    assert.match(noTs.model.warnings[0].message, /\(ts\)/);
  });

  describe("format SSE strict", () => {
    const data = ev("feature.status", 1, { issue: 1, status: "in-progress" });
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const errorsOf = (r) => r.model.warnings.map((w) => w.code);

    test("accepte { event, data: chaîne JSON } pour evt, snapshot et warning", () => {
      assert.equal(featureOf(apply(model, { event: "evt", data: JSON.stringify(data) }).model, 1).station, "dev");
      assert.equal(apply(model, { event: "snapshot", data: JSON.stringify(stateOf()) }).model.features.length, 0);
      assert.equal(apply(model, { event: "warning", data: JSON.stringify({ code: "GH_AUTH", message: "m", at: at(1) }) }).model.warnings.length, 1);
    });

    test("l'alias `type` à la place de `event` est supprimé : message rejeté par EVENT_ERROR, sans effet sur les features", () => {
      const r = apply(model, { type: "evt", data: JSON.stringify(data) });
      assert.deepEqual(errorsOf(r), ["EVENT_ERROR"]);
      assert.match(r.model.warnings[0].message, /`event`/);
      assert.equal(featureOf(r.model, 1).station, "roadmap");
      assert.deepEqual(r.transitions, []);
      // Même avec les deux champs, seul `event` compte.
      assert.equal(featureOf(apply(model, { event: "snapshot", type: "evt", data: JSON.stringify(stateOf()) }).model, 1), undefined);
    });

    test("une data qui n'est pas une chaîne (objet déjà parsé, nombre, null, absente) est rejetée par EVENT_ERROR", () => {
      for (const name of ["evt", "snapshot", "warning"]) {
        for (const bad of [data, 7, null, undefined, true, ["x"]]) {
          const r = apply(model, { event: name, data: bad });
          assert.deepEqual(errorsOf(r), ["EVENT_ERROR"], `${name} / ${JSON.stringify(bad)}`);
          assert.match(r.model.warnings[0].message, /chaîne JSON/);
          assert.deepEqual(r.model.features, model.features);
          assert.deepEqual(r.transitions, []);
        }
      }
    });

    test("un JSON invalide est ignoré avec EVENT_ERROR, sans exception ni effet", () => {
      for (const name of ["evt", "snapshot", "warning"]) {
        for (const bad of ["pas du json", "{", "", "{'a':1}", "undefined"]) {
          let r;
          assert.doesNotThrow(() => (r = apply(model, { event: name, data: bad })));
          assert.deepEqual(errorsOf(r), ["EVENT_ERROR"], `${name} / ${bad}`);
          assert.match(r.model.warnings[0].message, /JSON valide/);
          assert.deepEqual(r.model.features, model.features);
        }
      }
    });

    test("un JSON valide d'une forme inattendue est rejeté par EVENT_ERROR", () => {
      for (const json of ["7", "null", '"texte"', "true"]) {
        assert.deepEqual(errorsOf(apply(model, { event: "evt", data: json })), ["EVENT_ERROR"], `evt ${json}`);
        assert.deepEqual(errorsOf(apply(model, { event: "snapshot", data: json })), ["EVENT_ERROR"], `snapshot ${json}`);
      }
      assert.deepEqual(errorsOf(apply(model, { event: "snapshot", data: "[]" })), ["EVENT_ERROR"]);
    });

    test("un message qui n'est pas un objet est rejeté par EVENT_ERROR ; un nom d'événement SSE inconnu est ignoré en silence", () => {
      for (const message of [undefined, null, 42, "x", [], {}, { data: "{}" }, { event: 3, data: "{}" }]) {
        const r = apply(model, message);
        assert.deepEqual(errorsOf(r), ["EVENT_ERROR"], JSON.stringify(message));
        assert.deepEqual(r.transitions, []);
      }
      for (const event of ["ping", "open", "EVT", "message", ""]) {
        const r = apply(model, { event, data: JSON.stringify(data) });
        assert.equal(r.model, model, event);
        assert.deepEqual(r.transitions, []);
      }
    });

    test("le message d'erreur ne recopie pas le contenu brut du message", () => {
      const r = apply(model, { event: "evt", data: "secret-token-xyz" });
      assert.doesNotMatch(r.model.warnings[0].message, /secret-token-xyz/);
    });

    test("la convention de l'en-tête est documentée : evt|snapshot|warning et apply(model, {event: e.type, data: e.data})", async () => {
      const { readFile } = await import("node:fs/promises");
      const source = await readFile(new URL("../../viz/public/js/state.js", import.meta.url), "utf8");
      assert.match(source, /`evt`, `snapshot` ou `warning`/);
      assert.match(source, /apply\(model, \{ event: e\.type, data: e\.data \}\)/);
    });
  });

  test("n'a aucun effet de bord sur un modèle gelé, ni sur le message", () => {
    const model = deepFreeze(init(stateOf({ features: [feature(1, "in-progress")] })));
    const messages = [
      evt("feature.status", 1, { issue: 1, status: "blocked" }),
      evt("agent.requested", 2, { toolUseId: "t", agentType: DEV, issue: 1 }),
      evt("milestone.changed", 3, { ref: "1", status: "closed" }),
      snapshotMsg(stateOf()),
      warningMsg({ code: "GH_AUTH", message: "m" }),
    ].map(deepFreeze);
    for (const message of messages) assert.doesNotThrow(() => apply(model, message));
    assert.doesNotThrow(() => tick(model, Date.now()));
  });

  test("est déterministe : les mêmes messages donnent le même modèle", () => {
    const messages = [
      evt("feature.status", 1, { issue: 1, status: "in-review" }),
      evt("agent.requested", 2, { toolUseId: "t", agentType: VERIF, issue: 1 }),
      evt("feature.status", 3, { issue: 1, status: "blocked" }),
    ];
    const start = stateOf({ features: [feature(1, "in-progress")] });
    assert.deepEqual(run(init(start), messages).model, run(init(start), messages).model);
  });

  test("diff d'un modèle avec lui-même est vide", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    assert.deepEqual(diff(model, model), []);
  });
});
