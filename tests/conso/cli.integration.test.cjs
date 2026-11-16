"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createTempRepo, gitCommonDir } = require("../helpers/git-repo.cjs");

const CLI = path.join(__dirname, "..", "..", "conso", "cli.cjs");
const FIXTURES = path.join(__dirname, "..", "fixtures", "transcripts");

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    if (entry.isDirectory()) copyDir(src, path.join(to, entry.name));
    else fs.copyFileSync(src, path.join(to, entry.name));
  }
}

/** Repo git temporaire avec .gepet-squad.json et journal ; config Claude temporaire avec les transcripts. */
function setup({ withTranscripts = true } = {}) {
  const repo = createTempRepo();
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), JSON.stringify({ version: 1 }));
  const journalDir = path.join(gitCommonDir(repo.dir), "gepet-squad");
  fs.mkdirSync(journalDir, { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "events.jsonl"), path.join(journalDir, "events.jsonl"));
  const config = fs.mkdtempSync(path.join(os.tmpdir(), "conso-cfg-"));
  const project = path.join(config, "projects", "slug-quelconque");
  fs.mkdirSync(project, { recursive: true });
  if (withTranscripts) {
    fs.copyFileSync(path.join(FIXTURES, "sess-cp-0001.jsonl"), path.join(project, "sess-cp-0001.jsonl"));
    copyDir(path.join(FIXTURES, "sess-cp-0001"), path.join(project, "sess-cp-0001"));
  }
  return {
    repo,
    config,
    cleanup() {
      repo.cleanup();
      fs.rmSync(config, { recursive: true, force: true });
    },
  };
}

function cli(args, configDir, cwd) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const MILESTONES = ["--milestone", "M1=11,12", "--milestone", "M2=F-07"];

test("sortie JSON : chiffres exacts, transcripts localisés par le journal", () => {
  const s = setup();
  try {
    const r = cli(["--project", s.repo.dir, ...MILESTONES, "--format", "json"], s.config, os.tmpdir());
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    assert.equal(report.v, 1);
    assert.equal(report.cp.usage.total, 300);
    assert.equal(report.totals.total, 300 + 76 + 79 + 30);
    assert.deepEqual(report.milestones.map((m) => [m.titre, m.usage.total]), [["M1", 155], ["M2", 30]]);
    assert.deepEqual(report.features.map((f) => f.issue), [11, 12, "F-07"]);
    assert.deepEqual(report.warnings, []);
  } finally {
    s.cleanup();
  }
});

test("sortie texte avec --focus : un seul milestone", () => {
  const s = setup();
  try {
    const r = cli([...MILESTONES, "--focus", "M2"], s.config, s.repo.dir);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Milestone : M2/);
    assert.match(r.out, /F-07/);
    assert.doesNotMatch(r.out, /^11 /m);
    assert.equal(r.err, "");
  } finally {
    s.cleanup();
  }
});

test("sans aucun transcript : code 0 et avertissement TRANSCRIPTS_ABSENTS", () => {
  const s = setup({ withTranscripts: false });
  try {
    const r = cli(["--format", "json"], s.config, s.repo.dir);
    assert.equal(r.code, 0, r.err);
    const report = JSON.parse(r.out);
    assert.equal(report.totals.total, 0);
    assert.ok(report.warnings.some((w) => w.code === "TRANSCRIPTS_ABSENTS"));
    assert.match(cli([], s.config, s.repo.dir).out, /TRANSCRIPTS_ABSENTS/);
  } finally {
    s.cleanup();
  }
});

test("repo sans .gepet-squad.json : code 1 et erreur sur stderr", () => {
  const repo = createTempRepo();
  try {
    const r = cli([], os.tmpdir(), repo.dir);
    assert.equal(r.code, 1);
    assert.equal(r.out, "");
    assert.match(r.err, /^\[gepet-squad-conso\] erreur /);
  } finally {
    repo.cleanup();
  }
});

test("arguments invalides : code 2", () => {
  const s = setup();
  try {
    assert.equal(cli(["--milestone", "M1=abc"], s.config, s.repo.dir).code, 2);
    assert.equal(cli(["--focus", "absent"], s.config, s.repo.dir).code, 2);
  } finally {
    s.cleanup();
  }
});

test("journal absent : pas de plantage, avertissement JOURNAL_ABSENT", () => {
  const s = setup();
  try {
    fs.rmSync(path.join(gitCommonDir(s.repo.dir), "gepet-squad"), { recursive: true, force: true });
    const r = cli(["--format", "json"], s.config, s.repo.dir);
    assert.equal(r.code, 0, r.err);
    assert.ok(JSON.parse(r.out).warnings.some((w) => w.code === "JOURNAL_ABSENT"));
  } finally {
    s.cleanup();
  }
});
