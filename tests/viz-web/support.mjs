// Aides communes aux tests de viz-web : construction d'états `/state`, d'événements v1 et de messages SSE.
// Ce fichier n'est pas un test (il ne porte pas le suffixe `.test.mjs`).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const T0 = Date.parse("2026-10-30T10:00:00.000Z");
export const MIN = 60 * 1000;
export const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();

export const SESSION = "session-1";
export const DEV = "claude-gepet-squad:developpeur";
export const VERIF = "claude-gepet-squad:verificateur";
export const TEST = "claude-gepet-squad:testeur";
export const ARCHI = "claude-gepet-squad:architecte";

export const M1 = "M1 — Socle";
export const M2 = "M2 — API";

// Événement v1 ; `minutes` est le décalage par rapport à T0.
export function ev(type, minutes, fields = {}) {
  return { v: 1, ts: at(minutes), src: "hook", type, sessionId: SESSION, ...fields };
}

// Messages SSE tels que les produira viz-server (#8) : le nom de l'événement SSE, et une `data` qui est une chaîne JSON
// (format strict de state.js : le client appelle `apply(model, { event: e.type, data: e.data })`).
export const sse = (event, data) => ({ event, data: JSON.stringify(data) });
export const evt = (type, minutes, fields) => sse("evt", ev(type, minutes, fields));
export const snapshotMsg = (state) => sse("snapshot", state);
export const warningMsg = (data) => sse("warning", data);

// Feature au format `/state`, sans station (elle est calculée par `init`).
export function feature(number, status, extra = {}) {
  return { number, title: `Feature ${number}`, milestone: M1, status, retry: 0, pr: null, ...extra };
}

// Agent au format `/state`.
export function agent(id, extra = {}) {
  return {
    id, type: "developpeur", mode: null, issue: null, pr: null, attempt: null, station: "dev", phase: "running",
    since: at(0), updatedAt: at(0), finishedAt: null, verdict: null, block: null, agentId: null, toolUseId: id,
    ...extra,
  };
}

export function milestone(number, title, state = "open") {
  return { number, title, state, total: 0, done: 0 };
}

// État `/state` minimal.
export function stateOf(extra = {}) {
  return {
    repo: "o/r",
    updatedAt: at(0),
    milestones: [milestone(1, M1), milestone(2, M2)],
    features: [],
    agents: [],
    releases: [],
    warnings: [],
    ...extra,
  };
}

export function deepFreeze(value) {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// --- Contrôle de pureté des modules de viz/public/js (ADR 0006) ---------------------------------------------------------
// Deux contrôles complémentaires : analyse du code source (imports relatifs seulement, aucun identifiant du navigateur,
// ni hasard, ni horloge) et exécution dans Node avec des pièges sur les globales du navigateur.

export const JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../viz/public/js");

export const BROWSER_GLOBALS = [
  "document", "window", "self", "navigator", "location", "localStorage", "sessionStorage", "requestAnimationFrame",
  "cancelAnimationFrame", "setTimeout", "setInterval", "fetch", "EventSource", "HTMLElement", "WebGLRenderingContext",
  "globalThis",
];

// Les globales qu'on peut piéger sans casser le test runner.
const TRAPPABLE = BROWSER_GLOBALS.filter((n) => !["setTimeout", "setInterval", "fetch", "globalThis", "self"].includes(n));

// Exécute `fn` avec les globales du navigateur piégées : tout accès fait échouer.
export async function withBrowserTraps(fn) {
  const saved = new Map(TRAPPABLE.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const name of TRAPPABLE) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`accès interdit à la globale du navigateur « ${name} »`);
      },
    });
  }
  try {
    return await fn();
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

// Le code source sans commentaires (les commentaires peuvent citer `three` ou le DOM).
export function jsCode(file) {
  return fs
    .readFileSync(path.join(JS_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/ .*$/gm, "");
}

// Échoue si `file` (nom dans viz/public/js) n'est pas pur. Asynchrone : le module est importé sous pièges.
export async function assertPure(file) {
  const source = jsCode(file);
  const specifiers = [...source.matchAll(/(?:^|[\s;])(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g)].map((m) => m[1]);
  specifiers.push(...[...source.matchAll(/\bimport\s*["']([^"']+)["']/g)].map((m) => m[1]));
  for (const specifier of specifiers) {
    assert.match(specifier, /^\.\//, `import non relatif dans ${file} : ${specifier}`);
    assert.doesNotMatch(specifier, /three/i);
  }
  assert.doesNotMatch(source, /\bimport\s*\(/, "pas d'import dynamique");
  assert.doesNotMatch(source, /\brequire\s*\(/, "pas de require");
  assert.doesNotMatch(source, /\bthree\b/i, "aucune référence à three dans le code");
  for (const name of BROWSER_GLOBALS) {
    assert.doesNotMatch(source, new RegExp(`(?<![\\w.$])${name}\\b`), `${file} référence ${name}`);
  }
  assert.doesNotMatch(source, /\bDate\.now\s*\(/);
  assert.doesNotMatch(source, /\bMath\.random\s*\(/);
  assert.doesNotMatch(source, /\bnew Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /\bperformance\./);
  await withBrowserTraps(() => import(pathToFileURL(path.join(JS_DIR, file)).href));
}
