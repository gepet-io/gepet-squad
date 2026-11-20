"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  parseMissionHeader,
  missionTextFromLine,
  roleOf,
  attributeAgent,
  attributeCp,
} = require("../../conso/lib/attribution.cjs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "transcripts");
const SUB = path.join(FIXTURES, "sess-cp-0001", "subagents");

const events = fs
  .readFileSync(path.join(FIXTURES, "events.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

function agentInput(id) {
  const meta = JSON.parse(fs.readFileSync(path.join(SUB, `agent-${id}.meta.json`), "utf8"));
  const first = fs.readFileSync(path.join(SUB, `agent-${id}.jsonl`), "utf8").split("\n")[0];
  return { agentId: id, meta, missionText: missionTextFromLine(first), events };
}

test("attribution par toolUseId : rôle, mode, issue du journal", () => {
  const a = attributeAgent(agentInput("a1"));
  assert.deepEqual(a, {
    role: "developpeur",
    mode: "IMPLEMENTATION",
    issue: 11,
    pr: null,
    attempt: null,
    toolUseId: "toolu_01",
    source: "toolUseId",
    bucket: "feature",
  });
});

test("repli par agentId puis par en-tête de mission", () => {
  const meta = { agentType: "claude-gepet-squad:verificateur", toolUseId: "toolu_inconnu" };
  const byAgentId = attributeAgent({
    agentId: "a9",
    meta,
    missionText: "ISSUE: 5\nPR: #7\nTENTATIVE: 2",
    events: [{ type: "agent.started", agentId: "a9", agentType: "gepet-squad:verificateur", mode: "VERIF" }],
  });
  assert.equal(byAgentId.source, "agentId");
  assert.equal(byAgentId.role, "verificateur");
  assert.equal(byAgentId.mode, "VERIF");
  assert.deepEqual([byAgentId.issue, byAgentId.pr, byAgentId.attempt], [5, 7, 2]);

  const byHeader = attributeAgent({ agentId: "zz", meta, missionText: "MODE: CORRECTIF\nISSUE: #8\nPR: 9\nTENTATIVE: 3", events });
  assert.equal(byHeader.source, "mission");
  assert.deepEqual([byHeader.mode, byHeader.issue, byHeader.pr, byHeader.attempt], ["CORRECTIF", 8, 9, 3]);
  assert.equal(byHeader.bucket, "feature");
});

test("agent hors squad exclu ; sans issue : horsFeature ; sans rien : nonAttribue ; tentative inconnue null", () => {
  assert.equal(attributeAgent({ meta: { agentType: "autre-plugin:agent" }, missionText: "ISSUE: 1" }), null);
  assert.equal(attributeAgent({ meta: {}, missionText: "ISSUE: 1" }), null);

  const hors = attributeAgent({ meta: { agentType: "gepet-squad:architecte" }, missionText: "MODE: CADRAGE" });
  assert.equal(hors.bucket, "horsFeature");
  assert.equal(hors.issue, null);
  assert.equal(hors.attempt, null);

  const none = attributeAgent({ meta: { agentType: "gepet-squad:testeur" }, missionText: "texte libre", events: [] });
  assert.equal(none.bucket, "nonAttribue");
  assert.equal(none.role, "testeur");
});

test("agent économe local : ISSUE F-07 complétée depuis l'en-tête malgré le journal sans issue", () => {
  assert.equal(parseMissionHeader("MODE: IMPLEMENTATION\nISSUE: F-07").issue, "F-07");
  const a = attributeAgent(agentInput("a3"));
  assert.equal(a.source, "toolUseId");
  assert.equal(a.issue, "F-07");
  assert.equal(a.mode, "IMPLEMENTATION");
  assert.equal(a.attempt, 2);
  assert.equal(a.bucket, "feature");
});

test("en-tête : première occurrence, arrêt aux notes libres", () => {
  const h = parseMissionHeader("ISSUE: 3\nNotes :\nISSUE: 99\nPR: 12");
  assert.equal(h.issue, 3);
  assert.equal(h.pr, undefined);
});

test("roleOf retire les deux préfixes", () => {
  assert.equal(roleOf("gepet-squad:testeur"), "testeur");
  assert.equal(roleOf("claude-gepet-squad:architecte"), "architecte");
  assert.equal(roleOf("general-purpose"), null);
  assert.equal(roleOf("gepet-squad:developpeur-outille"), "developpeur");
});

const u = (n) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0 });
const entry = (ts, n) => ({ ts, usage: u(n) });

test("CP : rattaché au milestone de la dernière feature demandée, sinon Cadrage", () => {
  const agents = [attributeAgent(agentInput("a1")), attributeAgent(agentInput("a2")), attributeAgent(agentInput("a3"))];
  const entries = [
    entry("2026-01-01T10:00:01.000Z", 1), // avant tout agent.requested
    entry("2026-01-01T10:01:30.000Z", 2), // feature 11
    entry("2026-01-01T10:02:30.000Z", 4), // feature 12
    entry("2026-01-01T10:03:30.000Z", 8), // F-07, issue connue seulement via l'agent
  ];
  const r = attributeCp(entries, {
    events,
    agents,
    milestones: { 11: "M1", 12: "M2", "F-07": "M3" },
  });
  assert.equal(r.total.total, 15);
  assert.deepEqual(Object.fromEntries(Object.entries(r.byMilestone).map(([k, v]) => [k, v.total])), {
    Cadrage: 1,
    M1: 2,
    M2: 4,
    M3: 8,
  });
});

test("CP sans table de milestones : un total seulement", () => {
  const r = attributeCp([entry("2026-01-01T10:00:01.000Z", 3)], { events });
  assert.equal(r.total.total, 3);
  assert.equal(r.byMilestone, null);
});
