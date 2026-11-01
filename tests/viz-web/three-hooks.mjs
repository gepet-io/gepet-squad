// Crochet de résolution de modules (node:module `register`) : sous Node, résout `three` et `three/addons/…` comme le fera
// le navigateur avec l'importmap de viz/public/index.html, pour pouvoir charger scene.js et labels.js dans les tests.
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PUBLIC_DIR, pageImports } from "./importmap.mjs";

const imports = pageImports();

export async function resolve(specifier, context, nextResolve) {
  let target = null;
  if (Object.hasOwn(imports, specifier)) {
    target = path.resolve(PUBLIC_DIR, imports[specifier]);
  } else {
    const prefix = Object.keys(imports).find((key) => key.endsWith("/") && specifier.startsWith(key));
    if (prefix !== undefined) target = path.resolve(PUBLIC_DIR, imports[prefix] + specifier.slice(prefix.length));
  }
  if (target === null) return nextResolve(specifier, context);
  return { url: pathToFileURL(target).href, shortCircuit: true };
}
