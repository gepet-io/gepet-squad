"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregate } = require("../../conso/lib/aggregate.cjs");

const u = (input, output, cacheRead, cacheWrite, messages = 1) => ({ input, output, cacheRead, cacheWrite, messages });
const sum4 = (x) => x.input + x.output + x.cacheRead + x.cacheWrite;

const agent = (agentId, role, issue, attempt, usage, extra = {}) => ({
  agentId, role, mode: "IMPLEMENTATION", issue, pr: null, attempt, model: "claude-sonnet", debut: `2026-01-01T10:0${agentId}:00Z`, fin: null, usage, bucket: "feature", ...extra,
});

function input(extra = {}) {
  return {
    generatedAt: "2026-01-02T00:00:00.000Z",
    project: "demo",
    agents: [
      agent("1", "developpeur", 10, 1, u(10, 5, 100, 20, 2)),
      agent("2", "developpeur", "10", 2, u(1, 1, 1, 1)),
      agent("3", "verificateur", 11, 1, u(200, 50, 0, 0)),
      agent("4", "developpeur", "F-07", 1, u(7, 0, 0, 0)),
      agent("5", "architecte", null, null, u(3, 0, 0, 0), { bucket: "horsFeature" }),
      agent("6", "testeur", null, null, u(2, 2, 2, 2), { bucket: "nonAttribue" }),
    ],
    cp: {
      sessions: 2,
      total: u(1100, 110, 5000, 500, 9),
      byMilestone: { Cadrage: u(100, 10, 0, 0, 2), "M1": u(1000, 100, 5000, 500, 7) },
    },
    nonAttribue: { usage: u(1, 1, 1, 1), fichiers: 1 },
    milestones: [{ titre: "M1", issues: [10, 11] }, { titre: "M2", issues: ["F-07"] }],
    warnings: [{ code: "LIGNES_ILLISIBLES", message: "3 lignes ignorées" }],
    ...extra,
  };
}

test("total = somme exacte des quatre compteurs, à chaque niveau", () => {
  const r = aggregate(input());
  for (const x of [r.totals, r.cp.usage, ...r.milestones.map((m) => m.usage), ...r.features.map((f) => f.usage), ...r.agents.map((a) => a.usage)]) {
    assert.equal(x.total, sum4(x));
  }
  const f10 = r.features.find((f) => f.issue === 10);
  assert.deepEqual(f10.usage, { input: 11, output: 6, cacheRead: 101, cacheWrite: 21, total: 139, messages: 3 });
  assert.equal(f10.agents, 2);
});

test("total général = agents + hors feature + CP + non attribué", () => {
  const r = aggregate(input());
  const parts = r.agents.reduce((s, a) => s + a.usage.total, 0) + r.horsFeature.usage.total + r.cp.usage.total + r.nonAttribue.usage.total;
  assert.equal(r.totals.total, parts);
  assert.equal(r.nonAttribue.fichiers, 2);
  assert.equal(r.nonAttribue.usage.total, 4 + 8);
  assert.equal(r.horsFeature.agents, 1);
  assert.equal(r.agents.length, 4);
});

test("milestone = agents de ses features + part du CP ; features[].milestone", () => {
  const r = aggregate(input());
  const m1 = r.milestones.find((m) => m.titre === "M1");
  assert.equal(m1.usage.total, 139 + 250 + 6600);
  assert.equal(r.features.find((f) => f.issue === 11).milestone, "M1");
  assert.equal(r.milestones.find((m) => m.titre === "M2").usage.total, 7);
  assert.deepEqual(r.cp.parMilestone.map((p) => p.milestone), ["Cadrage", "M1"]);
});

test("identifiants gardés : entier ou F-<n>, tri entiers puis F", () => {
  const r = aggregate(input());
  assert.deepEqual(r.features.map((f) => f.issue), [10, 11, "F-07"]);
  assert.deepEqual(r.milestones[1].issues, ["F-07"]);
});

test("sans table de milestones : milestone null, CP en total seul", () => {
  const r = aggregate(input({ milestones: null, cp: { sessions: 1, total: u(5, 5, 5, 5), byMilestone: null } }));
  assert.ok(r.features.every((f) => f.milestone === null));
  assert.deepEqual(r.milestones, []);
  assert.deepEqual(r.cp.parMilestone, []);
  assert.equal(r.cp.usage.total, 20);
});

test("focus : sortie limitée au milestone, totals = son total, part du CP inchangée", () => {
  const all = aggregate(input());
  const r = aggregate(input({ focus: "M1" }));
  assert.deepEqual(r.milestones.map((m) => m.titre), ["M1"]);
  assert.deepEqual(r.features.map((f) => f.issue), [10, 11]);
  assert.deepEqual(r.agents.map((a) => a.agentId), ["1", "2", "3"]);
  assert.deepEqual(r.cp.parMilestone, all.cp.parMilestone.filter((p) => p.milestone === "M1"));
  assert.deepEqual(r.totals, all.milestones[0].usage);
  assert.throws(() => aggregate(input({ focus: "M9" })), { code: "FOCUS_INCONNU" });
});

test("warnings repris, cas vide sans exception", () => {
  assert.deepEqual(aggregate(input()).warnings, [{ code: "LIGNES_ILLISIBLES", message: "3 lignes ignorées" }]);
  const r = aggregate({ generatedAt: "2026-01-02T00:00:00.000Z" });
  assert.equal(r.v, 1);
  assert.equal(r.totals.total, 0);
  assert.deepEqual([r.agents, r.features, r.milestones, r.warnings], [[], [], [], []]);
  assert.deepEqual(r.nonAttribue, { usage: aggregate().totals, fichiers: 0 });
});
