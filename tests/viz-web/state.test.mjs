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

  test("ignore un snapshot sans objet et renvoie le même modèle", () => {
    const model = init(stateOf());
    for (const data of [null, 3, "pas du json", [1]]) {
      const r = apply(model, snapshotMsg(data));
      assert.equal(r.model, model);
      assert.deepEqual(r.transitions, []);
    }
  });
});

describe("apply : warning", () => {
  test("ajoute un avertissement, une liste ou { warnings }, sans transition", () => {
    const model = init(stateOf());
    const one = apply(model, warningMsg({ code: "GH_TIMEOUT", message: "gh trop lent", at: at(1) }));
    assert.deepEqual(one.model.warnings, [{ code: "GH_TIMEOUT", message: "gh trop lent", at: at(1) }]);
    assert.deepEqual(one.transitions, []);

    const many = apply(one.model, warningMsg([{ code: "GH_AUTH", message: "a" }, { code: "GH_PARSE", message: "b" }]));
    assert.deepEqual(many.model.warnings.map((w) => w.code), ["GH_TIMEOUT", "GH_AUTH", "GH_PARSE"]);

    const wrapped = apply(many.model, warningMsg({ warnings: [{ code: "GH_MISSING", message: "c" }] }));
    assert.equal(wrapped.model.warnings.at(-1).code, "GH_MISSING");
    assert.equal(model.warnings.length, 0, "le modèle d'origine n'est pas modifié");
  });

  test("ne duplique pas un avertissement identique et borne la liste", () => {
    let model = init(stateOf());
    for (let i = 0; i < 3; i++) model = apply(model, warningMsg({ code: "GH_AUTH", message: "même" })).model;
    assert.equal(model.warnings.length, 1);
    for (let i = 0; i < 80; i++) model = apply(model, warningMsg({ code: "GH_PARSE", message: `m${i}` })).model;
    assert.equal(model.warnings.length, 50);
    assert.equal(model.warnings.at(-1).message, "m79");
  });

  test("un snapshot efface les avertissements (gh a récupéré)", () => {
    const model = apply(init(stateOf()), warningMsg({ code: "GH_AUTH", message: "x" })).model;
    assert.equal(apply(model, snapshotMsg(stateOf())).model.warnings.length, 0);
  });

  test("ignore un avertissement sans code ni message", () => {
    const model = init(stateOf());
    for (const data of [{}, { code: "X" }, 4, null, []]) {
      const r = apply(model, warningMsg(data));
      assert.equal(r.model, model);
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

  test("agent.reported ne fait pas reculer un agent déjà terminé", () => {
    const model = run(init(stateOf()), [requested(1), evt("agent.finished", 2, { toolUseId: "tu1", agentId: "abc", source: "tool" })]).model;
    const r = apply(model, evt("agent.reported", 3, { agentId: "abc", verdict: "PASS" }));
    assert.equal(agentOf(r.model, "tu1").phase, "finished");
    assert.equal(agentOf(r.model, "tu1").verdict, "PASS");
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
      const r = apply(model, { event: "evt", data });
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
    const noTs = apply(model, { event: "evt", data: { v: 1, type: "feature.status", issue: 1, status: "done" } });
    assert.match(noTs.model.warnings[0].message, /\(ts\)/);
  });

  test("accepte `type` à la place de `event`, et des données en JSON brut", () => {
    const model = init(stateOf({ features: [feature(1, "ready")] }));
    const data = ev("feature.status", 1, { issue: 1, status: "in-progress" });
    assert.equal(featureOf(apply(model, { type: "evt", data }).model, 1).station, "dev");
    assert.equal(featureOf(apply(model, { event: "evt", data: JSON.stringify(data) }).model, 1).station, "dev");
    assert.equal(apply(model, { event: "snapshot", data: JSON.stringify(stateOf()) }).model.features.length, 0);
  });

  test("ignore sans exception tout message mal formé", () => {
    const model = init(stateOf());
    const garbage = [undefined, null, 42, "x", [], {}, { event: "evt" }, { event: "evt", data: "pas du json" }, { event: "evt", data: 7 }, { event: "autre", data: {} }, { event: 3, data: {} }];
    for (const message of garbage) {
      const r = apply(model, message);
      assert.ok(Array.isArray(r.transitions), String(message));
      assert.deepEqual(r.transitions, []);
    }
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
