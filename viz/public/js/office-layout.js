// Plan du bureau 3D (ADR 0009 et 0011) : zones, postes, porte, mobilier placé, points de passage et positions des
// post-its du kanban. Module pur : aucun import de `three`, aucun DOM, ni hasard ni horloge. Les positions sont de
// simples objets { x, z } (le sol est y = 0) ; c'est `scene.js` qui les convertit.
//
// Repère : x vers la droite, y vers le haut, z vers le spectateur. Le kanban est sur le mur du fond (z minimal), la
// porte sur le mur de gauche. Une rotation est un lacet en radians : 0 regarde vers +z, `Math.PI` vers -z.
// Les dimensions du mobilier sont des emprises en unités du monde, après l'échelle d'`assets.js` (1 pour Kenney 2018
// comme 2026) ; les identifiants de meubles sont ceux du manifeste d'`assets.js`.
// Les sorties dépendent uniquement des arguments : les mêmes entrées donnent toujours les mêmes sorties.

import { STATIONS, ESCALADE } from "./state.js";

export const MAX_DEV_SEATS = 8;
export const DEFAULT_DEV_SEATS = 3;
export const MAX_ZONE_SEATS = 3;
export const KANBAN_MAX_PER_COLUMN = 8;

const HALF_PI = Math.PI / 2;

// Murs : emprise intérieure du bureau.
const WALLS = { minX: -14, maxX: 14, minZ: -9, maxZ: 9, height: 6 };
// Couloir le long du mur d'entrée (z) : tous les trajets partent de la porte et le suivent.
const CORRIDOR_Z = 7.25;
const DOOR = { id: "doorway", x: WALLS.minX, z: CORRIDOR_Z, rotation: HALF_PI, entry: { x: -12.7, z: CORRIDOR_Z } };

// Emprises { w (x), d (z), h (y) } du mobilier avant rotation.
export const FURNITURE_SIZE = {
  desk: { w: 1.6, d: 0.8, h: 0.75 },
  chairDesk: { w: 0.6, d: 0.6, h: 0.9 },
  computerScreen: { w: 0.5, d: 0.2, h: 0.45 },
  computerKeyboard: { w: 0.4, d: 0.15, h: 0.03 },
  laptop: { w: 0.4, d: 0.3, h: 0.03 },
  table: { w: 3, d: 1.4, h: 0.75 },
  bookcaseOpen: { w: 1.2, d: 0.4, h: 1.8 },
  pottedPlant: { w: 0.5, d: 0.5, h: 1 },
  kitchenCoffeeMachine: { w: 0.5, d: 0.4, h: 0.6 },
  trashcan: { w: 0.4, d: 0.4, h: 0.5 },
};

const DESK_H = FURNITURE_SIZE.desk.h;

const r3 = (n) => Math.round(n * 1000) / 1000;
const pt = (x, z) => ({ x: r3(x), z: r3(z) });

// Un meuble placé : identifiant du manifeste, position au sol, rotation, boîte englobante (rotation par quarts de tour).
function piece(id, x, z, rotation = 0, y = 0) {
  const size = FURNITURE_SIZE[id];
  const quarter = ((Math.round(rotation / HALF_PI) % 2) + 2) % 2;
  const w = quarter ? size.d : size.w;
  const d = quarter ? size.w : size.d;
  return {
    id,
    x,
    y,
    z,
    rotation,
    box: { minX: r3(x - w / 2), maxX: r3(x + w / 2), minY: y, maxY: r3(y + size.h), minZ: r3(z - d / 2), maxZ: r3(z + d / 2) },
  };
}

// Poste assis : bureau, chaise derrière (côté +z), écrans, clavier ou laptop. `screens` : décalages x des écrans.
function workstation(key, deskX, deskZ, { screens = [0], laptop = false } = {}) {
  const chairZ = deskZ + 0.75;
  const furniture = [
    piece("desk", deskX, deskZ),
    piece("chairDesk", deskX, chairZ, Math.PI),
    ...screens.map((dx) => piece("computerScreen", deskX + dx, deskZ - 0.2, 0, DESK_H)),
    piece(laptop ? "laptop" : "computerKeyboard", deskX, deskZ + 0.15, 0, DESK_H),
  ];
  return {
    key,
    furniture,
    desk: pt(deskX, deskZ),
    x: r3(deskX),
    z: r3(chairZ),
    rotation: Math.PI,
    seated: true,
    access: pt(deskX, chairZ + 1),
  };
}

// Table de réunion et ses 4 chaises ; la chaise (tableX + 1, côté sud) est le poste principal.
function meetingRoom(tableX, tableZ) {
  const sideZ = FURNITURE_SIZE.table.d / 2 + FURNITURE_SIZE.chairDesk.d / 2 + 0.05;
  return {
    furniture: [
      piece("table", tableX, tableZ),
      piece("chairDesk", tableX - 1, tableZ + sideZ, Math.PI),
      piece("chairDesk", tableX + 1, tableZ + sideZ, Math.PI),
      piece("chairDesk", tableX - 1, tableZ - sideZ, 0),
      piece("chairDesk", tableX + 1, tableZ - sideZ, 0),
    ],
    seat: { x: r3(tableX + 1), z: r3(tableZ + sideZ), rotation: Math.PI, seated: true, access: pt(tableX + 1, tableZ + sideZ + 1) },
  };
}

// --- Postes de développeur ----------------------------------------------------------------------------------------------

const DEV_COLUMNS = [-4.5, -1.5, 1.5, 4.5];
const DEV_ROW_Z = [1.5, 5.5];

function buildDevSeat(i) {
  const row = i < DEV_COLUMNS.length ? 0 : 1;
  const col = i % DEV_COLUMNS.length;
  const seat = workstation(`dev:${i}`, DEV_COLUMNS[col], DEV_ROW_Z[row]);
  return { ...seat, index: i, extra: i >= DEFAULT_DEV_SEATS, aisleX: DEV_COLUMNS[col] - 1.5, viaZ: row === 0 ? seat.access.z : CORRIDOR_Z };
}

const DEV_SEATS = Array.from({ length: MAX_DEV_SEATS }, (_, i) => buildDevSeat(i));

// Poste `i` (0 <= i < MAX_DEV_SEATS) avec ses meubles, ou `null`. Les postes >= 3 sont supplémentaires.
export function devSeat(i) {
  return Number.isInteger(i) && i >= 0 && i < MAX_DEV_SEATS ? DEV_SEATS[i] : null;
}

// --- Postes fixes -------------------------------------------------------------------------------------------------------

const PM = workstation("pm", -11, 2.5);
const VERIFIER = workstation("verification:0", 10, 1.5);
const LAB = workstation("test:0", 10, 5.5, { screens: [-0.45, 0.45], laptop: true });
const CADRAGE_ROOM = meetingRoom(-10, -4.5);
const ESCALADE_ROOM = meetingRoom(10, -4.5);

const DECOR = [
  piece("bookcaseOpen", -13.55, 3, HALF_PI),
  piece("bookcaseOpen", 13.55, 0, -HALF_PI),
  piece("pottedPlant", -13.3, 5.5),
  piece("trashcan", -13.3, 0.8),
  piece("kitchenCoffeeMachine", 13.4, 8.4),
];

// Les 8 colonnes du kanban sur le mur du fond : une par station, puis l'escalade.
export const KANBAN_COLUMNS = Object.freeze([...STATIONS, ESCALADE]);
const KANBAN = { z: -8.9, columnWidth: 3, top: 5.2, rowStep: 0.5, noteWidth: 2.4 };
const columnX = (index) => (index - (KANBAN_COLUMNS.length - 1) / 2) * KANBAN.columnWidth;

// Places debout (rangs 1 et 2) et trajets. `aisleX` : couloir nord-sud emprunté depuis le couloir d'entrée ;
// `viaZ` : z de la traversée est-ouest jusqu'à la place.
const standing = (x, z, rotation, aisleX, viaZ) => ({ x, z, rotation, seated: false, access: pt(x, z), aisleX, viaZ });

const SEATS = {
  cadrage: [
    { ...CADRAGE_ROOM.seat, aisleX: -7.5, viaZ: CADRAGE_ROOM.seat.access.z },
    standing(-12.6, -4.5, HALF_PI, -7.5, -0.5),
    standing(-7.5, -4.5, -HALF_PI, -7.5, -4.5),
  ],
  roadmap: [
    standing(-7.5, -7.6, Math.PI, -7.5, -7.6),
    standing(-5.5, -7.6, Math.PI, -7.5, -7.6),
    standing(-9.5, -7.6, Math.PI, -7.5, -7.6),
  ],
  verification: [
    { ...VERIFIER, aisleX: 7.5, viaZ: VERIFIER.access.z },
    standing(12.2, 3.25, Math.PI, 7.5, 3.25),
    standing(12.2, 1.5, -HALF_PI, 7.5, 3.25),
  ],
  test: [
    { ...LAB, aisleX: LAB.access.x, viaZ: CORRIDOR_Z },
    standing(12.2, 5.5, -HALF_PI, 12.2, CORRIDOR_Z),
    standing(12.2, 7, -HALF_PI, 12.2, CORRIDOR_Z),
  ],
  escalade: [
    { ...ESCALADE_ROOM.seat, aisleX: 7.5, viaZ: ESCALADE_ROOM.seat.access.z },
    standing(12.6, -4.5, HALF_PI, 7.5, -0.5),
    standing(7.5, -4.5, -HALF_PI, 7.5, -4.5),
  ],
};

for (const [station, list] of Object.entries(SEATS)) {
  list.forEach((s, rank) => Object.assign(s, { key: `${station}:${rank}`, station, rank }));
}

// Place d'un agent dans une zone à occupant unique : station (`null` pour un architecte sans mode connu : salle de
// réunion), rôle, rang d'occupation (entier >= 0 ; au-delà de MAX_ZONE_SEATS - 1 : dernière place). `dev` (voir
// `devSeat`), `merge`, `release` et les stations inconnues n'ont pas de place : `null`.
export function seatFor(station, role, rank = 0) {
  const zoneId = station === null ? (role === "architecte" ? "cadrage" : null) : station;
  const list = Object.hasOwn(SEATS, zoneId) ? SEATS[zoneId] : null;
  if (!list) return null;
  const n = Number.isInteger(rank) && rank > 0 ? rank : 0;
  return list[Math.min(n, MAX_ZONE_SEATS - 1)];
}

// --- Description du bureau ----------------------------------------------------------------------------------------------

const zone = (x, z, width, depth, extra = {}) => ({ x, z, width, depth, ...extra });

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const OFFICE = deepFreeze({
  walls: WALLS,
  door: DOOR,
  corridorZ: CORRIDOR_Z,
  kanban: { ...KANBAN, columns: KANBAN_COLUMNS.map((id, i) => ({ id, x: columnX(i) })) },
  zones: {
    cadrage: zone(-10, -3.75, 8, 5.5, { name: "Salle de réunion" }),
    roadmap: zone(-7.5, -7.6, 6, 1.8, { name: "Kanban" }),
    dev: zone(0, 4.25, 14, 7.5, { name: "Open space" }),
    verification: zone(10.75, 2.5, 6.5, 3.6, { name: "Bureau du vérificateur" }),
    test: zone(10.75, 6.35, 6.5, 3.3, { name: "Labo" }),
    escalade: zone(10.5, -3.75, 7, 5.5, { name: "Salle d'escalade", tint: "#ff3b30" }),
  },
  pm: { key: PM.key, desk: PM.desk, x: PM.x, z: PM.z, rotation: PM.rotation, seated: true, access: PM.access },
  devSeats: DEV_SEATS.slice(0, DEFAULT_DEV_SEATS).map(({ key, index, x, z, rotation, access }) => ({ key, index, x, z, rotation, access })),
  furniture: [
    ...PM.furniture,
    ...DEV_SEATS.slice(0, DEFAULT_DEV_SEATS).flatMap((s) => s.furniture),
    ...VERIFIER.furniture,
    ...LAB.furniture,
    ...CADRAGE_ROOM.furniture,
    ...ESCALADE_ROOM.furniture,
    ...DECOR,
  ],
});

// Meubles de tout le bureau, postes de développeur supplémentaires compris (pour les contrôles de collision).
export function allFurniture() {
  return [...OFFICE.furniture, ...DEV_SEATS.slice(DEFAULT_DEV_SEATS).flatMap((s) => s.furniture)];
}

// --- Points de passage --------------------------------------------------------------------------------------------------

function route(seat) {
  const points = [
    pt(DOOR.x, DOOR.z),
    DOOR.entry,
    pt(seat.aisleX, CORRIDOR_Z),
    pt(seat.aisleX, seat.viaZ),
    pt(seat.access.x, seat.viaZ),
    seat.access,
  ];
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.z !== points[i - 1].z);
}

const ROUTES = (() => {
  const out = {};
  out[PM.key] = route({ ...PM, aisleX: PM.access.x, viaZ: CORRIDOR_Z });
  for (const s of DEV_SEATS) out[s.key] = route(s);
  for (const list of Object.values(SEATS)) for (const s of list) out[s.key] = route(s);
  return deepFreeze(out);
})();

// Polyligne de la porte au point d'accès de chaque poste : clés `pm`, `dev:<i>` et `<station>:<rang>`.
export function waypoints() {
  return ROUTES;
}

// --- Kanban -------------------------------------------------------------------------------------------------------------

// Position d'un post-it ou d'un compteur : colonne `column`, ligne `row` (0 en haut).
function kanbanSlot(column, row) {
  return { column, x: r3(columnX(KANBAN_COLUMNS.indexOf(column))), y: r3(KANBAN.top - row * KANBAN.rowStep), z: KANBAN.z };
}

// Positions du kanban pour un modèle de `state.js` : `{ notes, counters }`. Une feature est rangée dans la colonne de
// sa station, ou `escalade` si elle est escaladée ; une feature sans colonne connue n'est pas affichée. Dans une
// colonne : le milestone ouvert de plus petit numéro d'abord, puis les autres, chaque groupe par numéro de feature.
// Au-delà de KANBAN_MAX_PER_COLUMN, un compteur `{ column, extra: N }` remplace les post-its en trop.
export function kanbanLayout(model) {
  const open = (model.milestones || []).filter((m) => m.state === "open").sort((a, b) => a.number - b.number)[0];
  const rank = (f) => (open && f.milestone === open.title ? 0 : 1);
  const notes = [];
  const counters = [];
  for (const column of KANBAN_COLUMNS) {
    const list = model.features
      .filter((f) => (f.escalated ? ESCALADE : f.station) === column)
      .sort((a, b) => rank(a) - rank(b) || a.number - b.number);
    list.slice(0, KANBAN_MAX_PER_COLUMN).forEach((f, row) => notes.push({ number: f.number, row, ...kanbanSlot(column, row) }));
    if (list.length > KANBAN_MAX_PER_COLUMN) {
      counters.push({ extra: list.length - KANBAN_MAX_PER_COLUMN, row: KANBAN_MAX_PER_COLUMN, ...kanbanSlot(column, KANBAN_MAX_PER_COLUMN) });
    }
  }
  return { notes, counters };
}
