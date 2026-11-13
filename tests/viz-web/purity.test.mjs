// Pureté de viz/public/js/state.js, layout.js, view-model.js, sync.js, fallback.js et motion.js (ADR 0006) : ni `three`, ni DOM, ni hasard, ni horloge.
// Deux contrôles complémentaires :
//   - analyse du code source : seuls des imports relatifs, aucun identifiant du navigateur ;
//   - exécution dans Node avec des pièges sur les globales du navigateur : tout accès à `document`, `window`, etc.
//     pendant le chargement ou l'appel des fonctions fait échouer le test.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { at, ev, sse, stateOf, feature, agent, assertPure, jsCode as code, withBrowserTraps, JS_DIR } from "./support.mjs";

const MODULES = ["state.js", "layout.js", "view-model.js", "sync.js", "fallback.js", "motion.js"];

describe("analyse du code source", () => {
  for (const file of MODULES) {
    test(`${file} est pur : imports relatifs, jamais three, aucune globale du navigateur, ni hasard, ni horloge`, async () => {
      await assertPure(file);
    });
  }

  test("layout.js ne dépend que de state.js et d'office-layout.js, et state.js de rien", () => {
    assert.doesNotMatch(code("state.js"), /^\s*import\b/m);
    const imports = [...code("layout.js").matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(imports, ["./state.js", "./office-layout.js"]);
  });
});

describe("chargement et exécution dans Node", () => {
  test("les modules se chargent et fonctionnent avec toutes les globales du navigateur piégées", async () => {
    await withBrowserTraps(async () => {
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
    });
  });
});
