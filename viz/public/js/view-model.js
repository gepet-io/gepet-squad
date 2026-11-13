// Tout ce que la scène 3D décide, sous forme de fonctions pures : couleurs des statuts, noms affichés, correspondance
// instance -> feature, lissage des déplacements, cadrage de la caméra. Module pur : aucun import de
// `three`, aucun DOM, ni hasard ni horloge. `scene.js` et `labels.js` (qui importent `three`) ne font que dessiner
// ce que ce module calcule (ADR 0006 : pas de logique de décision dans les modules de rendu).
//
// Les positions sont de simples objets { x, y, z } : c'est `scene.js` qui les convertit en `Vector3`.

import { ESCALADE } from "./state.js";

// --- Noms affichés -------------------------------------------------------------------------------------------------------

export const STATION_NAMES = Object.freeze({
  cadrage: "Cadrage",
  roadmap: "Roadmap",
  dev: "Développement",
  verification: "Vérification",
  test: "Test",
  merge: "Merge",
  release: "Release",
});
export const ESCALADE_NAME = "Escalade";

// Nom d'une station, de la zone d'escalade, ou l'identifiant tel quel pour une valeur inconnue.
export function stationName(id) {
  if (id === ESCALADE) return ESCALADE_NAME;
  return Object.prototype.hasOwnProperty.call(STATION_NAMES, id) ? STATION_NAMES[id] : String(id);
}

// "#12 Titre", ou "#12" quand le titre est inconnu. Le résultat est un texte : l'appelant l'affiche par `textContent`.
export function featureLabel(feature) {
  return feature.title ? `#${feature.number} ${feature.title}` : `#${feature.number}`;
}

// --- Couleurs ------------------------------------------------------------------------------------------------------------

// Palette des labels `status:*` de skills/gepet-squad/references/github-conventions.md.
export const STATUS_COLORS = Object.freeze({
  backlog: 0xd4d4d4,
  ready: 0x0e8a16,
  "in-progress": 0x1d76db,
  "in-review": 0x5319e7,
  "in-test": 0xfbca04,
  "changes-requested": 0xd93f0b,
  blocked: 0xb60205,
  done: 0x0b6e2b,
});
export const UNKNOWN_COLOR = 0x6e7681;

export const STATUS_LABELS = Object.freeze({
  backlog: "Backlog",
  ready: "Prête",
  "in-progress": "En cours",
  "in-review": "En revue",
  "in-test": "En test",
  "changes-requested": "Correctifs demandés",
  blocked: "Bloquée (escalade)",
  done: "Terminée",
});

// Couleur (entier 0xRRGGBB) d'un statut ; gris neutre pour un statut inconnu.
export function statusColor(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_COLORS, status) ? STATUS_COLORS[status] : UNKNOWN_COLOR;
}

export function colorCss(hex) {
  return "#" + hex.toString(16).padStart(6, "0");
}

// Légende : un élément par statut, dans l'ordre du workflow.
export function legendEntries() {
  return Object.keys(STATUS_COLORS).map((status) => ({
    status,
    label: STATUS_LABELS[status],
    color: STATUS_COLORS[status],
    css: colorCss(STATUS_COLORS[status]),
  }));
}

// --- Instances -> features -----------------------------------------------------------------------------------------------

// Les features à dessiner, dans l'ordre des instances de l'`InstancedMesh` (par numéro). `positions` est la sortie de
// `layoutFeatures` : une feature sans place (station inconnue) n'est pas dessinée.
export function featureInstances(model, positions) {
  const out = [];
  for (const f of [...model.features].sort((a, b) => a.number - b.number)) {
    const p = positions.get(f.number);
    if (p === undefined) continue;
    out.push({
      number: f.number,
      title: f.title,
      status: f.status,
      retry: f.retry,
      milestone: f.milestone,
      pr: f.pr,
      escalated: Boolean(f.escalated),
      station: p.station,
      zone: p.zone,
      color: statusColor(f.status),
      position: { x: p.x, y: p.y, z: p.z },
    });
  }
  return out;
}

// La feature d'un `instanceId` renvoyé par le lancer de rayon, ou `null` (hors plage, ou id non entier).
export function featureForInstance(instances, instanceId) {
  if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= instances.length) return null;
  return instances[instanceId];
}

// --- Déplacements --------------------------------------------------------------------------------------------------------

const SNAP_DISTANCE = 0.005;
export const MOVE_RATE = 6;

// Rapproche `current` de `target` (lissage exponentiel indépendant de la cadence) ; `dt` en secondes.
export function approach(current, target, dt, rate = MOVE_RATE) {
  const k = 1 - Math.exp(-rate * Math.max(0, dt));
  const next = current + (target - current) * k;
  return Math.abs(target - next) < SNAP_DISTANCE ? target : next;
}

// Nouvelles positions courantes de chaque feature : une feature nouvelle apparaît à sa place, les autres se
// rapprochent de leur cible, une feature absente des cibles disparaît. `moving` : au moins une feature n'est pas arrivée.
// Renvoie { positions: Map numéro -> { x, y, z }, moving }.
export function stepPositions(currents, targets, dt, rate = MOVE_RATE) {
  const positions = new Map();
  let moving = false;
  for (const [number, target] of targets) {
    const from = currents.get(number);
    if (from === undefined) {
      positions.set(number, { x: target.x, y: target.y, z: target.z });
      continue;
    }
    const next = {
      x: approach(from.x, target.x, dt, rate),
      y: approach(from.y, target.y, dt, rate),
      z: approach(from.z, target.z, dt, rate),
    };
    if (next.x !== target.x || next.y !== target.y || next.z !== target.z) moving = true;
    positions.set(number, next);
  }
  return { positions, moving };
}

// Capacité de l'`InstancedMesh` : on garde l'actuelle tant qu'elle suffit, sinon la prochaine puissance de 2.
export function capacityFor(count, capacity = 0, minimum = 64) {
  if (count <= capacity && capacity > 0) return capacity;
  let next = Math.max(minimum, 1);
  while (next < count) next *= 2;
  return next;
}

// --- Géométrie de la vue -------------------------------------------------------------------------------------------------

// Coordonnées normalisées (-1..1) d'un point de l'écran dans le rectangle `rect` du canvas, ou `null` si le canvas est vide.
export function toNdc(clientX, clientY, rect) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * 2 - 1,
    y: -((clientY - rect.top) / rect.height) * 2 + 1,
  };
}

// Emprise de l'ensemble des boîtes (centre au sol + taille) : { minX, maxX, minZ, maxZ, height }.
export function sceneBounds(boxes) {
  const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, height: 0 };
  for (const b of boxes) {
    bounds.minX = Math.min(bounds.minX, b.x - b.width / 2);
    bounds.maxX = Math.max(bounds.maxX, b.x + b.width / 2);
    bounds.minZ = Math.min(bounds.minZ, b.z - b.depth / 2);
    bounds.maxZ = Math.max(bounds.maxZ, b.z + b.depth / 2);
    bounds.height = Math.max(bounds.height, b.y + b.height);
  }
  return bounds;
}

// Cadrage initial : la caméra regarde le centre de l'emprise depuis le haut et le devant, à une distance où toute
// l'emprise tient dans l'image (largeur et profondeur), quelle que soit la forme de la fenêtre.
// `fov` : champ vertical en degrés ; `aspect` : largeur / hauteur.
export function fitCamera(bounds, { fov = 45, aspect = 1.6, elevation = 52, margin = 1.12 } = {}) {
  const rad = Math.PI / 180;
  const tanV = Math.tan((fov * rad) / 2);
  const tanH = tanV * Math.max(aspect, 0.1);
  const target = { x: (bounds.minX + bounds.maxX) / 2, y: bounds.height / 3, z: (bounds.minZ + bounds.maxZ) / 2 };
  const halfWidth = (bounds.maxX - bounds.minX) / 2;
  const halfDepth = (bounds.maxZ - bounds.minZ) / 2;
  const sin = Math.sin(elevation * rad);
  const cos = Math.cos(elevation * rad);
  const distanceForWidth = halfWidth / tanH;
  const distanceForHeight = (halfDepth * sin + bounds.height * cos) / tanV;
  const distance = Math.max(distanceForWidth, distanceForHeight, 10) * margin;
  return {
    target,
    distance,
    position: { x: target.x, y: target.y + distance * sin, z: target.z + distance * cos },
  };
}

// --- Bureau : noms de zones et post-its ----------------------------------------------------------------------------------

// Positions des post-its pour `featureInstances` : numéro -> { x, y, z, station (la colonne), zone: "kanban" }. `layout` est
// la sortie de `kanbanLayout` (office-layout.js).
export function kanbanPositions(layout) {
  return new Map(layout.notes.map((n) => [n.number, { x: n.x, y: n.y, z: n.z, station: n.column, zone: "kanban" }]));
}

// Étiquettes posées dans le bureau : le nom de chaque zone au sol, puis l'en-tête de chaque colonne du kanban. `office` est
// `OFFICE` (office-layout.js). [{ id, text, kind: "zone" | "column" | "escalade", x, y, z }].
export function zoneLabels(office) {
  const out = [];
  for (const [id, zone] of Object.entries(office.zones)) {
    out.push({ id, text: zone.name, kind: id === ESCALADE ? "escalade" : "zone", x: zone.x, y: 0.05, z: zone.z + zone.depth / 2 - 0.3 });
  }
  // Les en-têtes de colonnes voisines sont décalées en hauteur : « Développement » est plus large que sa colonne.
  const { kanban } = office;
  kanban.columns.forEach((column, index) => {
    out.push({
      id: `kanban:${column.id}`,
      text: stationName(column.id),
      kind: column.id === ESCALADE ? "escalade" : "column",
      x: column.x,
      y: kanban.top + 0.55 + (index % 2) * 0.6,
      z: kanban.z,
    });
  });
  return out;
}

// Avertissement affiché quand des fichiers 3D n'ont pas pu être chargés (texte, affiché par `textContent`).
export function assetsWarning(count) {
  return count === 1
    ? "1 fichier 3D n'a pas pu être chargé : le décor est incomplet."
    : `${count} fichiers 3D n'ont pas pu être chargés : le décor est incomplet.`;
}
