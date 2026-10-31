// Tests de viz/lib/http.cjs : fonctions pures (unitaires : Host, chemins statiques, empreinte, en-têtes), puis
// l'écouteur HTTP dans le processus de test, sur un dossier temporaire (symlinks, erreurs internes).
// Le serveur complet, démarré en sous-processus, est couvert par server.test.cjs.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const {
  isAllowedHost,
  isAllowedMethod,
  mimeFor,
  resolveStaticPath,
  isInside,
  importmapHash,
  buildCsp,
  buildHeaders,
  createRequestListener,
} = require("../../viz/lib/http.cjs");

const sha256 = (text) => "sha256-" + crypto.createHash("sha256").update(text, "utf8").digest("base64");

// ---------------------------------------------------------------------------------------------------------------
// Unitaires
// ---------------------------------------------------------------------------------------------------------------

describe("isAllowedHost (unitaire)", () => {
  test("accepte 127.0.0.1:<port> et localhost:<port>, sans tenir compte de la casse du nom", () => {
    for (const host of ["127.0.0.1:4321", "localhost:4321", "LOCALHOST:4321", "LocalHost:4321"]) {
      assert.equal(isAllowedHost(host, 4321), true, host);
    }
  });

  test("refuse un autre hôte, un autre port, ou un port absent", () => {
    const refuses = [
      "evil.example:4321",
      "evil.example",
      "127.0.0.1:4322",
      "localhost:80",
      "127.0.0.1",
      "localhost",
      "127.0.0.1:04321",
      "127.0.0.1:4321.evil.example",
      "127.0.0.1.evil.example:4321",
      "localhost.evil.example:4321",
      "evil.example/127.0.0.1:4321",
      "user@127.0.0.1:4321",
      "[::1]:4321",
      "0.0.0.0:4321",
      "127.0.0.2:4321",
      " 127.0.0.1:4321",
      "127.0.0.1:4321 ",
      "127.0.0.1:4321, evil.example",
      "",
    ];
    for (const host of refuses) assert.equal(isAllowedHost(host, 4321), false, JSON.stringify(host));
  });

  test("refuse un en-tête absent ou qui n'est pas une chaîne", () => {
    for (const host of [undefined, null, 4321, ["127.0.0.1:4321"], {}]) {
      assert.equal(isAllowedHost(host, 4321), false);
    }
  });

  test("refuse un port d'écoute invalide", () => {
    for (const port of [undefined, NaN, -1, 70000, "4321"]) {
      assert.equal(isAllowedHost("127.0.0.1:4321", port), false, String(port));
    }
  });

  test("le port 80 est le seul qui accepte un hôte sans port", () => {
    assert.equal(isAllowedHost("127.0.0.1", 80), true);
    assert.equal(isAllowedHost("localhost", 80), true);
    assert.equal(isAllowedHost("127.0.0.1:80", 80), true);
    assert.equal(isAllowedHost("127.0.0.1", 8080), false);
  });
});

describe("isAllowedMethod (unitaire)", () => {
  test("GET et HEAD seulement", () => {
    assert.equal(isAllowedMethod("GET"), true);
    assert.equal(isAllowedMethod("HEAD"), true);
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE", "CONNECT", "get", "", undefined]) {
      assert.equal(isAllowedMethod(method), false, String(method));
    }
  });
});

describe("mimeFor (unitaire)", () => {
  test("liste blanche : html, js, css, json, svg, png", () => {
    assert.equal(mimeFor("/p/index.html"), "text/html; charset=utf-8");
    assert.equal(mimeFor("/p/a.js"), "text/javascript; charset=utf-8");
    assert.equal(mimeFor("/p/a.css"), "text/css; charset=utf-8");
    assert.equal(mimeFor("/p/a.json"), "application/json; charset=utf-8");
    assert.equal(mimeFor("/p/a.svg"), "image/svg+xml");
    assert.equal(mimeFor("/p/a.png"), "image/png");
  });

  test("l'extension est insensible à la casse", () => {
    assert.equal(mimeFor("/p/A.JS"), "text/javascript; charset=utf-8");
  });

  test("tout le reste est refusé (null)", () => {
    for (const name of ["a.txt", "a.md", "a.map", "a.mjs", "a.html.bak", "a.exe", "noext", ".env", "a.js::$DATA", "a.constructor", "a.__proto__", ""]) {
      assert.equal(mimeFor(`/p/${name}`), null, name);
    }
  });
});

describe("resolveStaticPath (unitaire)", () => {
  const POSIX_ROOT = "/srv/public";
  const WIN_ROOT = "C:\\srv\\public";

  test("`/` désigne index.html", () => {
    const result = resolveStaticPath(POSIX_ROOT, "/", path.posix);
    assert.deepEqual(result, { status: 200, file: "/srv/public/index.html", mime: "text/html; charset=utf-8" });
  });

  test("un fichier de la liste blanche est résolu sous la racine, requête et fragment ignorés", () => {
    assert.equal(resolveStaticPath(POSIX_ROOT, "/js/app.js", path.posix).file, "/srv/public/js/app.js");
    assert.equal(resolveStaticPath(POSIX_ROOT, "/js/app.js?v=3#x", path.posix).file, "/srv/public/js/app.js");
    assert.equal(resolveStaticPath(POSIX_ROOT, "/css/a%20b.css", path.posix).file, "/srv/public/css/a b.css");
  });

  test("un `..` qui reste sous la racine est accepté", () => {
    assert.equal(resolveStaticPath(POSIX_ROOT, "/js/../css/app.css", path.posix).file, "/srv/public/css/app.css");
  });

  test("un nom qui commence par deux points n'est pas une traversée", () => {
    assert.equal(resolveStaticPath(POSIX_ROOT, "/..cache.js", path.posix).status, 200);
  });

  test("toute sortie de la racine donne 403, encodée ou non (POSIX)", () => {
    const cibles = [
      "/../secret.json",
      "/../../etc/passwd.json",
      "/js/../../secret.json",
      "/..%2fsecret.json",
      "/..%2Fsecret.json",
      "/%2e%2e/secret.json",
      "/%2E%2E/secret.json",
      "/%2e%2e%2fsecret.json",
      "/js/%2e%2e/%2e%2e/secret.json",
      "/js/..%2f..%2fsecret.json",
      "/.%2e/secret.json",
      "/%2e./secret.json",
      "//../secret.json",
      "/..%2f..%2f..%2f..%2f..%2f..%2fsecret.json",
    ];
    for (const cible of cibles) {
      assert.deepEqual(resolveStaticPath(POSIX_ROOT, cible, path.posix), { status: 403 }, cible);
    }
  });

  test("toute sortie de la racine donne 403, avec `\\` et lecteurs (Windows)", () => {
    const cibles = [
      "/../secret.json",
      "/..\\secret.json",
      "/..%5csecret.json",
      "/..%5Csecret.json",
      "/js/..\\..\\secret.json",
      "/%2e%2e%5csecret.json",
      "/..%2f..%2fWindows/win.json",
    ];
    for (const cible of cibles) {
      assert.deepEqual(resolveStaticPath(WIN_ROOT, cible, path.win32), { status: 403 }, cible);
    }
  });

  test("un chemin déguisé en lecteur ou en UNC ne désigne jamais un fichier hors racine (Windows)", () => {
    const cibles = ["/C:/secret.json", "/C:%5Csecret.json", "/D:/secret.json", "/\\\\serveur\\partage\\x.json", "/%5c%5cserveur%5cpartage%5cx.json"];
    for (const cible of cibles) {
      const result = resolveStaticPath(WIN_ROOT, cible, path.win32);
      if (result.status === 200) assert.ok(isInside(WIN_ROOT, result.file, path.win32), `${cible} -> ${result.file}`);
    }
  });

  test("un octet nul est refusé (403)", () => {
    assert.deepEqual(resolveStaticPath(POSIX_ROOT, "/index.html%00.png", path.posix), { status: 403 });
    assert.deepEqual(resolveStaticPath(POSIX_ROOT, "/a%00/../../secret.json", path.posix), { status: 403 });
  });

  test("un pourcentage mal formé donne 400", () => {
    for (const cible of ["/%zz", "/%", "/%e0%a4%a", "/a%2"]) {
      assert.deepEqual(resolveStaticPath(POSIX_ROOT, cible, path.posix), { status: 400 }, cible);
    }
  });

  test("une cible qui ne commence pas par `/` donne 400", () => {
    for (const cible of ["index.html", "*", "http://evil.example/index.html", "", undefined, null]) {
      assert.deepEqual(resolveStaticPath(POSIX_ROOT, cible, path.posix), { status: 400 }, String(cible));
    }
  });

  test("extension hors liste blanche ou dossier sans extension : 404", () => {
    for (const cible of ["/notes.txt", "/js", "/js/", "/vendor/three/build", "/.env", "/index.html.bak", "/a.js::$DATA"]) {
      assert.deepEqual(resolveStaticPath(POSIX_ROOT, cible, path.posix), { status: 404 }, cible);
    }
  });

  test("le chemin encodé est décodé une seule fois", () => {
    // %252e%252e se décode en « %2e%2e » littéral : un nom de dossier, pas une traversée.
    const result = resolveStaticPath(POSIX_ROOT, "/%252e%252e/secret.json", path.posix);
    assert.equal(result.status, 200);
    assert.equal(result.file, "/srv/public/%2e%2e/secret.json");
  });

  test("utilise le module path de la plateforme par défaut", () => {
    const root = path.resolve("public-test");
    assert.equal(resolveStaticPath(root, "/app.js").file, path.join(root, "app.js"));
  });
});

describe("isInside (unitaire)", () => {
  test("la racine et ses descendants sont dedans, le reste est dehors", () => {
    assert.equal(isInside("/srv/p", "/srv/p", path.posix), true);
    assert.equal(isInside("/srv/p", "/srv/p/a/b.js", path.posix), true);
    assert.equal(isInside("/srv/p", "/srv/p/..cache/b.js", path.posix), true);
    assert.equal(isInside("/srv/p", "/srv/q/b.js", path.posix), false);
    assert.equal(isInside("/srv/p", "/srv/p-autre/b.js", path.posix), false);
    assert.equal(isInside("/srv/p", "/srv", path.posix), false);
    assert.equal(isInside("C:\\srv\\p", "D:\\srv\\p\\a.js", path.win32), false);
    assert.equal(isInside("C:\\srv\\p", "c:\\SRV\\P\\a.js", path.win32), true);
  });
});

describe("importmapHash (unitaire)", () => {
  test("empreinte sha256 en base64 du texte exact de l'importmap, espaces compris", () => {
    const body = '\n  { "imports": { "three": "/vendor/three.js" } }\n  ';
    const html = `<!doctype html><script type="importmap">${body}</script><script type="module" src="/js/main.js"></script>`;
    assert.equal(importmapHash(html), sha256(body));
  });

  test("ne retient que le script de type importmap (le premier)", () => {
    const html =
      '<script>var a = 1;</script><script type="module">import "x";</script>' +
      "<script type='importmap'>{\"imports\":{}}</script><script type=\"importmap\">{\"imports\":{\"b\":\"/b.js\"}}</script>";
    assert.equal(importmapHash(html), sha256('{"imports":{}}'));
  });

  test("accepte d'autres attributs, la casse des balises et un type sans guillemets", () => {
    assert.equal(importmapHash('<SCRIPT id="m" type=importmap>{}</SCRIPT>'), sha256("{}"));
    assert.equal(importmapHash('<script nonce="x" type = "importmap" >{}</script >'), sha256("{}"));
  });

  test("les fins de ligne CRLF sont normalisées comme le fait le navigateur", () => {
    const lf = '<script type="importmap">\n{\n"imports": {}\n}\n</script>';
    const crlf = lf.replace(/\n/g, "\r\n");
    assert.equal(importmapHash(crlf), importmapHash(lf));
    assert.equal(importmapHash(lf), sha256('\n{\n"imports": {}\n}\n'));
  });

  test("renvoie null sans importmap", () => {
    assert.equal(importmapHash("<html><script>1</script><script type=\"module\" src=\"/a.js\"></script></html>"), null);
    assert.equal(importmapHash('<script data-type="importmap">{}</script>'), null);
    assert.equal(importmapHash('<script type="module">/* importmap */</script>'), null);
    assert.equal(importmapHash(""), null);
  });

  test("calcule l'empreinte du fichier de fixture avec un calcul indépendant", () => {
    const html = fs.readFileSync(path.join(__dirname, "..", "fixtures", "public", "index.html"), "utf8");
    const debut = html.indexOf('<script type="importmap">') + '<script type="importmap">'.length;
    const fin = html.indexOf("</script>", debut);
    assert.ok(debut > 40 && fin > debut, "la fixture contient un importmap");
    assert.equal(importmapHash(html), sha256(html.slice(debut, fin).replace(/\r\n?/g, "\n")));
  });
});

describe("buildCsp (unitaire)", () => {
  test("politique de l'ADR 0005 avec l'empreinte de l'importmap", () => {
    assert.equal(
      buildCsp("sha256-AbC+/="),
      "default-src 'self'; script-src 'self' 'sha256-AbC+/='; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
  });

  test("sans empreinte, aucun script inline n'est autorisé", () => {
    const csp = buildCsp(null);
    assert.equal(
      csp,
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
    );
    assert.ok(!csp.includes("sha256"));
    assert.ok(!csp.includes("unsafe"));
  });
});

describe("buildHeaders (unitaire)", () => {
  const csp = buildCsp(null);

  test("CSP, nosniff et Referrer-Policy sont toujours présents", () => {
    const headers = buildHeaders({ csp });
    assert.equal(headers["Content-Security-Policy"], csp);
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.equal(headers["Referrer-Policy"], "no-referrer");
  });

  test("Cache-Control: no-store seulement sur demande", () => {
    assert.equal(buildHeaders({ csp })["Cache-Control"], undefined);
    assert.equal(buildHeaders({ csp, noStore: true })["Cache-Control"], "no-store");
  });

  test("type, longueur et Allow sont ajoutés quand ils sont fournis", () => {
    const headers = buildHeaders({ csp, contentType: "text/plain", contentLength: 0, allow: "GET, HEAD" });
    assert.equal(headers["Content-Type"], "text/plain");
    assert.equal(headers["Content-Length"], "0");
    assert.equal(headers.Allow, "GET, HEAD");
  });

  test("aucun en-tête CORS", () => {
    const headers = buildHeaders({ csp, contentType: "application/json", contentLength: 10, noStore: true, allow: "GET" });
    for (const name of Object.keys(headers)) assert.ok(!/^access-control-/i.test(name), name);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Écouteur HTTP dans le processus de test
// ---------------------------------------------------------------------------------------------------------------

/** Serveur sur un dossier public temporaire. `state` peut être une fonction qui lève. */
async function listenerSetup(t, { state = () => ({ ok: "etat" }), prepare } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "gepet-http-")));
  const publicDir = path.join(root, "public");
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, "index.html"), "<p>accueil</p>");
  fs.writeFileSync(path.join(root, "secret.json"), '{"secret":"HORS-RACINE"}');
  if (prepare) prepare({ root, publicDir });

  const logs = [];
  let port = 0;
  const csp = buildCsp(null);
  const server = http.createServer(
    createRequestListener({
      getPort: () => port,
      getState: state,
      publicDir,
      csp,
      log: (level, message) => logs.push(`${level} ${message}`),
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = (target, { method = "GET", headers = {} } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: target, method, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("error", reject);
      req.end();
    });
  return { root, publicDir, port, csp, logs, get };
}

describe("createRequestListener (intégration locale)", () => {
  test("sert index.html sur `/` avec le bon type et toutes les protections", async (t) => {
    const { get, csp } = await listenerSetup(t);
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.equal(res.body, "<p>accueil</p>");
    assert.equal(res.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(res.headers["content-security-policy"], csp);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["cache-control"], undefined);
  });

  test("un lien symbolique qui sort du dossier public donne 403 sans fuite", async (t) => {
    const { get } = await listenerSetup(t, {
      prepare: ({ root, publicDir }) => {
        try {
          fs.symlinkSync(path.join(root, "secret.json"), path.join(publicDir, "lien.json"), "file");
        } catch (error) {
          // Sous Windows, créer un lien symbolique demande un privilège : le test est alors sans objet.
          if (error.code === "EPERM" || error.code === "EACCES") t.skip("lien symbolique non autorisé");
          else throw error;
        }
      },
    });
    const res = await get("/lien.json");
    if (res.status === 404) return; // lien non créé (test passé en skip)
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes("HORS-RACINE"));
  });

  test("une jonction ou un lien de dossier qui sort du dossier public donne 403 sans fuite", async (t) => {
    const { get } = await listenerSetup(t, {
      prepare: ({ root, publicDir }) => {
        const dehors = path.join(root, "dehors");
        fs.mkdirSync(dehors);
        fs.writeFileSync(path.join(dehors, "x.json"), '{"secret":"HORS-RACINE"}');
        // « junction » ne demande aucun privilège sous Windows ; ailleurs c'est un lien de dossier ordinaire.
        fs.symlinkSync(dehors, path.join(publicDir, "lien-dossier"), process.platform === "win32" ? "junction" : "dir");
      },
    });
    const res = await get("/lien-dossier/x.json");
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes("HORS-RACINE"));
  });

  test("un lien symbolique vers un fichier du dossier public est servi", async (t) => {
    const { get } = await listenerSetup(t, {
      prepare: ({ publicDir }) => {
        fs.writeFileSync(path.join(publicDir, "vrai.json"), '{"vrai":true}');
        try {
          fs.symlinkSync(path.join(publicDir, "vrai.json"), path.join(publicDir, "alias.json"), "file");
        } catch (error) {
          if (error.code === "EPERM" || error.code === "EACCES") t.skip("lien symbolique non autorisé");
          else throw error;
        }
      },
    });
    const res = await get("/alias.json");
    if (res.status === 404) return;
    assert.equal(res.status, 200);
    assert.equal(res.body, '{"vrai":true}');
  });

  test("un dossier nommé comme un fichier autorisé n'est pas servi (404)", async (t) => {
    const { get } = await listenerSetup(t, {
      prepare: ({ publicDir }) => fs.mkdirSync(path.join(publicDir, "faux.js")),
    });
    assert.equal((await get("/faux.js")).status, 404);
  });

  test("HEAD renvoie les mêmes en-têtes et la même longueur que GET, sans corps", async (t) => {
    const { get } = await listenerSetup(t);
    const getRes = await get("/");
    const headRes = await get("/", { method: "HEAD" });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.body, "");
    assert.equal(headRes.headers["content-length"], getRes.headers["content-length"]);
    assert.equal(headRes.headers["content-length"], String(Buffer.byteLength("<p>accueil</p>")));
    assert.equal(headRes.headers["content-security-policy"], getRes.headers["content-security-policy"]);
  });

  test("/state et /health : JSON, no-store, et la requête est ignorée", async (t) => {
    const { get } = await listenerSetup(t, { state: () => ({ repo: "o/r" }) });
    const state = await get("/state?cache=1");
    assert.equal(state.status, 200);
    assert.deepEqual(JSON.parse(state.body), { repo: "o/r" });
    assert.equal(state.headers["cache-control"], "no-store");
    assert.equal(state.headers["content-type"], "application/json; charset=utf-8");
    const health = await get("/health");
    assert.deepEqual(JSON.parse(health.body), { ok: true, pid: process.pid }, "/health porte le pid du serveur");
    assert.equal(health.headers["cache-control"], "no-store");
  });

  test("/state/ et /health/x ne sont pas des routes : fichier statique, donc 404", async (t) => {
    const { get } = await listenerSetup(t);
    assert.equal((await get("/state/")).status, 404);
    assert.equal((await get("/health/x")).status, 404);
  });

  test("une erreur interne donne 500 générique, le détail reste dans le journal du serveur", async (t) => {
    const { get, logs } = await listenerSetup(t, {
      state: () => {
        throw new Error("DETAIL-INTERNE-SECRET");
      },
    });
    const res = await get("/state");
    assert.equal(res.status, 500);
    assert.ok(!res.body.includes("DETAIL-INTERNE-SECRET"));
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.ok(logs.some((line) => line.includes("DETAIL-INTERNE-SECRET")));
  });

  test("le Host est contrôlé avant la méthode et avant la route", async (t) => {
    const { get } = await listenerSetup(t);
    assert.equal((await get("/state", { headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await get("/state", { method: "POST", headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await get("/state", { method: "POST" })).status, 405);
  });

  test("les messages d'erreur ne reprennent jamais la cible de la requête", async (t) => {
    const { get } = await listenerSetup(t);
    const res = await get("/%3Cscript%3Ealert(1)%3C/script%3E.html");
    assert.equal(res.status, 404);
    assert.ok(!res.body.includes("script"));
    assert.ok(res.headers["content-type"].startsWith("text/plain"));
  });
});
