// Pureté de viz/public/js/state.js, layout.js, view-model.js, sync.js et fallback.js (ADR 0006) : ni `three`, ni DOM, ni hasard, ni horloge.
// Deux contrôles complémentaires :
//   - analyse du code source : seuls des imports relatifs, aucun identifiant du navigateur ;
//   - exécution dans Node avec des pièges sur les globales du navigateur : tout accès à `document`, `window`, etc.
//     pendant le chargement ou l'appel des fonctions fait échouer le test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { at, ev, sse, stateOf, feature, agent } from "./support.mjs";

const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../viz/public/js");
const MODULES = ["state.js", "layout.js", "view-model.js", "sync.js", "fallback.js"];

// Le code source sans commentaires (les commentaires peuvent citer `three` ou le DOM).
function code(file) {
  return fs
    .readFileSync(path.join(JS_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

const BROWSER_GLOBALS = [
  "document",
  "window",
  "self",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setTimeout",
  "setInterval",
  "fetch",
  "EventSource",
  "HTMLElement",
  "WebGLRenderingContext",
  "globalThis",
];

describe("analyse du code source", () => {
  for (const file of MODULES) {
    test(`${file} n'importe que des modules relatifs, jamais three`, () => {
      const source = code(file);
      const specifiers = [...source.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
      specifiers.push(...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]));
      for (const specifier of specifiers) {
        assert.match(specifier, /^\.\//, `import non relatif dans ${file} : ${specifier}`);
        assert.doesNotMatch(specifier, /three/i);
      }
      assert.doesNotMatch(source, /\bimport\s*\(/, "pas d'import dynamique");
      assert.doesNotMatch(source, /\brequire\s*\(/, "pas de require");
      assert.doesNotMatch(source, /\bthree\b/i, "aucune référence à three dans le code");
    });

    test(`${file} ne référence aucune globale du navigateur, ni hasard, ni horloge implicite`, () => {
      const source = code(file);
      for (const name of BROWSER_GLOBALS) {
        assert.doesNotMatch(source, new RegExp(`(?<![\\w.$])${name}\\b`), `${file} référence ${name}`);
      }
      assert.doesNotMatch(source, /\bDate\.now\s*\(/);
      assert.doesNotMatch(source, /\bMath\.random\s*\(/);
      assert.doesNotMatch(source, /\bnew Date\s*\(\s*\)/);
      assert.doesNotMatch(source, /\bperformance\./);
    });
  }

  test("layout.js ne dépend que de state.js, et state.js de rien", () => {
    assert.doesNotMatch(code("state.js"), /^\s*import\b/m);
    const imports = [...code("layout.js").matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./state.js"]);
  });
});

describe("chargement et exécution dans Node", () => {
  test("les modules se chargent et fonctionnent avec toutes les globales du navigateur piégées", async () => {
    const traps = BROWSER_GLOBALS.filter((n) => !["setTimeout", "setInterval", "fetch", "globalThis", "self"].includes(n));
    const saved = new Map(traps.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
    for (const name of traps) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          throw new Error(`accès interdit à la globale du navigateur « ${name} »`);
        },
      });
    }
    try {
      const state = await import(pathToFileURL(path.join(JS_DIR, "state.js")).href);
      const layout = await import(pathToFileURL(path.join(JS_DIR, "layout.js")).href);

      let model = state.init(stateOf({ features: [feature(1, "ready"), feature(2, "in-progress")], agents: [agent("a", { issue: 2 })] }));
      for (const message of [
        sse("evt", ev("feature.status", 1, { issue: 1, status: "blocked" })),
        sse("evt", ev("agent.requested", 2, { toolUseId: "t", agentType: "claude-gepet-squad:testeur", issue: 2 })),
        sse("evt", ev("milestone.changed", 3, { ref: "1", status: "closed" })),
        sse("warning", { code: "GH_AUTH", message: "m", at: at(1) }),
        sse("snapshot", stateOf({ features: [feature(3, "done")] })),
      ]) {
        model = state.apply(model, message).model;
      }
      model = state.tick(model, at(120)).model;
      const scene = layout.layoutScene(model);

      for (const name of ["init", "apply", "tick", "diff"]) assert.equal(typeof state[name], "function", `state.${name}`);
      for (const name of ["layoutFeatures", "layoutAgents", "layoutScene", "stationBoxes"]) assert.equal(typeof layout[name], "function", `layout.${name}`);
      assert.equal(scene.features.size, 1);
      assert.equal(scene.stations.length, 7);
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  });
});
