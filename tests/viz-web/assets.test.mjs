// Manifeste des assets 3D (viz/public/js/assets.js, ADR 0010) : forme, unicité, sélection par rôle, immutabilité, pureté,
// et cohérence avec SOURCE.md, le disque et le contenu réel des GLB (lecteur tests/helpers/glb.cjs).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertPure } from "./support.mjs";

const require = createRequire(import.meta.url);
const { readGlb } = require("../helpers/glb.cjs");

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../viz/public");
const { ASSETS, ROLES, characterFor } = await import(pathToFileURL(path.join(PUBLIC, "js/assets.js")).href);

const ALL_ROLES = ["chef-de-projet", "architecte", "developpeur", "verificateur", "testeur"];
const all = () => [...ASSETS.characters, ...ASSETS.furniture];

describe("forme du manifeste", () => {
  test("les rôles sont les cinq rôles de la squad", () => assert.deepEqual([...ROLES], ALL_ROLES));

  test("chaque personnage a id, rôle connu, chemin sous vendor/kenney/characters, échelle et clips", () => {
    for (const c of ASSETS.characters) {
      assert.equal(typeof c.id, "string");
      assert.ok(ALL_ROLES.includes(c.role), `rôle inconnu : ${c.role}`);
      assert.match(c.path, /^vendor\/kenney\/characters\/[^/]+\.glb$/);
      assert.ok(Number.isFinite(c.scale) && c.scale > 0);
      assert.ok(Array.isArray(c.clips) && c.clips.length > 0);
      for (const clip of ["idle", "walk", "sit"]) assert.ok(c.clips.includes(clip), `${c.id} sans clip ${clip}`);
    }
  });

  test("chaque meuble a id, chemin sous vendor/kenney/furniture et échelle", () => {
    assert.ok(ASSETS.furniture.length >= 13);
    for (const f of ASSETS.furniture) {
      assert.equal(typeof f.id, "string");
      assert.match(f.path, /^vendor\/kenney\/furniture\/[^/]+\.glb$/);
      assert.ok(Number.isFinite(f.scale) && f.scale > 0);
    }
  });

  test("la texture partagée est sous vendor/kenney/characters/Textures", () => {
    assert.match(ASSETS.texture.path, /^vendor\/kenney\/characters\/Textures\/[^/]+\.png$/);
  });

  test("un modèle par rôle sauf 3 pour developpeur, soit 7 personnages", () => {
    const count = (role) => ASSETS.characters.filter((c) => c.role === role).length;
    for (const role of ALL_ROLES) assert.equal(count(role), role === "developpeur" ? 3 : 1, role);
    assert.equal(ASSETS.characters.length, 7);
  });

  test("les chemins et les identifiants sont uniques", () => {
    const paths = all().map((a) => a.path);
    assert.equal(new Set(paths).size, paths.length);
    const ids = all().map((a) => a.id);
    assert.equal(new Set(ids).size, ids.length);
  });
});

describe("characterFor", () => {
  test("renvoie le modèle unique des rôles non développeur, quel que soit l'index", () => {
    for (const role of ["chef-de-projet", "architecte", "verificateur", "testeur"]) {
      const model = characterFor(role, 0);
      assert.equal(model.role, role);
      for (let i = 1; i < 6; i++) assert.equal(characterFor(role, i), model);
    }
  });

  test("les quatre rôles uniques ont des modèles distincts", () => {
    const ids = ["chef-de-projet", "architecte", "verificateur", "testeur"].map((r) => characterFor(r, 0).id);
    assert.equal(new Set(ids).size, 4);
  });

  test("developpeur : le modèle index % 3, avec trois modèles distincts", () => {
    const models = [0, 1, 2, 3, 4, 5].map((i) => characterFor("developpeur", i));
    for (const m of models) assert.equal(m.role, "developpeur");
    assert.equal(new Set(models.slice(0, 3).map((m) => m.id)).size, 3);
    for (let i = 3; i < 6; i++) assert.equal(models[i], models[i - 3]);
  });

  test("rôle inconnu : null", () => {
    assert.equal(characterFor("pirate", 0), null);
    assert.equal(characterFor(undefined), null);
    assert.equal(characterFor("", 2), null);
  });
});

describe("immutabilité", () => {
  test("le manifeste est gelé en profondeur", () => {
    const frozen = (v) => {
      assert.ok(Object.isFrozen(v));
      if (v && typeof v === "object") Object.values(v).forEach(frozen);
    };
    frozen(ASSETS);
    frozen(ROLES);
  });

  test("toute modification échoue et ne change rien", () => {
    assert.throws(() => { ASSETS.characters[0].scale = 99; }, TypeError);
    assert.throws(() => { ASSETS.characters.push({}); }, TypeError);
    assert.throws(() => { ASSETS.characters[0].clips.push("x"); }, TypeError);
    assert.throws(() => { ASSETS.furniture[0].path = "x"; }, TypeError);
    assert.notEqual(ASSETS.characters[0].scale, 99);
  });
});

test("assets.js est pur", async () => {
  await assertPure("assets.js");
});

describe("intégration : manifeste, SOURCE.md, disque et GLB", () => {
  const source = fs.readFileSync(path.join(PUBLIC, "vendor/kenney/SOURCE.md"), "utf8");
  const listed = new Set([...source.matchAll(/^- `([^`]+)` [0-9a-f]{64}$/gm)].map((m) => m[1]));
  const rel = (p) => p.replace(/^vendor\/kenney\//, "");

  test("chaque chemin du manifeste figure dans SOURCE.md et existe sur disque", () => {
    for (const a of [...all(), ASSETS.texture]) {
      assert.ok(listed.has(rel(a.path)), `${a.path} absent de SOURCE.md`);
      assert.ok(fs.existsSync(path.join(PUBLIC, a.path)), `${a.path} absent du disque`);
    }
  });

  test("les clips requis de chaque personnage existent dans son GLB", () => {
    for (const c of ASSETS.characters) {
      const { clips } = readGlb(fs.readFileSync(path.join(PUBLIC, c.path)));
      const missing = c.clips.filter((clip) => !clips.includes(clip));
      assert.deepEqual(missing, [], `${c.id} : clips manquants`);
    }
  });

  test("tous les personnages vendorés sont dans le manifeste", () => {
    const used = new Set(ASSETS.characters.map((c) => rel(c.path)));
    for (const f of listed) if (/^characters\/[^/]+\.glb$/.test(f)) assert.ok(used.has(f), `${f} vendoré mais inutilisé`);
  });
});
