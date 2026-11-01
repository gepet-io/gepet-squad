// La page servie par viz-server (viz/public/index.html) : CSP, importmap unique, imports résolubles, interdits de l'ADR 0005
// (HTML interprété) et de l'ADR 0006 (pas de logique de décision dans les modules qui importent `three`).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { INDEX_HTML, PUBLIC_DIR, importmapOf, inlineScripts, scriptsOf } from "./importmap.mjs";

const require = createRequire(import.meta.url);
const { importmapHash, buildCsp, resolveStaticPath } = require("../../viz/lib/http.cjs");

const JS_DIR = path.join(PUBLIC_DIR, "js");
const html = fs.readFileSync(INDEX_HTML, "utf8");
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith(".js")).sort();

// Le code source sans commentaires (ils peuvent citer innerHTML, three, etc.).
function code(file) {
  return fs
    .readFileSync(path.join(JS_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

function specifiers(source) {
  const found = [...source.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  found.push(...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]));
  found.push(...[...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]));
  return found;
}

describe("index.html : CSP de l'ADR 0005", () => {
  test("l'importmap est le seul script en ligne de la page", () => {
    const inline = inlineScripts(html);
    assert.equal(inline.length, 1);
    assert.match(inline[0].attributes, /type\s*=\s*"importmap"/);
  });

  test("l'importmap déclare `three` et `three/addons/`, vers des fichiers qui existent", () => {
    const { imports } = importmapOf(html);
    assert.deepEqual(Object.keys(imports).sort(), ["three", "three/addons/"]);
    assert.ok(fs.statSync(path.join(PUBLIC_DIR, imports.three)).isFile());
    assert.ok(fs.statSync(path.join(PUBLIC_DIR, imports["three/addons/"], "controls/OrbitControls.js")).isFile());
    assert.ok(fs.statSync(path.join(PUBLIC_DIR, imports["three/addons/"], "renderers/CSS2DRenderer.js")).isFile());
  });

  test("main.js est chargé en module, après l'importmap (sinon l'importmap serait ignoré)", () => {
    const scripts = scriptsOf(html);
    const importmapAt = scripts.findIndex((s) => /type\s*=\s*"importmap"/.test(s.attributes));
    const mainAt = scripts.findIndex((s) => /src\s*=\s*"js\/main\.js"/.test(s.attributes));
    assert.ok(importmapAt >= 0 && mainAt >= 0);
    assert.match(scripts[mainAt].attributes, /type\s*=\s*"module"/);
    assert.ok(importmapAt < mainAt, "l'importmap doit précéder le premier module");
    assert.equal(scripts.length, 2);
  });

  test("l'empreinte de l'importmap calculée par le serveur autorise exactement ce script, et aucun autre script en ligne", () => {
    const hash = importmapHash(html);
    assert.match(hash, /^sha256-[A-Za-z0-9+/]+=*$/);
    const text = inlineScripts(html)[0].text.replace(/\r\n?/g, "\n");
    assert.equal(hash, "sha256-" + crypto.createHash("sha256").update(text, "utf8").digest("base64"));
    const csp = buildCsp(hash);
    assert.ok(csp.includes(`script-src 'self' '${hash}';`), csp);
    assert.match(csp, /style-src 'self'(;|$)/, "pas de style en ligne autorisé");
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  });

  test("aucun style en ligne, aucun gestionnaire d'événement en ligne, aucune ressource externe", () => {
    assert.doesNotMatch(html, /<style\b/i);
    assert.doesNotMatch(html, /\sstyle\s*=/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /javascript:/i);
    assert.doesNotMatch(html, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
  });

  test("les fichiers référencés sont servis par la liste blanche de viz/lib/http.cjs", () => {
    const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"#]+)"/g)].map((m) => m[1]).filter((ref) => !ref.startsWith("data:"));
    assert.ok(refs.includes("css/app.css") && refs.includes("css/fallback.css") && refs.includes("js/main.js"));
    for (const ref of refs) {
      const served = resolveStaticPath(PUBLIC_DIR, "/" + ref);
      assert.equal(served.status, 200, ref);
      assert.ok(fs.statSync(served.file).isFile(), `${ref} existe`);
    }
    assert.equal(resolveStaticPath(PUBLIC_DIR, "/").file, INDEX_HTML);
  });

  test("la page a les éléments dont main.js a besoin", () => {
    for (const id of ["connexion", "depot", "scene", "legende", "repli"]) {
      assert.match(html, new RegExp(`id="${id}"`), `#${id}`);
    }
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /id="repli"[^>]*\shidden/, "le repli texte est masqué tant que la scène fonctionne");
  });

  test("les feuilles de style ne chargent rien d'externe", () => {
    for (const file of ["css/app.css", "css/fallback.css"]) {
      const css = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
      assert.doesNotMatch(css, /@import|url\(\s*["']?(?:https?:)?\/\//i, file);
    }
  });
});

describe("modules de js/ : imports", () => {
  const importmap = importmapOf(html).imports;

  for (const file of jsFiles) {
    test(`${file} : chaque import est relatif et existe, ou résolu par l'importmap`, () => {
      for (const specifier of specifiers(code(file))) {
        if (specifier.startsWith("./")) {
          assert.ok(fs.existsSync(path.join(JS_DIR, specifier)), `${file} importe ${specifier}, absent`);
          assert.ok(resolveStaticPath(PUBLIC_DIR, "/js/" + specifier.slice(2)).status === 200, `${specifier} n'est pas servi`);
        } else {
          const prefix = Object.keys(importmap).find((k) => specifier === k || (k.endsWith("/") && specifier.startsWith(k)));
          assert.ok(prefix, `${file} : import « ${specifier} » absent de l'importmap`);
          assert.ok(fs.existsSync(path.join(PUBLIC_DIR, importmap[prefix] + (prefix.endsWith("/") ? specifier.slice(prefix.length) : ""))), `${specifier} introuvable`);
        }
      }
    });
  }

  test("main.js, scene.js, labels.js, ui.js, fallback.js, view-model.js et sync.js existent (et chaque module a un seul rôle)", () => {
    for (const file of ["main.js", "scene.js", "labels.js", "ui.js", "fallback.js", "view-model.js", "sync.js", "state.js", "layout.js"]) {
      assert.ok(jsFiles.includes(file), file);
    }
  });
});

describe("modules de js/ : interdits", () => {
  for (const file of jsFiles) {
    test(`${file} : HTML jamais interprété, ni eval`, () => {
      const source = code(file);
      assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\b/);
      assert.doesNotMatch(source, /insertAdjacentHTML|document\.write|\bDOMParser\b|createContextualFragment|srcdoc/);
      assert.doesNotMatch(source, /\beval\s*\(|new\s+Function\s*\(/);
      assert.doesNotMatch(source, /setAttribute\(\s*["']style["']/, "un attribut style est refusé par la CSP");
      assert.doesNotMatch(source, /\bcssText\b/);
    });
  }

  test("seuls scene.js et labels.js importent `three` ; ils ne dépendent pas de state.js (ils ne décident rien)", () => {
    const importers = jsFiles.filter((file) => specifiers(code(file)).some((s) => s === "three" || s.startsWith("three/")));
    assert.deepEqual(importers, ["labels.js", "scene.js"]);
    for (const file of importers) {
      const imports = specifiers(code(file));
      assert.ok(!imports.includes("./state.js"), `${file} importe state.js`);
      assert.ok(imports.includes("./view-model.js") || imports.includes("./layout.js"), `${file} doit s'appuyer sur un module pur`);
    }
  });

  test("scene.js et labels.js ne contiennent ni table de couleurs ni règle de statut ou de station", () => {
    for (const file of ["scene.js", "labels.js"]) {
      const source = code(file);
      assert.doesNotMatch(source, /\b(?:backlog|in-progress|in-review|in-test|changes-requested|blocked)\b/, `${file} : statut en dur`);
      assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${file} : couleur CSS en dur`);
      assert.doesNotMatch(source, /\.status\b|\.station\s*===|\.escalated\s*\?/, `${file} : règle de statut ou de station`);
    }
  });

  test("main.js ne charge `three` qu'à la demande : aucun import statique de scene.js ni de labels.js", () => {
    const source = code("main.js");
    const statics = [...source.matchAll(/^import\b[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(statics.sort(), ["./fallback.js", "./state.js", "./sync.js", "./ui.js"]);
    assert.match(source, /import\(\s*"\.\/scene\.js"\s*\)/);
    assert.match(source, /import\(\s*"\.\/labels\.js"\s*\)/);
  });
});
