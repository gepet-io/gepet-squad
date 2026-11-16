"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { aggregate } = require("../../conso/lib/aggregate.cjs");
const { formatInt, formatText, formatJson } = require("../../conso/lib/format.cjs");

const u = (input, output, cacheRead, cacheWrite, messages = 1) => ({ input, output, cacheRead, cacheWrite, messages });

function report(extra = {}) {
  return aggregate({
    generatedAt: "2026-01-02T00:00:00.000Z",
    agents: [
      { agentId: "1", role: "developpeur", issue: 10, attempt: 2, usage: u(1234567, 5, 100, 20), debut: "a" },
      { agentId: "2", role: "developpeur", issue: "F-07", attempt: null, usage: u(7, 0, 0, 0), debut: "b" },
    ],
    cp: { sessions: 1, total: u(1000, 0, 0, 0), byMilestone: { M1: u(1000, 0, 0, 0) } },
    milestones: [{ titre: "M1", issues: [10] }, { titre: "M2", issues: ["F-07"] }],
    warnings: [{ code: "FORMAT_ANCIEN", message: "lignes isSidechain" }],
    ...extra,
  });
}

test("entiers groupés par une espace", () => {
  assert.equal(formatInt(1234567), "1 234 567");
  assert.equal(formatInt(999), "999");
  assert.equal(formatInt(1000), "1 000");
  assert.equal(formatInt(0), "0");
});

test("texte : trois tableaux, colonnes de l'ADR 0012, identifiants et avertissements", () => {
  const text = formatText(report());
  const heads = text.split("\n").filter((l) => l.includes(" | ") && l.includes("Entrée"));
  assert.equal(heads.length, 3);
  const cols = (l) => l.split("|").map((c) => c.trim());
  assert.deepEqual(cols(heads[0]), ["Milestone", "Agents", "CP", "Entrée", "Sortie", "Cache lu", "Cache écrit", "Total"]);
  assert.deepEqual(cols(heads[1]), ["#", "Agents", "Tentatives", "Entrée", "Sortie", "Cache lu", "Cache écrit", "Total"]);
  assert.equal(cols(heads[2])[0], "Poste");
  assert.match(text, /1 234 567/);
  assert.match(text, /F-07/);
  assert.match(text, /^10\s+\|\s+1 \|\s+2 \|/m);
  assert.match(text, /Hors feature/);
  assert.match(text, /Non attribué/);
  assert.match(text, /- FORMAT_ANCIEN : lignes isSidechain/);
});

test("texte avec focus : le milestone ciblé seulement", () => {
  const text = formatText(report({ focus: "M1" }), { focus: "M1" });
  assert.match(text, /Milestone : M1/);
  assert.doesNotMatch(text, /M2|F-07|Hors feature|Non attribué/);
});

test("texte sans donnée : lisible, avec les avertissements", () => {
  const text = formatText(aggregate({ warnings: [{ code: "TRANSCRIPTS_ABSENTS", message: "aucun transcript" }] }));
  assert.match(text, /aucune consommation trouvée/);
  assert.match(text, /TRANSCRIPTS_ABSENTS/);
  assert.doesNotMatch(text, /\| Entrée/);
});

test("JSON v1 : clés et types du contrat, warnings repris", () => {
  const r = JSON.parse(formatJson(report()));
  assert.deepEqual(Object.keys(r), ["v", "generatedAt", "project", "totals", "cp", "milestones", "features", "horsFeature", "agents", "nonAttribue", "warnings"]);
  assert.equal(r.v, 1);
  const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "total", "messages"];
  assert.deepEqual(Object.keys(r.totals), usageKeys);
  assert.deepEqual(Object.keys(r.cp), ["sessions", "usage", "parMilestone"]);
  assert.deepEqual(Object.keys(r.milestones[0]), ["titre", "issues", "usage"]);
  assert.deepEqual(Object.keys(r.features[0]), ["issue", "milestone", "agents", "usage"]);
  assert.deepEqual(Object.keys(r.agents[0]), ["agentId", "role", "mode", "issue", "pr", "attempt", "model", "debut", "fin", "usage"]);
  assert.deepEqual(Object.keys(r.nonAttribue), ["usage", "fichiers"]);
  assert.equal(r.project, null);
  assert.equal(r.agents[0].mode, null);
  assert.equal(typeof r.features[0].issue, "number");
  assert.equal(r.features[1].issue, "F-07");
  assert.deepEqual(r.warnings, [{ code: "FORMAT_ANCIEN", message: "lignes isSidechain" }]);
});
