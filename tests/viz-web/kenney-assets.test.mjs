// Intégrité des assets Kenney vendorés (ADR 0010) : fichiers conformes à SOURCE.md, clips requis, aucune image
// embarquée (la CSP refuse blob:), textures externes présentes, licences CC0.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { readGlb } = require("../helpers/glb.cjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const KENNEY = path.join(ROOT, "viz/public/vendor/kenney");
const REQUIRED_CLIPS = ["idle", "walk", "sit", "interact-right", "emote-yes", "emote-no", "holding-both"];
const REQUIRED_FURNITURE = [
  "desk", "chairDesk", "computerScreen", "computerKeyboard", "laptop", "doorway", "wall", "wallWindow",
  "floorFull", "table", "bookcaseOpen", "pottedPlant", "kitchenCoffeeMachine",
];

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const listGlb = (dir) => fs.readdirSync(path.join(KENNEY, dir)).filter((f) => f.endsWith(".glb")).sort();

// Lignes « - `chemin` sha256 » de SOURCE.md.
const entries = [...fs.readFileSync(path.join(KENNEY, "SOURCE.md"), "utf8").matchAll(/^- `([^`]+)` ([0-9a-f]{64})$/gm)]
  .map((m) => ({ file: m[1], sha: m[2] }));

describe("SOURCE.md", () => {
  test("liste les personnages, la texture, les meubles et les licences", () => {
    const files = entries.map((e) => e.file);
    assert.equal(files.filter((f) => /^characters\/[^/]+\.glb$/.test(f)).length, 7);
    assert.ok(files.includes("characters/Textures/colormap.png"));
    for (const name of REQUIRED_FURNITURE) assert.ok(files.includes(`furniture/${name}.glb`), `${name}.glb absent de SOURCE.md`);
    assert.ok(files.includes("LICENSE-mini-characters.txt"));
    assert.ok(files.includes("LICENSE-furniture-kit.txt"));
  });

  test("chaque fichier listé existe et son sha256 correspond", () => {
    assert.ok(entries.length > 0);
    for (const { file, sha } of entries) {
      const full = path.join(KENNEY, file);
      assert.ok(fs.existsSync(full), `${file} listé dans SOURCE.md mais absent`);
      assert.equal(sha256(full), sha, `sha256 différent pour ${file}`);
    }
  });

  test("aucun fichier vendoré ne manque à SOURCE.md", () => {
    const listed = new Set(entries.map((e) => e.file));
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(path.join(dir, d.name)) : [path.relative(KENNEY, path.join(dir, d.name)).split(path.sep).join("/")]);
    for (const f of walk(KENNEY).filter((f) => f !== "SOURCE.md")) assert.ok(listed.has(f), `${f} absent de SOURCE.md`);
  });
});

describe("personnages", () => {
  const chars = listGlb("characters");

  test("exactement 7 personnages", () => assert.equal(chars.length, 7));

  for (const file of chars) {
    test(`${file} : clips requis, aucune image embarquée, textures externes présentes`, () => {
      const glb = readGlb(fs.readFileSync(path.join(KENNEY, "characters", file)));
      for (const clip of REQUIRED_CLIPS) assert.ok(glb.clips.includes(clip), `clip ${clip} manquant`);
      assert.deepEqual(glb.embeddedImages, [], "image embarquée interdite par la CSP");
      assert.ok(glb.externalImages.length > 0, "le personnage devrait référencer une texture externe");
      for (const uri of glb.externalImages) {
        assert.ok(fs.existsSync(path.join(KENNEY, "characters", uri)), `texture ${uri} absente`);
      }
    });
  }
});

describe("mobilier", () => {
  test("contient la liste requise, sans image embarquée", () => {
    const files = listGlb("furniture");
    assert.ok(files.length >= 13);
    for (const name of REQUIRED_FURNITURE) assert.ok(files.includes(`${name}.glb`), `${name}.glb manquant`);
    for (const file of files) {
      const glb = readGlb(fs.readFileSync(path.join(KENNEY, "furniture", file)));
      assert.deepEqual(glb.embeddedImages, [], `${file} embarque une image`);
      for (const uri of glb.externalImages) assert.ok(fs.existsSync(path.join(KENNEY, "furniture", uri)), `texture ${uri} absente`);
    }
  });
});

describe("licences", () => {
  for (const file of ["LICENSE-mini-characters.txt", "LICENSE-furniture-kit.txt"]) {
    test(`${file} est présente et mentionne CC0`, () => {
      assert.match(fs.readFileSync(path.join(KENNEY, file), "utf8"), /CC0/);
    });
  }
});
