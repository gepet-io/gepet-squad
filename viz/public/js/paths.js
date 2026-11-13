// Trajets des bonhommes (ADR 0011) : polyligne entre deux points d'une route de `office-layout.js`, échantillonnage
// (position et cap) et durée de marche. Module pur : aucun import de `three`, aucun DOM, ni hasard ni horloge ; les mêmes
// entrées donnent toujours les mêmes sorties. Il n'y a ni navmesh ni pathfinding : les postes sont fixes.
//
// Un point est un objet { x, z } (le sol est y = 0). Une polyligne est un tableau de points. Le cap est un lacet en
// radians, comme `rotation` dans `office-layout.js` : 0 regarde vers +z, `Math.PI / 2` vers +x.

export const WALK_SPEED = 4; // unités du monde par seconde
export const MAX_WALK_MS = 3000;

const EPS = 1e-9;

const same = (a, b) => Math.abs(a.x - b.x) < EPS && Math.abs(a.z - b.z) < EPS;
const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const copy = (p) => ({ x: p.x, z: p.z });

// Projette `p` sur la polyligne `line` (au moins 2 points) : point le plus proche et abscisse curviligne.
// À égalité, le premier segment gagne (résultat déterministe).
function project(line, p) {
  let best = null;
  let before = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i];
    const b = line[i + 1];
    const len = dist(a, b);
    const t = len < EPS ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.z - a.z) * (b.z - a.z)) / (len * len)));
    const point = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    const d = dist(p, point);
    if (!best || d < best.d - EPS) best = { d, point, s: before + t * len };
    before += len;
  }
  return best;
}

// Abscisse curviligne de chaque sommet de `line`.
function offsets(line) {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + dist(line[i - 1], line[i]));
  return out;
}

// Polyligne de `from` à `to`. `waypoints` est la route en cours (porte -> accès du poste concerné, voir
// `office-layout.js`) : `from` et `to` y sont projetés (jamais au point de passage le plus proche à vol d'oiseau), et le
// trajet suit la route dans le bon sens, avec demi-tour possible au milieu d'une marche. Le résultat commence toujours à
// `from` et finit à `to` ; deux points consécutifs ne sont jamais confondus.
export function pathTo(from, to, waypoints) {
  const line = Array.isArray(waypoints) ? waypoints : [];
  const out = [copy(from)];
  const push = (p) => {
    if (!same(out[out.length - 1], p)) out.push(copy(p));
  };
  if (line.length >= 2) {
    const a = project(line, from);
    const b = project(line, to);
    const cum = offsets(line);
    push(a.point);
    if (a.s < b.s) {
      for (let i = 0; i < line.length; i++) if (cum[i] > a.s + EPS && cum[i] < b.s - EPS) push(line[i]);
    } else if (a.s > b.s) {
      for (let i = line.length - 1; i >= 0; i--) if (cum[i] < a.s - EPS && cum[i] > b.s + EPS) push(line[i]);
    }
    push(b.point);
  }
  push(to);
  // `to` peut être confondu avec le dernier point : on garantit qu'il termine bien la polyligne.
  out[out.length - 1] = copy(to);
  return out;
}

// Longueur d'une polyligne.
export function lengthOf(path) {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
  return total;
}

// Durée de marche en ms : proportionnelle à la longueur à vitesse constante, plafonnée à MAX_WALK_MS.
export function durationOf(path) {
  return Math.min(MAX_WALK_MS, (lengthOf(path) / WALK_SPEED) * 1000);
}

const headingOf = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);

// Position et cap à la fraction `t` (0 à 1, bornée) de la longueur. Le cap suit le segment courant ; sur un chemin
// d'un seul point (ou de longueur nulle), il vaut 0. Aux sommets, c'est le segment qui suit qui donne le cap.
export function sample(path, t) {
  if (!path.length) return null;
  const total = lengthOf(path);
  if (path.length === 1 || total < EPS) return { x: path[0].x, z: path[0].z, heading: 0 };
  const f = Number.isFinite(t) ? Math.max(0, Math.min(1, t)) : 0;
  const target = f * total;
  let before = 0;
  let last = 0; // dernier segment non nul
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    const len = dist(a, b);
    if (len < EPS) continue;
    last = i;
    if (target < before + len) {
      const k = (target - before) / len;
      return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, heading: headingOf(a, b) };
    }
    before += len;
  }
  const end = path[path.length - 1];
  return { x: end.x, z: end.z, heading: headingOf(path[last], path[last + 1]) };
}
