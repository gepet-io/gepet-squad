"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configDir, projectSlug, locateSessions, locateSessionsBySlug, readTranscript } = require("../../conso/lib/sources.cjs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "transcripts");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) copyDir(src, path.join(to, entry.name));
    else fs.copyFileSync(src, path.join(to, entry.name));
  }
}

function tempConfig(projectDirName) {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "conso-config-"));
  const project = path.join(config, "projects", projectDirName);
  copyDir(FIXTURES, project);
  fs.rmSync(path.join(project, "events.jsonl"));
  return { config, project, cleanup: () => fs.rmSync(config, { recursive: true, force: true }) };
}

test("configDir : CLAUDE_CONFIG_DIR sinon ~/.claude", () => {
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: "/x/y" }), "/x/y");
  assert.equal(configDir({}), path.join(os.homedir(), ".claude"));
  assert.equal(configDir({ CLAUDE_CONFIG_DIR: "" }), path.join(os.homedir(), ".claude"));
});

test("projectSlug : tout caractère non alphanumérique devient « - »", () => {
  assert.ok(projectSlug(path.resolve("/a b/c_d")).endsWith("a-b-c-d"));
});

test("locateSessions : trouve la session du journal et ses agents sans connaître le slug", () => {
  const t = tempConfig("n-importe-quel-slug");
  try {
    const sessions = locateSessions(t.config, ["sess-cp-0001", "absente", "../evasion"]);
    assert.equal(sessions.length, 1);
    assert.equal(path.basename(sessions[0].main), "sess-cp-0001.jsonl");
    assert.deepEqual(sessions[0].agents.map((a) => a.agentId), ["a1", "a2", "a3"]);
  } finally {
    t.cleanup();
  }
});

test("locateSessionsBySlug : ne garde que les sessions avec un agent de la squad", () => {
  const root = path.resolve(os.tmpdir(), "mon projet");
  const t = tempConfig(projectSlug(root));
  try {
    const autre = path.join(t.project, "sess-autre", "subagents");
    fs.mkdirSync(autre, { recursive: true });
    fs.writeFileSync(path.join(autre, "agent-z.jsonl"), "{}\n");
    fs.writeFileSync(path.join(autre, "agent-z.meta.json"), JSON.stringify({ agentType: "autre-plugin:x" }));
    const sessions = locateSessionsBySlug(t.config, root);
    assert.deepEqual(sessions.map((s) => s.sessionId), ["sess-cp-0001"]);
    assert.deepEqual(locateSessionsBySlug(t.config, path.resolve(os.tmpdir(), "inconnu")), []);
  } finally {
    t.cleanup();
  }
});

test("readTranscript : flux dédupliqué, ligne illisible comptée, fichier absent toléré", async () => {
  const t = tempConfig("p");
  try {
    const r = await readTranscript(path.join(t.project, "sess-cp-0001.jsonl"));
    assert.deepEqual(r.entries.map((e) => e.messageId), ["msg_cp_1", "msg_cp_2"]);
    assert.equal(r.entries[0].usage.output, 40);
    assert.equal(r.sidechain, 0);
    assert.match(r.first, /"type":"user"/);

    const bad = path.join(t.config, "bad.jsonl");
    fs.writeFileSync(bad, '{"usage": cassé\n{"isSidechain":true,"type":"assistant","message":{"id":"m","model":"x","usage":{"output_tokens":3}}}\n');
    const b = await readTranscript(bad);
    assert.equal(b.unreadable, 1);
    assert.equal(b.sidechain, 1);
    assert.equal(b.entries.length, 0);
    assert.deepEqual(await readTranscript(path.join(t.config, "absent.jsonl")), { first: "", entries: [], unreadable: 0, sidechain: 0 });
  } finally {
    t.cleanup();
  }
});
