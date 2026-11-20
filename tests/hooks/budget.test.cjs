// hooks/budget.cjs : consigne de relais (développeur) ou de relève (Chef de projet) au premier franchissement du
// seuil de contexte, exécuté en sous-processus comme le fait Claude Code.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createTempRepo, gitEnv } = require("../helpers/index.cjs");
const { thresholds, lastContext } = require("../../hooks/budget.cjs");

const BUDGET_CJS = path.join(__dirname, "..", "..", "hooks", "budget.cjs");
const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

function usageLine(id, ctx) {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-20T10:00:00.000Z",
    message: { id, model: "claude-sonnet-5-5", content: [], usage: { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: ctx - 110, cache_creation_input_tokens: 100 } },
  });
}

// Projet squad + dossier de transcripts : session `sess-1`, agent développeur `a1` et vérificateur `a2`.
function setup({ config = {}, devCtx = 50000, cpCtx = 50000 } = {}) {
  const repo = createTempRepo();
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ repo: "local", mode: "econome", ...config }));
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), "gepet-budget-"));
  cleanups.push(() => fs.rmSync(projects, { recursive: true, force: true }));
  const transcript = path.join(projects, "sess-1.jsonl");
  const sub = path.join(projects, "sess-1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(transcript, [usageLine("m1", 1000), usageLine("m2", cpCtx)].join("\n") + "\n");
  fs.writeFileSync(path.join(sub, "agent-a1.jsonl"), [usageLine("d1", 1000), usageLine("d2", devCtx)].join("\n") + "\n");
  fs.writeFileSync(path.join(sub, "agent-a1.meta.json"), JSON.stringify({ agentType: "gepet-squad:developpeur" }));
  return { dir: repo.dir, transcript };
}

function hook(payload) {
  const res = spawnSync(process.execPath, [BUDGET_CJS], { input: JSON.stringify(payload), encoding: "utf8", env: gitEnv() });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim() === "" ? null : JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
}

const devPayload = (env, extra = {}) => ({
  hook_event_name: "PostToolUse",
  session_id: "sess-1",
  transcript_path: env.transcript,
  cwd: env.dir,
  agent_id: "a1",
  agent_type: "gepet-squad:developpeur",
  tool_name: "Bash",
  ...extra,
});

describe("budget : fonctions pures", () => {
  test("seuils par défaut, surcharge et désactivation", () => {
    assert.deepEqual(thresholds({}), { developpeur: 120000, chefDeProjet: 250000 });
    assert.deepEqual(thresholds({ budget: { developpeur: 80000, chefDeProjet: 0 } }), { developpeur: 80000, chefDeProjet: 0 });
    assert.deepEqual(thresholds({ budget: { developpeur: "beaucoup" } }).developpeur, 120000);
  });

  test("lastContext lit le dernier appel : entrée + cache lu + cache écrit", () => {
    assert.equal(lastContext([usageLine("x", 1000), usageLine("y", 130000), "{pas du json"].join("\n")), 130000);
    assert.equal(lastContext("rien\n"), null);
  });
});

describe("budget : développeur", () => {
  test("sous le seuil : rien", () => {
    assert.equal(hook(devPayload(setup({ devCtx: 90000 }))), null);
  });

  test("au-delà du seuil : consigne de relais, une seule fois", () => {
    const env = setup({ devCtx: 130000 });
    const first = hook(devPayload(env));
    assert.match(first, /Budget de contexte atteint/);
    assert.match(first, /Relais/);
    assert.match(first, /≈130k/);
    assert.equal(hook(devPayload(env)), null);
  });

  test("la variante outillée est concernée, pas le vérificateur ni un autre plugin", () => {
    const env = setup({ devCtx: 130000 });
    assert.equal(hook(devPayload(env, { agent_type: "gepet-squad:verificateur" })), null);
    assert.equal(hook(devPayload(env, { agent_type: "autre:developpeur" })), null);
    assert.match(hook(devPayload(env, { agent_type: "gepet-squad:developpeur-outille" })), /Relais/);
  });

  test("seuil configurable et désactivable", () => {
    assert.match(hook(devPayload(setup({ devCtx: 90000, config: { budget: { developpeur: 80000 } } }))), /seuil 80k/);
    assert.equal(hook(devPayload(setup({ devCtx: 900000, config: { budget: { developpeur: 0 } } }))), null);
  });

  test("hors projet squad : rien", () => {
    const env = setup({ devCtx: 130000 });
    fs.rmSync(path.join(env.dir, ".gepet-squad.json"));
    assert.equal(hook(devPayload(env)), null);
  });
});

describe("budget : Chef de projet", () => {
  const cpPayload = (env) => ({ hook_event_name: "PostToolUse", session_id: "sess-1", transcript_path: env.transcript, cwd: env.dir, tool_name: "Bash" });

  test("session qui a lancé des agents de la squad, au-delà du seuil : consigne de relève, une fois", () => {
    const env = setup({ cpCtx: 260000 });
    assert.match(hook(cpPayload(env)), /Relève du Chef de projet/);
    assert.equal(hook(cpPayload(env)), null);
  });

  test("session sans agent de la squad : rien, même au-delà du seuil", () => {
    const env = setup({ cpCtx: 260000 });
    fs.rmSync(path.join(path.dirname(env.transcript), "sess-1"), { recursive: true });
    assert.equal(hook(cpPayload(env)), null);
  });
});
