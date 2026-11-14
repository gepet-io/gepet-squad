// Vendoring de Three.js (ADR 0002) : viz/public/vendor/three/ doit être complet, à la version épinglée, et
// autonome : aucun import ne doit pointer vers un fichier absent (le navigateur n'a ni build ni CDN).
//
// Les imports sont résolus comme le fera le navigateur avec l'importmap prévu par l'ADR 0002 :
//   "three"          → ./vendor/three/build/three.module.js
//   "three/addons/"  → ./vendor/three/addons/
// Les imports relatifs se résolvent depuis le fichier qui les contient.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pageImports } from "./importmap.mjs";

const require = createRequire(import.meta.url);
const { resolveStaticPath } = require("../../viz/lib/http.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PUBLIC_DIR = path.join(ROOT, "viz/public");
const VENDOR_DIR = path.join(PUBLIC_DIR, "vendor/three");
const SCRIPT = path.join(ROOT, "scripts/vendor-three.sh");

const PINNED = "0.187.0";
// L'importmap est lu dans viz/public/index.html (la page est la seule source) ; un test vérifie qu'il correspond à l'ADR 0002.
const IMPORTMAP = Object.freeze(pageImports());

// Fichiers attendus, relatifs à vendor/three/. Cette liste est volontairement écrite en dur (et non lue dans le
// script) : elle est le contrat du dossier, le script doit la produire.
const EXPECTED_FILES = [
  "LICENSE",
  "VERSION",
  "build/three.core.js",
  "build/three.module.js",
  "addons/controls/OrbitControls.js",
  "addons/loaders/GLTFLoader.js",
  "addons/utils/SkeletonUtils.js",
  "addons/utils/BufferGeometryUtils.js",
  "addons/renderers/CSS2DRenderer.js",
];

// Points d'entrée : ce que le front importera. Tout le reste doit être atteignable depuis eux.
const ENTRY_POINTS = [
  "build/three.module.js",
  "addons/controls/OrbitControls.js",
  "addons/loaders/GLTFLoader.js",
  "addons/utils/SkeletonUtils.js",
  "addons/renderers/CSS2DRenderer.js",
];

/** Tous les fichiers sous `dir`, en chemins relatifs avec `/`, triés. */
function listFiles(dir, prefix = "") {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), rel + "/"));
    else found.push(rel);
  }
  return found.sort();
}

/**
 * Spécificateurs d'import d'un module ES. Les formes statiques sont reconnues en début de ligne (ce qui écarte les
 * exemples `@three_import import … from …` des commentaires JSDoc, qui commencent par ` * `). Les imports dynamiques
 * dont l'argument n'est pas une chaîne littérale sont rapportés tels quels pour être refusés.
 * @returns {string[]}
 */
function importSpecifiers(source) {
  const specifiers = [];
  for (const m of source.matchAll(/^(?:import|export)\b[^;'"`]*?\bfrom\s*(['"])([^'"\n]+)\1/gm)) specifiers.push(m[2]);
  for (const m of source.matchAll(/^import\s*(['"])([^'"\n]+)\1/gm)) specifiers.push(m[2]);
  for (const m of source.matchAll(/(?<![.\w$])import\s*\(\s*([^)]*?)\s*\)/g)) {
    const literal = /^(['"])([^'"\n]+)\1$/.exec(m[1]);
    specifiers.push(literal ? literal[2] : `<import dynamique non littéral : ${m[1]}>`);
  }
  return specifiers;
}

/** Fichier désigné par un spécificateur depuis `fromFile`, ou `{ error }`. Résout comme le navigateur + importmap. */
function resolveSpecifier(specifier, fromFile, publicDir, importmap) {
  let target;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    target = path.resolve(path.dirname(fromFile), specifier);
  } else if (Object.hasOwn(importmap, specifier)) {
    target = path.resolve(publicDir, importmap[specifier]);
  } else {
    const prefix = Object.keys(importmap).find((key) => key.endsWith("/") && specifier.startsWith(key));
    if (prefix === undefined) return { error: `spécificateur sans correspondance dans l'importmap : ${specifier}` };
    target = path.resolve(publicDir, importmap[prefix] + specifier.slice(prefix.length));
  }
  const relative = path.relative(publicDir, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { error: `sort de viz/public : ${specifier}` };
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return { error: `fichier absent : ${specifier}` };
  return { file: target };
}

/**
 * Parcourt récursivement les imports depuis `entries` (chemins absolus).
 * @returns {{ visited: Set<string>, errors: string[] }} `visited` : fichiers atteints ; `errors` : imports cassés.
 */
function walkImports(entries, publicDir, importmap) {
  const visited = new Set();
  const errors = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    for (const specifier of importSpecifiers(fs.readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file, publicDir, importmap);
      if ("error" in resolved) errors.push(`${path.relative(publicDir, file)} : ${resolved.error}`);
      else queue.push(resolved.file);
    }
  }
  return { visited, errors };
}

describe("contenu de viz/public/vendor/three", () => {
  test("VERSION vaut la version épinglée 0.187.0", () => {
    assert.equal(fs.readFileSync(path.join(VENDOR_DIR, "VERSION"), "utf8"), `${PINNED}\n`);
  });

  test("le build embarque bien la révision 187 de Three.js", () => {
    const core = fs.readFileSync(path.join(VENDOR_DIR, "build/three.core.js"), "utf8");
    assert.match(core, /^const REVISION = '187';$/m);
  });

  test("LICENSE est la licence MIT de Three.js", () => {
    const license = fs.readFileSync(path.join(VENDOR_DIR, "LICENSE"), "utf8");
    assert.match(license, /^The MIT License/);
    assert.match(license, /three\.js authors/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS"/);
  });

  for (const file of EXPECTED_FILES) {
    test(`${file} est présent et non vide`, () => {
      const stat = fs.statSync(path.join(VENDOR_DIR, file));
      assert.ok(stat.isFile(), `${file} n'est pas un fichier`);
      assert.ok(stat.size > 0, `${file} est vide`);
    });
  }

  test("le dossier ne contient que les fichiers attendus", () => {
    assert.deepEqual(listFiles(VENDOR_DIR), [...EXPECTED_FILES].sort());
  });

  test("three.module.js se charge sous Node et expose la révision 187", async () => {
    const three = await import(pathToFileURL(path.join(VENDOR_DIR, "build/three.module.js")).href);
    assert.equal(three.REVISION, "187");
    assert.equal(typeof three.WebGLRenderer, "function");
    assert.equal(typeof three.InstancedMesh, "function");
  });
});

describe("résolution des imports (importmap de l'ADR 0002)", () => {
  const entries = ENTRY_POINTS.map((file) => path.join(VENDOR_DIR, file));

  test("l'importmap de index.html est exactement celui de l'ADR 0002 (three et three/addons/)", () => {
    assert.deepEqual(IMPORTMAP, {
      three: "./vendor/three/build/three.module.js",
      "three/addons/": "./vendor/three/addons/",
    });
  });

  test("aucun import ne pointe vers un chemin absent du dossier", () => {
    const { errors } = walkImports(entries, PUBLIC_DIR, IMPORTMAP);
    assert.deepEqual(errors, []);
  });

  test("les imports sont réellement parcourus (three.core.js et BufferGeometryUtils.js sont atteints)", () => {
    const { visited } = walkImports(entries, PUBLIC_DIR, IMPORTMAP);
    const reached = [...visited].map((file) => path.relative(VENDOR_DIR, file).split(path.sep).join("/"));
    assert.ok(reached.includes("build/three.core.js"), "three.core.js doit être atteint via three.module.js");
    assert.ok(reached.includes("addons/utils/BufferGeometryUtils.js"), "BufferGeometryUtils.js doit être atteint via GLTFLoader.js");
  });

  test("tous les fichiers JavaScript vendorés sont atteignables depuis les points d'entrée", () => {
    const { visited } = walkImports(entries, PUBLIC_DIR, IMPORTMAP);
    const orphans = EXPECTED_FILES.filter((file) => file.endsWith(".js")).filter(
      (file) => !visited.has(path.join(VENDOR_DIR, file)),
    );
    assert.deepEqual(orphans, []);
  });

  test("un import 'three' dans un addon est résolu par l'importmap vers three.module.js", () => {
    const orbit = path.join(VENDOR_DIR, "addons/controls/OrbitControls.js");
    assert.deepEqual(resolveSpecifier("three", orbit, PUBLIC_DIR, IMPORTMAP), {
      file: path.join(VENDOR_DIR, "build/three.module.js"),
    });
    assert.deepEqual(resolveSpecifier("three/addons/utils/BufferGeometryUtils.js", orbit, PUBLIC_DIR, IMPORTMAP), {
      file: path.join(VENDOR_DIR, "addons/utils/BufferGeometryUtils.js"),
    });
  });
});

describe("le vérificateur d'imports détecte les imports cassés (jeu de fichiers factice)", () => {
  function withFixture(files, run) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-check-"));
    try {
      for (const [name, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), content);
      }
      return run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const map = { three: "./vendor/three/build/three.module.js", "three/addons/": "./vendor/three/addons/" };

  test("import relatif manquant, addon manquant, paquet inconnu, URL, sortie du dossier public, import dynamique", () => {
    const files = {
      "vendor/three/build/three.module.js": "export const a = 1;\n",
      "vendor/three/addons/a.js": [
        "import { a } from 'three';",
        "import { b } from './absent.js';",
        "export { c } from 'three/addons/absent.js';",
        "import 'lodash';",
        "import { d } from 'https://cdn.example.com/d.js';",
        "import { e } from '../../../../../etc/e.js';",
        "const f = () => import('./dynamique-absent.js');",
        "const g = (x) => import(x);",
        "",
      ].join("\n"),
    };
    withFixture(files, (dir) => {
      const { errors } = walkImports([path.join(dir, "vendor/three/addons/a.js")], dir, map);
      assert.equal(errors.length, 7, errors.join("\n"));
      const expected = [
        /fichier absent : \.\/absent\.js/,
        /fichier absent : three\/addons\/absent\.js/,
        /sans correspondance dans l'importmap : lodash/,
        /sans correspondance dans l'importmap : https:/,
        /sort de viz\/public/,
        /fichier absent : \.\/dynamique-absent\.js/,
        /import dynamique non littéral/,
      ];
      for (const pattern of expected) assert.ok(errors.some((e) => pattern.test(e)), `erreur attendue : ${pattern}`);
    });
  });

  test("les imports valides (relatifs, importmap, multi-lignes, side-effect) ne produisent aucune erreur", () => {
    const files = {
      "vendor/three/build/three.module.js": "export const a = 1;\n",
      "vendor/three/addons/shaders/s.js": "export const s = 1;\n",
      "vendor/three/addons/a.js": [
        "import {",
        "  a,",
        "} from 'three';",
        "import { s } from './shaders/s.js';",
        "import './shaders/s.js';",
        "export * from \"three/addons/shaders/s.js\";",
        "/** @three_import import { x } from 'three/addons/ne-pas-suivre.js'; */",
        " * import { y } from './ne-pas-suivre-non-plus.js';",
        "",
      ].join("\n"),
    };
    withFixture(files, (dir) => {
      const { errors, visited } = walkImports([path.join(dir, "vendor/three/addons/a.js")], dir, map);
      assert.deepEqual(errors, []);
      assert.equal(visited.size, 3);
    });
  });
});

describe("service par viz-server et script de vendoring", () => {
  test("tous les modules .js vendorés sont servis par la liste blanche de viz/lib/http.cjs en text/javascript", () => {
    const modules = EXPECTED_FILES.filter((file) => file.endsWith(".js"));
    assert.ok(modules.length > 0);
    for (const file of modules) {
      const result = resolveStaticPath(PUBLIC_DIR, `/vendor/three/${file}`);
      assert.equal(result.status, 200, `/vendor/three/${file} doit être servi`);
      assert.equal(result.mime, "text/javascript; charset=utf-8");
      assert.equal(result.file, path.join(VENDOR_DIR, file));
    }
  });

  test("scripts/vendor-three.sh épingle la même version que VERSION et liste chaque addon vendoré", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    assert.match(script, /^PINNED_VERSION="0\.187\.0"$/m);
    assert.match(script, /^set -euo pipefail$/m);
    assert.match(script, /npm pack "three@\$VERSION"/);
    for (const file of EXPECTED_FILES.filter((f) => f.startsWith("addons/"))) {
      assert.ok(script.includes(file.slice("addons/".length)), `${file} absent de la liste ADDONS du script`);
    }
  });
});

describe("addons de chargement glTF (ADR 0010)", () => {
  const GLTF_ADDONS = [
    "addons/loaders/GLTFLoader.js",
    "addons/utils/SkeletonUtils.js",
    "addons/utils/BufferGeometryUtils.js",
  ];

  for (const file of GLTF_ADDONS) {
    test(`${file} : chaque import pointe vers un fichier vendoré`, () => {
      const full = path.join(VENDOR_DIR, file);
      const specifiers = importSpecifiers(fs.readFileSync(full, "utf8"));
      assert.ok(specifiers.includes("three"), "l'addon doit importer three");
      for (const specifier of specifiers) {
        const resolved = resolveSpecifier(specifier, full, PUBLIC_DIR, IMPORTMAP);
        assert.ok("file" in resolved, `${file} : ${resolved.error}`);
        assert.ok(resolved.file.startsWith(VENDOR_DIR + path.sep), `${specifier} sort de vendor/three`);
      }
    });

    test(`${file} : licence MIT conservée (en-tête éventuel du fichier non retiré, LICENSE du paquet présent)`, () => {
      const source = fs.readFileSync(path.join(VENDOR_DIR, file), "utf8");
      // Three.js 0.187.0 ne met pas d'en-tête de licence dans ces addons : la licence MIT est portée par vendor/three/LICENSE.
      // Si un en-tête de commentaire est présent en tête de fichier, il doit rester celui de Three.js (MIT).
      const header = /^\s*\/\*[\s\S]*?\*\//.exec(source);
      if (header !== null && /licen[sc]e|copyright/i.test(header[0])) assert.match(header[0], /MIT/);
      assert.match(fs.readFileSync(path.join(VENDOR_DIR, "LICENSE"), "utf8"), /^The MIT License/);
    });
  }

  test("GLTFLoader importe SkeletonUtils et BufferGeometryUtils, tous deux vendorés", () => {
    const full = path.join(VENDOR_DIR, "addons/loaders/GLTFLoader.js");
    const specifiers = importSpecifiers(fs.readFileSync(full, "utf8"));
    assert.ok(specifiers.includes("../utils/BufferGeometryUtils.js"));
    assert.ok(specifiers.includes("../utils/SkeletonUtils.js"));
  });

  test("les imports de la page se résolvent : three/addons/loaders/GLTFLoader.js et three/addons/utils/SkeletonUtils.js", () => {
    const page = path.join(PUBLIC_DIR, "index.html");
    for (const [spec, rel] of [
      ["three/addons/loaders/GLTFLoader.js", "addons/loaders/GLTFLoader.js"],
      ["three/addons/utils/SkeletonUtils.js", "addons/utils/SkeletonUtils.js"],
    ]) {
      assert.deepEqual(resolveSpecifier(spec, page, PUBLIC_DIR, IMPORTMAP), { file: path.join(VENDOR_DIR, rel) });
    }
  });

  test("three reste en 0.187.0 et les addons existants sont toujours présents", () => {
    assert.equal(fs.readFileSync(path.join(VENDOR_DIR, "VERSION"), "utf8"), `0.187.0${"\n"}`);
    for (const file of ["addons/controls/OrbitControls.js", "addons/loaders/GLTFLoader.js", "addons/renderers/CSS2DRenderer.js"]) {
      assert.ok(fs.existsSync(path.join(VENDOR_DIR, file)), `${file} doit rester vendoré`);
    }
  });

  test("le bloom est retiré : ni postprocessing/, ni les shaders CopyShader, LuminosityHighPassShader et OutputShader, ni dans le script", () => {
    assert.ok(!fs.existsSync(path.join(VENDOR_DIR, "addons/postprocessing")), "addons/postprocessing/ ne doit plus exister");
    assert.ok(!fs.existsSync(path.join(VENDOR_DIR, "addons/shaders")), "addons/shaders/ ne doit plus exister");
    const script = fs.readFileSync(new URL("../../scripts/vendor-three.sh", import.meta.url), "utf8");
    assert.doesNotMatch(script, /postprocessing\/|CopyShader|LuminosityHighPassShader|OutputShader/);
  });
});
