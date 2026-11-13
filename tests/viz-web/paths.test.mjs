// Tests de viz/public/js/paths.js : extrémités, raccordement sur la route en cours, échantillonnage, cap, durée
// plafonnée, pureté, et trajets sans collision avec le mobilier pour tous les postes d'office-layout.js.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { pathTo, sample, durationOf, lengthOf, WALK_SPEED, MAX_WALK_MS } from "../../viz/public/js/paths.js";
import { OFFICE, MAX_DEV_SEATS, MAX_ZONE_SEATS, devSeat, seatFor, waypoints, allFurniture } from "../../viz/public/js/office-layout.js";
import { assertPure } from "./support.mjs";

const EPS = 1e-9;
const near = (a, b) => Math.abs(a - b) < 1e-6;
const xz = ({ x, z }) => ({ x, z });
const L = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];

describe("pathTo", () => {
  test("commence à from, finit à to et suit les points de passage dans l'ordre", () => {
    assert.deepEqual(pathTo({ x: 0, z: 0 }, { x: 10, z: 10 }, L), L);
  });

  test("sens inverse : repasse par les points de passage à l'envers", () => {
    assert.deepEqual(pathTo({ x: 10, z: 10 }, { x: 0, z: 0 }, L), [...L].reverse());
  });

  test("depuis une position intermédiaire : raccord sur la polyligne", () => {
    assert.deepEqual(pathTo({ x: 10, z: 4 }, { x: 0, z: 0 }, L), [{ x: 10, z: 4 }, { x: 10, z: 0 }, { x: 0, z: 0 }]);
    assert.deepEqual(pathTo({ x: 10, z: 4 }, { x: 10, z: 10 }, L), [{ x: 10, z: 4 }, { x: 10, z: 10 }]);
  });

  test("un point hors de la route est projeté sur la route en cours, pas sur le sommet euclidien le plus proche", () => {
    // Le point de passage le plus proche à vol d'oiseau est (10, 0) (distance 5) ; la projection est (6, 0) (distance 3).
    const p = pathTo({ x: 6, z: 3 }, { x: 0, z: 0 }, L);
    assert.deepEqual(p, [{ x: 6, z: 3 }, { x: 6, z: 0 }, { x: 0, z: 0 }]);
    assert.ok(!p.some((q) => q.x === 10), "pas de crochet par (10, 0)");
  });

  test("from == to : un seul point", () => {
    assert.deepEqual(pathTo({ x: 3, z: 0 }, { x: 3, z: 0 }, L), [{ x: 3, z: 0 }]);
  });

  test("sans route : segment direct", () => {
    assert.deepEqual(pathTo({ x: 0, z: 0 }, { x: 1, z: 1 }, []), [{ x: 0, z: 0 }, { x: 1, z: 1 }]);
  });

  test("ne modifie pas ses arguments et ne renvoie pas leurs objets", () => {
    const from = { x: 0, z: 0 };
    const p = pathTo(from, { x: 10, z: 10 }, L);
    assert.notEqual(p[0], from);
    assert.notEqual(p[0], L[0]);
    assert.deepEqual(L, [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }]);
  });
});

describe("sample", () => {
  const P = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }]; // longueur 8

  test("t <= 0 donne le départ, t >= 1 l'arrivée", () => {
    assert.deepEqual(sample(P, 0), { x: 0, z: 0, heading: Math.PI / 2 });
    assert.deepEqual(sample(P, -5), sample(P, 0));
    assert.deepEqual(sample(P, 1), { x: 4, z: 4, heading: 0 });
    assert.deepEqual(sample(P, 7), sample(P, 1));
  });

  test("milieu de la polyligne", () => {
    assert.deepEqual(sample(P, 0.5), { x: 4, z: 0, heading: 0 }); // sommet : le segment suivant donne le cap
    const q = sample(P, 0.25);
    assert.ok(near(q.x, 2) && near(q.z, 0));
  });

  test("cap : segment horizontal et vertical", () => {
    assert.ok(near(sample([{ x: 0, z: 0 }, { x: 5, z: 0 }], 0.5).heading, Math.PI / 2));
    assert.ok(near(sample([{ x: 0, z: 0 }, { x: 0, z: 5 }], 0.5).heading, 0));
    assert.ok(near(Math.abs(sample([{ x: 0, z: 0 }, { x: 0, z: -5 }], 0.5).heading), Math.PI));
    assert.ok(near(sample([{ x: 0, z: 0 }, { x: -5, z: 0 }], 0.5).heading, -Math.PI / 2));
  });

  test("chemin d'un seul point : ce point, sans erreur", () => {
    assert.deepEqual(sample([{ x: 2, z: 3 }], 0.5), { x: 2, z: 3, heading: 0 });
    assert.deepEqual(sample([{ x: 2, z: 3 }, { x: 2, z: 3 }], 1), { x: 2, z: 3, heading: 0 });
  });

  test("ignore les segments nuls et les valeurs de t invalides", () => {
    const Q = [{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 0 }];
    assert.ok(near(sample(Q, 0.5).x, 1));
    assert.deepEqual(sample(Q, NaN), sample(Q, 0));
  });
});

describe("durationOf", () => {
  test("proportionnelle à la longueur à vitesse constante", () => {
    const a = [{ x: 0, z: 0 }, { x: 1, z: 0 }];
    const b = [{ x: 0, z: 0 }, { x: 2, z: 0 }];
    assert.ok(near(durationOf(a), 1000 / WALK_SPEED));
    assert.ok(near(durationOf(b), 2 * durationOf(a)));
    assert.equal(durationOf([{ x: 0, z: 0 }]), 0);
  });

  test("plafonnée à MAX_WALK_MS", () => {
    assert.equal(MAX_WALK_MS, 3000);
    assert.equal(durationOf([{ x: 0, z: 0 }, { x: 1000, z: 0 }]), 3000);
    const lengthAtCap = (MAX_WALK_MS / 1000) * WALK_SPEED;
    assert.ok(near(durationOf([{ x: 0, z: 0 }, { x: lengthAtCap, z: 0 }]), 3000));
  });

  test("tous les trajets du bureau durent au plus 3 s", () => {
    for (const route of Object.values(waypoints())) assert.ok(durationOf(route) <= MAX_WALK_MS);
  });
});

// --- Intégration avec office-layout.js ------------------------------------------------------------------------------------

// Le segment [a, b] traverse-t-il l'intérieur de la boîte (vue de dessus) ? Méthode des « slabs ».
const hits = (a, b, box) => {
  let t0 = 0;
  let t1 = 1;
  for (const [a0, a1, lo, hi] of [[a.x, b.x, box.minX, box.maxX], [a.z, b.z, box.minZ, box.maxZ]]) {
    const d = a1 - a0;
    if (Math.abs(d) < EPS) {
      if (a0 <= lo + EPS || a0 >= hi - EPS) return false;
    } else {
      let ta = (lo - a0) / d;
      let tb = (hi - a0) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 >= t1 - EPS) return false;
    }
  }
  return t0 < t1 - EPS;
};

// Les meubles posés sur un bureau (y > 0) ne bloquent pas la marche : seuls ceux qui touchent le sol comptent.
const floorBoxes = allFurniture().filter((f) => f.box.minY < 0.2).map((f) => ({ id: f.id, ...f.box }));

function assertClear(path, label) {
  for (let i = 0; i + 1 < path.length; i++) {
    for (const b of floorBoxes) assert.ok(!hits(path[i], path[i + 1], b), `${label} : segment ${i} traverse ${b.id}`);
  }
}

const SEATED_STATIONS = ["cadrage", "roadmap", "verification", "test", "escalade"];
const seats = [
  ...Array.from({ length: MAX_DEV_SEATS }, (_, i) => devSeat(i)),
  ...SEATED_STATIONS.flatMap((s) => Array.from({ length: MAX_ZONE_SEATS }, (_, r) => seatFor(s, "x", r))),
];

describe("trajets sur le plan du bureau", () => {
  const routes = waypoints();

  test("tous les postes sont couverts", () => {
    assert.equal(seats.length, MAX_DEV_SEATS + SEATED_STATIONS.length * MAX_ZONE_SEATS);
    for (const s of seats) assert.ok(routes[s.key], s.key);
  });

  test("le point d'accès de chaque poste est hors des boîtes de meubles au sol", () => {
    for (const s of seats) {
      for (const b of floorBoxes) {
        const inside = s.access.x > b.minX + EPS && s.access.x < b.maxX - EPS && s.access.z > b.minZ + EPS && s.access.z < b.maxZ - EPS;
        assert.ok(!inside, `${s.key} : accès dans ${b.id}`);
      }
    }
  });

  for (const key of ["pm", ...seats.map((s) => s.key)]) {
    test(`${key} : porte <-> accès, et demi-tour depuis le milieu, sans traverser de meuble`, () => {
      const route = routes[key];
      const door = xz(OFFICE.door);
      const access = xz(route[route.length - 1]);
      const out = pathTo(door, access, route);
      const back = pathTo(access, door, route);
      assert.deepEqual(out[0], door);
      assert.deepEqual(out[out.length - 1], access);
      assert.deepEqual(back[0], access);
      assert.deepEqual(back[back.length - 1], door);
      assertClear(out, `${key} aller`);
      assertClear(back, `${key} retour`);
      for (const w of route) assert.ok(out.some((p) => near(p.x, w.x) && near(p.z, w.z)), `${key} : point de passage manquant`);

      for (const t of [0.1, 0.33, 0.5, 0.77, 0.95]) {
        const here = xz(sample(out, t));
        const toDoor = pathTo(here, door, route);
        const toAccess = pathTo(here, access, route);
        assert.deepEqual(toDoor[0], here);
        assert.deepEqual(toDoor[toDoor.length - 1], door);
        assert.deepEqual(toAccess[0], here);
        assert.deepEqual(toAccess[toAccess.length - 1], access);
        assertClear(toDoor, `${key} milieu(${t}) -> porte`);
        assertClear(toAccess, `${key} milieu(${t}) -> accès`);
        // Le demi-tour suit la route déjà parcourue : sa longueur est celle du chemin fait depuis la porte.
        assert.ok(near(lengthOf(toDoor), t * lengthOf(out)), `${key} : demi-tour hors de la route`);
      }
    });
  }
});

test("assertPure", async () => {
  await assertPure("paths.js");
});
