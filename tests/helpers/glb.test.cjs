const test = require("node:test");
const assert = require("node:assert/strict");
const { readGlb } = require("./glb.cjs");

// GLB minimal construit en mémoire : en-tête 12 octets + chunk JSON (rembourré à 4 octets avec des espaces).
function buildGlb(json) {
  let text = JSON.stringify(json);
  while (Buffer.byteLength(text) % 4 !== 0) text += " ";
  const body = Buffer.from(text, "utf8");
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + body.length, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, body]);
}

test("readGlb lit les noms des clips d'animation", () => {
  const glb = buildGlb({ asset: { version: "2.0" }, animations: [{ name: "idle" }, { name: "walk" }] });
  assert.deepEqual(readGlb(glb).clips, ["idle", "walk"]);
});

test("readGlb sans animation ni image renvoie des listes vides", () => {
  const r = readGlb(buildGlb({ asset: { version: "2.0" } }));
  assert.deepEqual(r.clips, []);
  assert.deepEqual(r.embeddedImages, []);
  assert.deepEqual(r.externalImages, []);
});

test("readGlb détecte une image embarquée (bufferView)", () => {
  const r = readGlb(buildGlb({ images: [{ bufferView: 3, mimeType: "image/png" }] }));
  assert.equal(r.embeddedImages.length, 1);
  assert.deepEqual(r.externalImages, []);
});

test("readGlb détecte une image externe (uri)", () => {
  const r = readGlb(buildGlb({ images: [{ uri: "Textures/colormap.png" }] }));
  assert.deepEqual(r.externalImages, ["Textures/colormap.png"]);
  assert.deepEqual(r.embeddedImages, []);
});

test("readGlb rejette un fichier tronqué", () => {
  const glb = buildGlb({ animations: [{ name: "idle" }] });
  assert.throws(() => readGlb(glb.subarray(0, glb.length - 8)), /tronqué/);
  assert.throws(() => readGlb(glb.subarray(0, 10)), /tronqué/);
});

test("readGlb rejette un fichier qui n'est pas un GLB", () => {
  assert.throws(() => readGlb(Buffer.from("x".repeat(40))), /magic/);
});
