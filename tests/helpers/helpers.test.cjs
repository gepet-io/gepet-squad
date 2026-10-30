// Tests des helpers de test : fonctions pures (unitaires) puis I/O réelles (intégration).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");

const { buildEnv, installFakeGh, createTempRepo, gitCommonDir, parseSse, createSseParser, openSse } = require("./index.cjs");

describe("buildEnv (unitaire)", () => {
  test("place le dossier en tête du PATH POSIX avec le séparateur ':'", () => {
    const env = buildEnv("/tmp/fake", { PATH: "/usr/bin:/bin", HOME: "/home/x" }, "linux");
    assert.equal(env.PATH, "/tmp/fake:/usr/bin:/bin");
    assert.equal(env.HOME, "/home/x");
  });

  test("retrouve la variable 'Path' de Windows et utilise ';'", () => {
    const env = buildEnv("C:\\fake", { Path: "C:\\Windows;C:\\Windows\\System32" }, "win32");
    assert.equal(env.Path, "C:\\fake;C:\\Windows;C:\\Windows\\System32");
    assert.equal(env.PATH, undefined);
  });

  test("crée PATH s'il n'existe pas et ne modifie pas l'environnement d'origine", () => {
    const base = { HOME: "/home/x" };
    const env = buildEnv("/tmp/fake", base, "linux");
    assert.equal(env.PATH, "/tmp/fake");
    assert.equal("PATH" in base, false);
  });
});

describe("parseSse (unitaire)", () => {
  test("parse des événements nommés, avec id et données multi-lignes", () => {
    const text = "id: 1\nevent: state\ndata: {\"a\":1}\n\nid: 2\ndata: ligne 1\ndata: ligne 2\n\n";
    assert.deepEqual(parseSse(text), [
      { event: "state", data: '{"a":1}', id: "1" },
      { event: "message", data: "ligne 1\nligne 2", id: "2" },
    ]);
  });

  test("ignore les commentaires (keep-alive), lit retry et gère CRLF", () => {
    const text = ": keep-alive\r\n\r\nretry: 3000\r\ndata: ok\r\n\r\n";
    assert.deepEqual(parseSse(text), [{ event: "message", data: "ok", retry: 3000 }]);
  });

  test("n'émet rien tant que l'événement n'est pas terminé par une ligne vide", () => {
    assert.deepEqual(parseSse("data: incomplet\n"), []);
  });

  test("reconstitue un événement découpé en morceaux arbitraires, y compris au milieu de CRLF", () => {
    const parser = createSseParser();
    const out = [];
    for (const chunk of ["da", "ta: he", "llo\r", "\n\r", "\ndata: x\n\n"]) out.push(...parser.feed(chunk));
    assert.deepEqual(out, [{ event: "message", data: "hello" }, { event: "message", data: "x" }]);
  });
});

describe("repo git temporaire et worktree (intégration)", () => {
  test("le repo et son worktree partagent le même git-common-dir", () => {
    const repo = createTempRepo({ withWorktree: true });
    try {
      assert.ok(fs.existsSync(path.join(repo.worktreeDir, ".git")), "le worktree doit exister");
      assert.notEqual(repo.dir, repo.worktreeDir);
      // Bien deux checkouts distincts, sur des branches distinctes.
      assert.equal(repo.git(repo.dir, ["branch", "--show-current"]), "main");
      assert.equal(repo.git(repo.worktreeDir, ["branch", "--show-current"]), "feature/test");

      const depuisRepo = gitCommonDir(repo.dir);
      const depuisWorktree = gitCommonDir(repo.worktreeDir);
      assert.equal(depuisWorktree, depuisRepo);
      assert.equal(depuisRepo, fs.realpathSync(path.join(repo.dir, ".git")));
    } finally {
      repo.cleanup();
    }
  });

  test("cleanup supprime le repo et le worktree", () => {
    const repo = createTempRepo({ withWorktree: true });
    repo.cleanup();
    assert.equal(fs.existsSync(repo.dir), false);
    assert.equal(fs.existsSync(repo.worktreeDir), false);
  });
});

describe("faux gh (intégration)", () => {
  const responses = {
    routes: [
      { match: ["issue", "list"], json: [{ number: 1, title: "Outillage", labels: [{ name: "status:in-progress" }] }] },
      { match: ["pr", "view"], stdout: "texte brut\n" },
      { match: ["auth", "status"], stderr: "not logged in\n", exitCode: 4 },
    ],
  };

  test("renvoie le JSON de fixture et journalise les arguments", async () => {
    const gh = installFakeGh(responses);
    try {
      const res = await gh.run(["issue", "list", "--json", "number,title"]);
      assert.equal(res.code, 0);
      assert.deepEqual(JSON.parse(res.stdout), [
        { number: 1, title: "Outillage", labels: [{ name: "status:in-progress" }] },
      ]);
      const calls = gh.calls();
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ["issue", "list", "--json", "number,title"]);
    } finally {
      gh.cleanup();
    }
  });

  test("gère stdout brut, stderr et code de sortie, et garde l'ordre des appels", async () => {
    const gh = installFakeGh(responses);
    try {
      const vue = await gh.run(["pr", "view", "7"]);
      assert.deepEqual([vue.code, vue.stdout], [0, "texte brut\n"]);

      const auth = await gh.run(["auth", "status"]);
      assert.equal(auth.code, 4);
      assert.match(auth.stderr, /not logged in/);

      assert.deepEqual(
        gh.calls().map((c) => c.args),
        [["pr", "view", "7"], ["auth", "status"]],
      );
    } finally {
      gh.cleanup();
    }
  });

  test("échoue explicitement quand aucune fixture ne correspond", async () => {
    const gh = installFakeGh(responses);
    try {
      const res = await gh.run(["release", "list"]);
      assert.equal(res.code, 1);
      assert.match(res.stderr, /aucune réponse de fixture pour : release list/);
      assert.deepEqual(gh.calls().map((c) => c.args), [["release", "list"]]);
    } finally {
      gh.cleanup();
    }
  });

  test("gh est résolu depuis le PATH fourni, par un sous-processus Node (execFile 'node')", async () => {
    const gh = installFakeGh(responses);
    try {
      // Le sous-processus utilise child_process.execFile avec l'env du faux gh, comme le fera le serveur.
      const script =
        "const {execFile}=require('child_process');" +
        "const w=process.platform==='win32';" +
        "execFile(w?'gh.cmd':'gh',['issue','list'],{shell:w},(e,o)=>{process.stdout.write(o)})";
      const stdout = await new Promise((resolve, reject) => {
        execFile(process.execPath, ["-e", script], { env: gh.env(), encoding: "utf8" }, (err, out) =>
          err ? reject(err) : resolve(out),
        );
      });
      assert.equal(JSON.parse(stdout)[0].number, 1);
      assert.deepEqual(gh.calls()[0].args, ["issue", "list"]);
    } finally {
      gh.cleanup();
    }
  });
});

describe("client SSE (intégration)", () => {
  test("reçoit les événements d'un vrai serveur http et sait attendre un événement", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write(": bonjour\n\n");
      res.write("id: 1\nevent: state\ndata: {\"n\":1}\n\n");
      setTimeout(() => res.write("id: 2\ndata: deux\n\n"), 50);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const sse = await openSse(`http://127.0.0.1:${server.address().port}/events`);
    try {
      assert.equal(sse.status, 200);
      assert.match(sse.headers["content-type"], /text\/event-stream/);
      await sse.waitFor((events) => events.length >= 2);
      assert.deepEqual(sse.events, [
        { event: "state", data: '{"n":1}', id: "1" },
        { event: "message", data: "deux", id: "2" },
      ]);
      await assert.rejects(() => sse.waitFor((events) => events.length >= 3, 100), /délai de 100 ms dépassé/);
    } finally {
      sse.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
