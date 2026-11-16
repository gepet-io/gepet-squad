"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseUsageLine, dedupeByMessageId } = require("../../conso/lib/transcripts.cjs");

const FIXTURES = path.join(__dirname, "..", "fixtures", "transcripts");

function lines(file) {
  return fs.readFileSync(path.join(FIXTURES, file), "utf8").split("\n").filter(Boolean);
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test("ligne nominale : quatre compteurs, sans contenu de message", () => {
  const entry = parseUsageLine(lines("sess-cp-0001.jsonl")[1]);
  assert.deepEqual(entry, {
    messageId: "msg_cp_1",
    model: "claude-opus-4",
    ts: "2026-01-01T10:00:01.000Z",
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 },
  });
  assert.ok(!JSON.stringify(entry).includes("Texte neutre"));
});

test("doublon de message.id : une seule occurrence, la dernière", () => {
  const kept = dedupeByMessageId(lines("sess-cp-0001.jsonl").map(parseUsageLine));
  assert.deepEqual(kept.map((e) => e.messageId), ["msg_cp_1", "msg_cp_2"]);
  assert.equal(kept[0].usage.output, 40);
});

test("ligne illisible, sans usage, synthétique ou nulle : null sans exception", () => {
  const cp = lines("sess-cp-0001.jsonl");
  assert.equal(parseUsageLine("ligne illisible {"), null);
  assert.equal(parseUsageLine('{"usage": '), null);
  assert.equal(parseUsageLine(cp[0]), null);
  assert.equal(parseUsageLine(cp[4]), null);
  assert.equal(parseUsageLine(undefined), null);
  assert.equal(parseUsageLine('{"type":"assistant","message":{"id":"m","model":"x","usage":{"output_tokens":0}}}'), null);
});

test("compteur absent vaut 0", () => {
  const e = parseUsageLine('{"type":"assistant","timestamp":"t","message":{"id":"m","model":"x","usage":{"output_tokens":3}}}');
  assert.deepEqual(e.usage, { input: 0, output: 3, cacheRead: 0, cacheWrite: 0 });
});

test("ligne isSidechain : signalée à part, ni comptée ni nulle", () => {
  const line = '{"isSidechain":true,"type":"assistant","message":{"id":"m","model":"x","usage":{"output_tokens":3}}}';
  assert.deepEqual(parseUsageLine(line), { sidechain: true });
  assert.deepEqual(dedupeByMessageId([parseUsageLine(line)]), []);
});

test("fixtures anonymisées : aucun chemin absolu ni nom d'utilisateur", () => {
  const files = walk(FIXTURES);
  assert.ok(files.length >= 6);
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const bad of ["C:\\", "C:/", "/home/", "/Users/"]) {
      assert.ok(!text.includes(bad), `${file} contient ${bad}`);
    }
  }
});
