// Tout ce que l'animation décide, sous forme de fonctions pures : courbes et durées des déplacements de features,
// couleur par type d'agent, badges de retry. Module pur : aucun import de
// `three`, aucun DOM, ni hasard ni horloge (le temps est toujours un argument, en secondes). `scene.js` et `characters.js`
// (qui importent `three`) ne font que dessiner ce que ce module calcule (ADR 0006, 0007). Pas de bibliothèque de tween :
// une interpolation est une donnée (départ, arrivée, début, durée, courbe) que l'on échantillonne à chaque image.
//
// Réduction de mouvement : toutes les fonctions qui animent prennent `reduced` ; vrai, elles donnent directement
// l'état final (déplacement immédiat).
//
// Les positions sont de simples objets { x, y, z } (c'est `scene.js` qui les convertit en `Vector3`).

// --- Courbes ---------------------------------------------------------------------------------------------------------

export const clamp01 = (t) => (Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : t > 0 ? 1 : 0);

// Accélère puis ralentit (déplacement d'une station à l'autre).
export function easeInOutCubic(t) {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// Part vite puis se pose (réarrangement d'une file).
export function easeOutCubic(t) {
  return 1 - (1 - clamp01(t)) ** 3;
}

export const EASINGS = Object.freeze({ inOut: easeInOutCubic, out: easeOutCubic });

// --- Déplacement des features --------------------------------------------------------------------------------------

export const MOVE_MIN_SECONDS = 0.7;
export const MOVE_MAX_SECONDS = 1.8;
export const MOVE_BASE_SECONDS = 0.5;
export const MOVE_UNITS_PER_SECOND = 40;
export const SHIFT_SECONDS = 0.45;

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const copyPoint = (p) => ({ x: p.x, y: p.y, z: p.z });

// Point entre `from` et `to` à l'instant normalisé `t` (0..1), selon la courbe `ease`. Les bornes sont exactes :
// t <= 0 donne `from`, t >= 1 donne `to`, quelle que soit la courbe.
export function interpolate(from, to, t, ease = easeInOutCubic) {
  if (!(t > 0)) return copyPoint(from);
  if (t >= 1) return copyPoint(to);
  const k = ease(t);
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k, z: from.z + (to.z - from.z) * k };
}

// Durée (secondes) d'un déplacement : proportionnelle à la distance, bornée. `kind` : "move" (changement de lieu) ou
// "shift" (la file se réarrange : durée fixe, courte).
export function moveDuration(from, to, kind = "move") {
  if (kind === "shift") return SHIFT_SECONDS;
  return Math.min(Math.max(MOVE_BASE_SECONDS + distance(from, to) / MOVE_UNITS_PER_SECOND, MOVE_MIN_SECONDS), MOVE_MAX_SECONDS);
}

// Les interpolations à lancer pour une mise à jour du modèle.
//   previous    interpolations en cours (Map numéro -> piste) : une piste qui mène déjà à la bonne cible est conservée,
//               pour qu'une mise à jour sans rapport ne relance pas un déplacement en route
//   currents    positions affichées (Map numéro -> point) : le départ d'une piste est toujours la position affichée,
//               donc un déplacement interrompu repart de là où la feature se trouve
//   targets     positions d'arrivée (Map numéro -> point)
//   transitions celles de `state.js` : une `feature-move` donne un déplacement de station, tout autre changement de
//               position (la file se réarrange) un court glissement
//   now         instant (secondes) du lancement
// Une feature absente de `currents` (nouvelle) apparaît à sa place ; avec `reduced`, aucune piste : tout est immédiat.
// Renvoie une Map numéro -> { from, to, start, duration, ease } (ease : nom dans EASINGS).
export function planTracks(previous, currents, targets, transitions, now, { reduced = false } = {}) {
  const tracks = new Map();
  if (reduced) return tracks;
  const moved = new Set(transitions.filter((t) => t.kind === "feature-move").map((t) => t.id));
  for (const [number, target] of targets) {
    const from = currents.get(number);
    if (from === undefined || samePoint(from, target)) continue;
    const old = previous.get(number);
    if (old !== undefined && samePoint(old.to, target)) {
      tracks.set(number, old);
      continue;
    }
    const kind = moved.has(number) ? "move" : "shift";
    tracks.set(number, {
      from: copyPoint(from),
      to: copyPoint(target),
      start: now,
      duration: moveDuration(from, target, kind),
      ease: kind === "move" ? "inOut" : "out",
    });
  }
  return tracks;
}

// Positions affichées à l'instant `now` : { positions: Map numéro -> point, tracks: pistes encore en cours, moving }.
// Une feature sans piste est à sa cible ; une piste terminée (ou `now` infini) donne exactement la cible.
export function sampleTracks(tracks, targets, now) {
  const positions = new Map();
  const running = new Map();
  for (const [number, target] of targets) {
    const track = tracks.get(number);
    const t = track === undefined ? 1 : (now - track.start) / track.duration;
    if (track === undefined || !(t < 1)) {
      positions.set(number, copyPoint(target));
      continue;
    }
    positions.set(number, interpolate(track.from, target, t, EASINGS[track.ease] ?? easeInOutCubic));
    running.set(number, track);
  }
  return { positions, tracks: running, moving: running.size > 0 };
}

// --- Agents : couleur par type ---------------------------------------------------------------------------------------

// Couleur par type d'agent. Volontairement hors de la palette des statuts (view-model.js) : magenta, cyan,
// citron vert et orange vif, d'écart de couleur (ΔE) mesuré avec chaque statut par tests/viz-web/motion.test.mjs.
export const AGENT_COLORS = Object.freeze({
  architecte: 0xff4fd8,
  developpeur: 0x35e0ff,
  verificateur: 0xb6ff4d,
  testeur: 0xff9a3c,
});
export const AGENT_DEFAULT_COLOR = 0xa0a8b5;

export function agentColor(type) {
  return Object.prototype.hasOwnProperty.call(AGENT_COLORS, type) ? AGENT_COLORS[type] : AGENT_DEFAULT_COLOR;
}

// --- Badges de retry -------------------------------------------------------------------------------------------------

// Texte du badge d'une feature qui a été renvoyée en correctif `retry` fois (affiché par `textContent`).
export const retryBadgeText = (retry) => `Retry ${retry}`;

// Les badges à afficher : une entrée par feature avec retry >= 1, par numéro. [{ number, retry, text }]
export function retryBadges(model) {
  return [...model.features]
    .filter((f) => Number.isInteger(f.retry) && f.retry >= 1)
    .sort((a, b) => a.number - b.number)
    .map((f) => ({ number: f.number, retry: f.retry, text: retryBadgeText(f.retry) }));
}
