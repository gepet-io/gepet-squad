// Tests d'intégration de hooks/events.cjs : le collecteur est exécuté en sous-processus, comme le fait
// Claude Code, avec chaque fixture de payload (#2) et des commandes `gh` (#3) sur stdin, dans un repo git
// temporaire contenant .gepet-squad.json et dans un de ses worktrees.
const { test, describe, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createTempRepo, gitCommonDir } = require("../helpers/index.cjs");
const { validate } = require("../../hooks/lib/schema.cjs");

const EVENTS_CJS = path.join(__dirname, "..", "..", "hooks", "events.cjs");
const HOOK_FIXTURES = path.join(__dirname, "..", "fixtures", "hooks");
const GH_FIXTURES = path.join(__dirname, "..", "fixtures", "gh");
const SESSION = "5f3c1a9e-7b2d-4c6e-9a41-0d8e2b7f6c13";

const cleanups = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()();
});

// Repo temporaire avec .gepet-squad.json dans le repo principal et dans son worktree (le fichier est commité
// dans un vrai projet, donc présent dans les deux).
function squadRepo({ withWorktree = true } = {}) {
  const repo = createTempRepo({ withWorktree });
  cleanups.push(repo.cleanup);
  fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), "{}");
  if (repo.worktreeDir) fs.writeFileSync(path.join(repo.worktreeDir, ".gepet-squad.json"), "{}");
  const common = gitCommonDir(repo.dir);
  const dir = path.join(common, "gepet-squad");
  return {
    ...repo,
    common,
    journalDir: dir,
    events: path.join(dir, "events.jsonl"),
    rotated: path.join(dir, "events.1.jsonl"),
    log: path.join(dir, "collector.log"),
  };
}

function hookFixture(name, cwd) {
  const payload = JSON.parse(fs.readFileSync(path.join(HOOK_FIXTURES, `${name}.json`), "utf8"));
  return { ...payload, cwd };
}

function bashPayload(command, cwd) {
  return {
    session_id: SESSION,
    cwd,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: { stdout: "", stderr: "", interrupted: false },
    tool_use_id: "toolu_01Bash",
  };
}

// Lance le collecteur. `input` est un objet (sérialisé en JSON) ou une chaîne brute. `cwd` est le répertoire de
// travail du processus, comme celui de la session pour un hook réel.
function runCollector(input, cwd) {
  const stdin = typeof input === "string" ? input : JSON.stringify(input);
  const result = spawnSync(process.execPath, [EVENTS_CJS], { input: stdin, cwd, encoding: "utf8", timeout: 20000 });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

// Vérifie les garanties communes à toute exécution : code 0 et stdout vide.
function assertSilentSuccess(result) {
  assert.equal(result.status, 0, `code ${result.status}, stderr : ${result.stderr}`);
  assert.equal(result.stdout, "");
}

function readEvents(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

function ghFixture(name) {
  return fs.readFileSync(path.join(GH_FIXTURES, `${name}.txt`), "utf8");
}

// Attendu pour chaque fixture de payload : type et identifiants qui prouvent que la bonne branche de
// normalize.cjs a été appelée.
const HOOK_CASES = [
  ["pre-tool-use-agent", { type: "agent.requested", agentType: "gepet-squad:developpeur", mode: "IMPLEMENTATION", issue: 7 }],
  ["pre-tool-use-agent-verificateur", { type: "agent.requested", agentType: "gepet-squad:verificateur", pr: 12 }],
  ["post-tool-use-agent-async-launched", { type: "agent.launched" }],
  ["post-tool-use-agent-completed", { type: "agent.finished", source: "tool", agentId: "b7e1f4a2c9d83056" }],
  ["subagent-start", { type: "agent.started" }],
  ["subagent-stop", { type: "agent.finished", source: "stop" }],
  ["pre-tool-use-subagent-handback", { type: "agent.reported", block: "RAPPORT_VERIFICATION", verdict: "PASS", agentId: "b7e1f4a2c9d83056" }],
];

describe("collecteur dans un projet squad : une ligne v1 par fixture", () => {
  for (const [name, expected] of HOOK_CASES) {
    test(`${name} -> ${expected.type}`, () => {
      const repo = squadRepo({ withWorktree: false });
      assertSilentSuccess(runCollector(hookFixture(name, repo.dir), repo.dir));

      const events = readEvents(repo.events);
      assert.equal(events.length, 1);
      assert.deepEqual(validate(events[0]), { valid: true, errors: [] });
      assert.equal(events[0].v, 1);
      assert.equal(events[0].src, "hook");
      assert.equal(events[0].sessionId, SESSION);
      assert.ok(!Number.isNaN(Date.parse(events[0].ts)));
      for (const [key, value] of Object.entries(expected)) assert.equal(events[0][key], value, key);
    });
  }

  test("aucune donnée de prompt, de rapport ou de contenu n'atteint le journal", () => {
    const repo = squadRepo({ withWorktree: false });
    for (const [name] of HOOK_CASES) assertSilentSuccess(runCollector(hookFixture(name, repo.dir), repo.dir));
    const text = fs.readFileSync(repo.events, "utf8");
    assert.equal(text.split("\n").filter(Boolean).length, HOOK_CASES.length);
    assert.doesNotMatch(text, /SECRET_[A-Z_]*MARKER/);
    assert.doesNotMatch(text, /REFERENCES|transcript|prompt/);
  });

  test("le cycle complet d'un agent en arrière-plan s'enchaîne dans l'ordre d'écriture", () => {
    const repo = squadRepo({ withWorktree: false });
    for (const name of ["pre-tool-use-agent", "post-tool-use-agent-async-launched", "subagent-start", "pre-tool-use-subagent-handback", "subagent-stop"]) {
      assertSilentSuccess(runCollector(hookFixture(name, repo.dir), repo.dir));
    }
    assert.deepEqual(
      readEvents(repo.events).map((e) => e.type),
      ["agent.requested", "agent.launched", "agent.started", "agent.reported", "agent.finished"],
    );
  });
});

describe("collecteur : préfixe d'agent ancien et nouveau", () => {
  // La fixture porte l'ancien préfixe (payload réel) ; le nouveau est obtenu en le remplaçant.
  for (const prefix of ["claude-gepet-squad:", "gepet-squad:"]) {
    for (const name of ["subagent-start", "subagent-stop", "pre-tool-use-agent"]) {
      test(`${name} avec le préfixe ${prefix} : une ligne écrite, type au nouveau préfixe`, () => {
        const repo = squadRepo({ withWorktree: false });
        const payload = JSON.parse(JSON.stringify(hookFixture(name, repo.dir)).replaceAll("claude-gepet-squad:", prefix));
        assertSilentSuccess(runCollector(payload, repo.dir));

        const events = readEvents(repo.events);
        assert.equal(events.length, 1);
        assert.deepEqual(validate(events[0]), { valid: true, errors: [] });
        assert.equal(events[0].agentType, "gepet-squad:developpeur");
      });
    }
  }

  test("un agent d'un autre plugin ou au préfixe approchant n'écrit rien", () => {
    const repo = squadRepo({ withWorktree: false });
    for (const agentType of ["autre-plugin:architecte", "claude-gepet-squad-evil:x"]) {
      assertSilentSuccess(runCollector({ ...hookFixture("subagent-start", repo.dir), agent_type: agentType }, repo.dir));
    }
    assert.equal(fs.existsSync(repo.events), false);
  });
});

describe("collecteur : commandes gh du PostToolUse Bash", () => {
  test("une commande gh suivie produit son événement", () => {
    const repo = squadRepo({ withWorktree: false });
    assertSilentSuccess(runCollector(bashPayload(ghFixture("issue-edit-status"), repo.dir), repo.dir));
    const events = readEvents(repo.events);
    assert.equal(events.length, 1);
    assert.deepEqual(validate(events[0]), { valid: true, errors: [] });
    assert.equal(events[0].type, "feature.status");
    assert.equal(events[0].issue, 12);
    assert.equal(events[0].status, "in-progress");
    assert.equal(events[0].sessionId, SESSION);
  });

  test("une ligne de commande qui enchaîne trois commandes écrit trois lignes, dans l'ordre", () => {
    const repo = squadRepo({ withWorktree: false });
    assertSilentSuccess(runCollector(bashPayload(ghFixture("merge-flow"), repo.dir), repo.dir));
    assert.deepEqual(
      readEvents(repo.events).map((e) => [e.type, e.pr ?? e.issue]),
      [["pr.merged", 34], ["issue.closed", 12], ["feature.status", 12]],
    );
  });

  test("les commandes non suivies (lecture seule, hors gh, faux positifs de heredoc) n'écrivent rien", () => {
    const repo = squadRepo({ withWorktree: false });
    for (const command of [ghFixture("read-only"), ghFixture("pr-comment-heredoc"), ghFixture("doc-placeholders"), "ls -la && npm test"]) {
      assertSilentSuccess(runCollector(bashPayload(command, repo.dir), repo.dir));
    }
    assert.equal(fs.existsSync(repo.journalDir), false);
  });

  test("le contenu des corps de PR et de commentaires n'est jamais recopié", () => {
    const repo = squadRepo({ withWorktree: false });
    const command = 'gh pr create --repo o/r --base develop --head feature/12-demo --title "feat: demo" --body "SECRET_BODY_MARKER"';
    assertSilentSuccess(runCollector(bashPayload(command, repo.dir), repo.dir));
    const text = fs.readFileSync(repo.events, "utf8");
    assert.match(text, /"type":"pr.opened"/);
    assert.doesNotMatch(text, /SECRET_BODY_MARKER|feat: demo/);
  });
});

describe("repo principal et worktree alimentent le même journal", () => {
  test("les lignes écrites depuis le worktree atterrissent dans le journal du repo principal", () => {
    const repo = squadRepo({ withWorktree: true });
    assertSilentSuccess(runCollector(hookFixture("pre-tool-use-agent", repo.dir), repo.dir));
    assertSilentSuccess(runCollector(hookFixture("subagent-start", repo.worktreeDir), repo.worktreeDir));
    assertSilentSuccess(runCollector(hookFixture("pre-tool-use-subagent-handback", repo.worktreeDir), repo.worktreeDir));
    assertSilentSuccess(runCollector(bashPayload(ghFixture("pr-merge"), repo.dir), repo.dir));

    assert.deepEqual(
      readEvents(repo.events).map((e) => e.type),
      ["agent.requested", "agent.started", "agent.reported", "pr.merged"],
    );
    // Un seul journal : le worktree n'a pas de dossier gepet-squad propre.
    assert.equal(fs.existsSync(path.join(repo.worktreeDir, ".git", "gepet-squad")), false);
    assert.equal(fs.existsSync(path.join(repo.worktreeDir, "gepet-squad")), false);
    const worktreeAdmin = path.join(repo.common, "worktrees");
    for (const entry of fs.readdirSync(worktreeAdmin)) {
      assert.equal(fs.existsSync(path.join(worktreeAdmin, entry, "gepet-squad")), false);
    }
  });

  test("un sous-dossier du worktree donne le même journal (recherche de la config en remontant)", () => {
    const repo = squadRepo({ withWorktree: true });
    const sub = path.join(repo.worktreeDir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    assertSilentSuccess(runCollector(hookFixture("subagent-stop", sub), sub));
    assert.equal(readEvents(repo.events).length, 1);
  });

  test("un worktree sans .gepet-squad.json propre est reconnu s'il est sous le projet", () => {
    // Comme les worktrees des agents : <projet>/.claude/worktrees/<nom>.
    const repo = createTempRepo();
    cleanups.push(repo.cleanup);
    fs.writeFileSync(path.join(repo.dir, ".gepet-squad.json"), "{}");
    const nested = path.join(repo.dir, ".claude", "worktrees", "agent-x");
    repo.git(repo.dir, ["worktree", "add", "-b", "feature/nested", nested]);
    fs.rmSync(path.join(nested, ".gepet-squad.json"), { force: true });
    assertSilentSuccess(runCollector(hookFixture("subagent-start", nested), nested));
    const events = readEvents(path.join(gitCommonDir(repo.dir), "gepet-squad", "events.jsonl"));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "agent.started");
  });
});

describe("collecteur hors d'un projet squad", () => {
  test("repo git sans .gepet-squad.json : aucun fichier n'est écrit", () => {
    const repo = createTempRepo({ withWorktree: true });
    cleanups.push(repo.cleanup);
    const common = gitCommonDir(repo.dir);
    for (const cwd of [repo.dir, repo.worktreeDir]) {
      for (const [name] of HOOK_CASES) assertSilentSuccess(runCollector(hookFixture(name, cwd), cwd));
      assertSilentSuccess(runCollector(bashPayload(ghFixture("merge-flow"), cwd), cwd));
      assertSilentSuccess(runCollector("pas du json", cwd));
    }
    assert.equal(fs.existsSync(path.join(common, "gepet-squad")), false);
  });

  test("dossier sans git ni config : aucun fichier n'est écrit", () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-nogit-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    assertSilentSuccess(runCollector(hookFixture("subagent-stop", dir), dir));
    assertSilentSuccess(runCollector("{", dir));
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test("projet squad sans repo git : sort en 0 sans rien écrire ni rien afficher", () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-nogit-")));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, ".gepet-squad.json"), "{}");
    assertSilentSuccess(runCollector(hookFixture("subagent-stop", dir), dir));
    assert.deepEqual(fs.readdirSync(dir), [".gepet-squad.json"]);
  });
});

describe("collecteur : entrées invalides, jamais d'échec", () => {
  test("stdin invalide : code 0, stdout vide, erreur dans collector.log sans recopier l'entrée", () => {
    const repo = squadRepo({ withWorktree: false });
    const result = runCollector('{"prompt":"SECRET_STDIN_MARKER", oups', repo.dir);
    assertSilentSuccess(result);
    const log = fs.readFileSync(repo.log, "utf8");
    assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z stdin invalide/);
    assert.doesNotMatch(log, /SECRET_STDIN_MARKER/);
    assert.equal(fs.existsSync(repo.events), false);
  });

  test("stdin vide : code 0, stdout vide, erreur tracée", () => {
    const repo = squadRepo({ withWorktree: false });
    assertSilentSuccess(runCollector("", repo.dir));
    assert.match(fs.readFileSync(repo.log, "utf8"), /stdin invalide/);
  });

  test("payload inconnu (JSON qui n'est pas un hook suivi) : code 0, rien dans le journal, erreur tracée", () => {
    const repo = squadRepo({ withWorktree: false });
    for (const payload of [[], 42, "texte", null, {}, { hook_event_name: "Stop", cwd: repo.dir }, { hook_event_name: 12 }]) {
      assertSilentSuccess(runCollector(JSON.stringify(payload), repo.dir));
    }
    assert.equal(fs.existsSync(repo.events), false);
    const lines = fs.readFileSync(repo.log, "utf8").trim().split("\n");
    assert.equal(lines.length, 7);
    for (const line of lines) assert.match(line, /payload inconnu/);
  });

  test("hook suivi mais sans intérêt (agent d'un autre plugin, champs manquants) : rien d'écrit, pas d'erreur", () => {
    const repo = squadRepo({ withWorktree: false });
    const other = { ...hookFixture("pre-tool-use-agent", repo.dir), tool_input: { subagent_type: "autre:agent", prompt: "x" } };
    const broken = { hook_event_name: "SubagentStop", cwd: repo.dir, agent_type: "claude-gepet-squad:testeur" };
    assertSilentSuccess(runCollector(other, repo.dir));
    assertSilentSuccess(runCollector(broken, repo.dir));
    assert.equal(fs.existsSync(repo.events), false);
    assert.equal(fs.existsSync(repo.log), false);
  });

  test("erreur d'écriture : code 0, stdout vide, erreur dans collector.log", () => {
    const repo = squadRepo({ withWorktree: false });
    // events.jsonl est un dossier : l'ajout échoue sur toutes les plateformes.
    fs.mkdirSync(repo.events, { recursive: true });
    assertSilentSuccess(runCollector(hookFixture("subagent-start", repo.dir), repo.dir));
    assert.match(fs.readFileSync(repo.log, "utf8"), /écriture du journal impossible \(\w+/);
    assert.ok(fs.statSync(repo.events).isDirectory());
  });

  test("sans cwd dans le payload, le répertoire du processus fait foi", () => {
    const repo = squadRepo({ withWorktree: false });
    const payload = hookFixture("subagent-start", repo.dir);
    delete payload.cwd;
    assertSilentSuccess(runCollector(payload, repo.dir));
    assert.equal(readEvents(repo.events).length, 1);
  });

  test("cwd du payload inexistant : code 0, rien d'écrit", () => {
    const repo = squadRepo({ withWorktree: false });
    const missing = path.join(repo.dir, "n-existe-pas");
    assertSilentSuccess(runCollector(hookFixture("subagent-start", missing), repo.dir));
    assert.equal(fs.existsSync(repo.journalDir), false);
  });
});

describe("collector.log borné à 256 Ko", () => {
  test("un log déjà plein est ramené sous 256 Ko et garde l'erreur la plus récente", () => {
    const repo = squadRepo({ withWorktree: false });
    fs.mkdirSync(repo.journalDir, { recursive: true });
    const old = "2026-01-01T00:00:00.000Z ancienne erreur ".padEnd(99, "x") + "\n";
    fs.writeFileSync(repo.log, old.repeat(Math.ceil((300 * 1024) / old.length)));
    assert.ok(fs.statSync(repo.log).size > 256 * 1024);

    assertSilentSuccess(runCollector("pas du json", repo.dir));

    assert.ok(fs.statSync(repo.log).size <= 256 * 1024);
    const lines = fs.readFileSync(repo.log, "utf8").trimEnd().split("\n");
    assert.match(lines[lines.length - 1], /stdin invalide/);
    assert.ok(lines.every((line) => line.startsWith("20")), "aucune ligne coupée en deux");
  });
});

describe("rotation à 5 Mo", () => {
  const FIVE_MB = 5 * 1024 * 1024;

  test("au-delà de 5 Mo, events.jsonl devient events.1.jsonl et un nouveau journal démarre", () => {
    const repo = squadRepo({ withWorktree: true });
    fs.mkdirSync(repo.journalDir, { recursive: true });
    const filler = '{"v":1,"filler":true}\n'.repeat(Math.ceil(FIVE_MB / 22));
    fs.writeFileSync(repo.events, filler);
    assert.ok(fs.statSync(repo.events).size >= FIVE_MB);

    assertSilentSuccess(runCollector(hookFixture("subagent-start", repo.worktreeDir), repo.worktreeDir));

    assert.equal(fs.readFileSync(repo.rotated, "utf8"), filler);
    const events = readEvents(repo.events);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "agent.started");
    assert.deepEqual(fs.readdirSync(repo.journalDir).sort(), ["events.1.jsonl", "events.jsonl"]);
  });

  test("sous 5 Mo, aucune rotation : la ligne est ajoutée à la suite", () => {
    const repo = squadRepo({ withWorktree: false });
    fs.mkdirSync(repo.journalDir, { recursive: true });
    const filler = '{"v":1,"filler":true}\n'.repeat(1000);
    fs.writeFileSync(repo.events, filler);
    assertSilentSuccess(runCollector(hookFixture("subagent-start", repo.dir), repo.dir));
    assert.equal(fs.existsSync(repo.rotated), false);
    assert.equal(fs.readFileSync(repo.events, "utf8").startsWith(filler), true);
    assert.equal(readEvents(repo.events).length, 1001);
  });

  test("un seul ancien fichier est conservé : une seconde rotation remplace events.1.jsonl", () => {
    const repo = squadRepo({ withWorktree: false });
    fs.mkdirSync(repo.journalDir, { recursive: true });
    fs.writeFileSync(repo.rotated, '{"v":1,"generation":"tres-ancienne"}\n');
    const filler = '{"v":1,"generation":"recente"}\n'.repeat(Math.ceil(FIVE_MB / 31));
    fs.writeFileSync(repo.events, filler);

    assertSilentSuccess(runCollector(hookFixture("subagent-start", repo.dir), repo.dir));

    assert.equal(fs.readFileSync(repo.rotated, "utf8"), filler);
    assert.equal(fs.readFileSync(repo.rotated, "utf8").includes("tres-ancienne"), false);
    assert.deepEqual(fs.readdirSync(repo.journalDir).sort(), ["events.1.jsonl", "events.jsonl"]);
  });
});
