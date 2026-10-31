// Importmap de la page : lu dans viz/public/index.html (la seule source), jamais recopié dans les tests.
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PUBLIC_DIR = path.join(ROOT, "viz/public");
export const INDEX_HTML = path.join(PUBLIC_DIR, "index.html");

/** Les balises `<script>` d'un document : { attributes, text }. */
export function scriptsOf(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].map((m) => ({ attributes: m[1], text: m[2] }));
}

/** Les scripts en ligne (sans `src`) de la page. */
export function inlineScripts(html) {
  return scriptsOf(html).filter((s) => !/\bsrc\s*=/i.test(s.attributes));
}

/** L'importmap déclaré dans le HTML : `{ imports: { spécificateur: chemin } }`. Lève si absent. */
export function importmapOf(html) {
  const found = scriptsOf(html).find((s) => /\btype\s*=\s*["']?importmap["']?/i.test(s.attributes));
  if (!found) throw new Error("aucun <script type=\"importmap\"> dans la page");
  return JSON.parse(found.text);
}

/** `imports` de l'importmap de viz/public/index.html. */
export function pageImports() {
  return importmapOf(fs.readFileSync(INDEX_HTML, "utf8")).imports;
}
