// Installe le crochet de résolution de `three` (voir three-hooks.mjs). À importer en premier ; les modules qui importent
// `three` (scene.js, labels.js) doivent ensuite être chargés par `import()` dynamique.
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).
import { register } from "node:module";

register("./three-hooks.mjs", import.meta.url);
