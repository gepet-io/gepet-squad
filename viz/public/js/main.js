// Point d'entrée de la page : charge `/state`, suit le flux `/events` et tient le modèle à jour (`state.js`), puis le
// montre dans la scène 3D (`scene.js`, `labels.js`) ou, sans WebGL (ou avec `?mode=texte`), dans un repli texte
// (`fallback.js`).
//
// Ce module n'importe pas `three` : la scène est chargée à la demande par `boot()`, et `connect()` (toute la logique de
// connexion) se teste sous Node avec un faux `EventSource` et un faux `fetch`.
//
// Ordre de connexion. Le serveur n'envoie ni rejeu ni snapshot à une première connexion sans `Last-Event-ID`. Si l'on
// lisait `/state` puis qu'on ouvrait le flux, un événement ajouté entre les deux serait perdu. `connect()` fait donc
// l'inverse :
//   1. il ouvre l'`EventSource('/events')` ;
//   2. il lit `/state` ; les messages reçus pendant ce temps sont mis de côté ;
//   3. il rejoue ces messages sur l'état lu, dans l'ordre d'arrivée, en écartant les événements que `/state` reflète
//      déjà (voir sync.js) ;
//   4. ensuite, chaque message est appliqué dès sa réception : `apply(model, { event: e.type, data: e.data })`.

import { init, apply, tick } from "./state.js";
import { forcesFallback, renderFallback, webglAvailable } from "./fallback.js";
import * as ui from "./ui.js";
import {
  MAX_PENDING_MESSAGES,
  REFLECTED_MARGIN_MS,
  connectionStatus,
  dropReflected,
  reflectedCutoff,
} from "./sync.js";

const SSE_EVENTS = ["evt", "snapshot", "warning"];
const DEFAULT_RETRY_MS = 2000;
const DEFAULT_TICK_MS = 30 * 1000;

const noop = () => {};

/**
 * Se connecte au serveur de visualisation.
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {typeof EventSource} options.EventSource
 * @param {string} [options.baseUrl] préfixe des URL (vide dans le navigateur : même origine)
 * @param {(model: object, transitions: object[]) => void} [options.onUpdate] à chaque changement du modèle (au premier
 *   appel, `transitions` est vide : c'est l'état initial)
 * @param {(status: { state: string, text: string }) => void} [options.onConnection] état de la connexion
 * @param {(error: Error) => void} [options.onError] échec de lecture de `/state` (nouvelle tentative ensuite)
 * @param {() => number} [options.now] horloge (ms)
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof setInterval} [options.setInterval]
 * @param {typeof clearInterval} [options.clearInterval]
 * @param {number} [options.retryMs] délai avant une nouvelle lecture de `/state`
 * @param {number} [options.tickMs] période de `tick` (purge des agents terminés)
 * @returns {{ ready: Promise<void>, close: () => void, getModel: () => object | null, source: object }}
 */
export function connect({
  fetch: fetchFn,
  EventSource: EventSourceClass,
  baseUrl = "",
  onUpdate = noop,
  onConnection = noop,
  onError = noop,
  now = Date.now,
  setTimeout: setTimer = globalThis.setTimeout,
  setInterval: setTicker = globalThis.setInterval,
  clearInterval: clearTicker = globalThis.clearInterval,
  retryMs = DEFAULT_RETRY_MS,
  tickMs = DEFAULT_TICK_MS,
}) {
  let model = null;
  let pending = [];
  let wasOpen = false;
  let closed = false;
  let ticker = null;

  const publish = (result) => {
    if (result.model === model) return;
    model = result.model;
    onUpdate(model, result.transitions);
  };

  const receive = (message) => {
    if (model !== null) return publish(apply(model, message));
    pending.push(message);
    if (pending.length > MAX_PENDING_MESSAGES) pending = pending.slice(-MAX_PENDING_MESSAGES);
  };

  // 1. Le flux est ouvert avant toute lecture de `/state`.
  const source = new EventSourceClass(`${baseUrl}/events`);
  const reportConnection = () => onConnection(connectionStatus(source.readyState, wasOpen));
  source.addEventListener("open", () => {
    wasOpen = true;
    reportConnection();
  });
  source.addEventListener("error", reportConnection);
  for (const name of SSE_EVENTS) source.addEventListener(name, (e) => receive({ event: e.type, data: e.data }));
  reportConnection();

  // 3. Rejoue les messages reçus pendant la lecture de `/state`.
  const start = (state) => {
    let current = init(state);
    let cutoff = reflectedCutoff(current.updatedAt, REFLECTED_MARGIN_MS);
    const queued = pending;
    pending = [];
    for (const raw of queued) {
      const message = dropReflected(raw, cutoff);
      if (message === null) continue;
      const result = apply(current, message);
      if (message.event === "snapshot" && result.model !== current) {
        // Un instantané reçu pendant la lecture remplace l'état lu : ce qu'il reflète est repris à son tour.
        const next = reflectedCutoff(result.model.updatedAt, REFLECTED_MARGIN_MS);
        if (next !== null) cutoff = Math.max(cutoff ?? next, next);
      }
      current = result.model;
    }
    model = current;
    onUpdate(model, []);
  };

  // 2. Lecture de `/state`, avec de nouvelles tentatives tant qu'elle échoue.
  const load = async () => {
    while (!closed) {
      try {
        const response = await fetchFn(`${baseUrl}/state`, { cache: "no-store" });
        if (!response.ok) throw new Error(`/state : HTTP ${response.status}`);
        const state = await response.json();
        if (closed) return;
        start(state);
        return;
      } catch (error) {
        onError(error);
        await new Promise((resolve) => setTimer(resolve, retryMs));
      }
    }
  };
  const ready = load();

  ticker = setTicker(() => {
    if (model !== null) publish(tick(model, now()));
  }, tickMs);

  return {
    ready,
    getModel: () => model,
    source,
    close() {
      closed = true;
      source.close();
      if (ticker !== null) clearTicker(ticker);
      ticker = null;
    },
  };
}

/**
 * Monte la page : connexion d'abord, puis scène 3D (chargée à la demande) ou repli texte. Le repli est choisi quand
 * l'URL porte `?mode=texte`, ou quand WebGL est indisponible (contexte impossible à créer, ou scène qui échoue au démarrage).
 * @param {Document} doc
 * @param {Window} win
 * @param {object} [options]
 * @param {(scene: object) => unknown} [options.onScene] appelé une fois, avec la valeur de `createScene`, quand la scène
 *   et ses étiquettes sont créées et avant le premier `scene.update` ; attendu s'il renvoie une promesse. Jamais appelé
 *   sans scène (repli texte). Une exception levée ici bascule sur le repli : le crochet doit attraper ses erreurs.
 */
export async function boot(doc = globalThis.document, win = globalThis.window, { onScene } = {}) {
  const els = {
    connection: doc.getElementById("connexion"),
    repo: doc.getElementById("depot"),
    scene: doc.getElementById("scene"),
    legend: doc.getElementById("legende"),
    warning: doc.getElementById("avertissement"),
    fallback: doc.getElementById("repli"),
  };
  ui.renderLegend(els.legend, doc);

  let latest = null;
  let scene = null;
  const render = (model, transitions) => {
    latest = model;
    ui.showRepo(els.repo, model.repo);
    if (scene !== null) scene.update(model, transitions);
    else if (els.fallback.hidden === false) renderFallback(els.fallback, model, doc);
  };

  // Bascule sur la vue texte : le conteneur de la scène est masqué, la liste se met à jour à chaque `render`.
  const switchToText = () => {
    scene?.dispose?.();
    scene = null;
    els.scene.hidden = true;
    els.fallback.hidden = false;
    if (latest !== null) renderFallback(els.fallback, latest, doc);
  };

  // La vue texte est choisie d'emblée, sans charger `three`, avec `?mode=texte` ou si le contexte WebGL ne peut pas être
  // créé.
  const forced = forcesFallback(win.location?.search);
  const noWebgl = !forced && !webglAvailable(doc);
  if (noWebgl) win.console.warn("[gepet-squad-viz] WebGL indisponible, repli texte");
  const textOnly = forced || noWebgl;
  if (textOnly) switchToText();

  // La connexion passe en premier : le flux est ouvert pendant que la scène se charge.
  connect({
    fetch: win.fetch.bind(win),
    EventSource: win.EventSource,
    onUpdate: render,
    onConnection: (status) => ui.showConnection(els.connection, status),
    onError: (error) => win.console.warn(`[gepet-squad-viz] ${error.message}`),
  });
  if (textOnly) return;

  try {
    const [sceneModule, labelsModule] = await Promise.all([import("./scene.js"), import("./labels.js")]);
    scene = sceneModule.createScene({
      container: els.scene,
      window: win,
      onAssetsFailed: (count) => ui.showAssetsWarning(els.warning, count),
    });
    labelsModule.createLabels(scene, { container: els.scene, document: doc });
    await onScene?.(scene);
    if (latest !== null) scene.update(latest, []);
  } catch (error) {
    // Le moteur de rendu n'a pas pu démarrer (ou module de rendu illisible) : la page reste utile, en texte.
    win.console.warn(`[gepet-squad-viz] scène 3D indisponible, repli texte : ${error.message}`);
    switchToText();
  }
}

/**
 * Ajoute à la scène les agents lumineux (agents.js, chargé à la demande). Couche facultative : si elle échoue, la scène
 * reste affichée, sans agents, et l'erreur est signalée dans la console.
 * @param {object} scene la valeur renvoyée par `createScene`
 * @param {Window} win
 */
export async function loadAgents(scene, win = globalThis.window) {
  try {
    const { createAgents } = await import("./agents.js");
    createAgents(scene);
  } catch (error) {
    win.console.warn(`[gepet-squad-viz] agents lumineux indisponibles : ${error.message}`);
  }
}

// Dans le navigateur uniquement : un `import` sous Node (tests) ne lance rien.
if (typeof document !== "undefined" && typeof window !== "undefined") {
  boot(document, window, { onScene: (scene) => loadAgents(scene, window) }).catch((error) => console.error(`[gepet-squad-viz] ${error.message}`));
}
