// Intégration : les addons glTF vendorés (GLTFLoader, SkeletonUtils) se chargent sous Node via le crochet de
// résolution de `three`, et GLTFLoader.parse() lit un GLB minimal construit en mémoire (un mesh, sans image).
import "./three-register.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const THREE = await import("three");
const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
const SkeletonUtils = await import("three/addons/utils/SkeletonUtils.js");

/** GLB 2.0 : un triangle, un nœud "Triangle", aucune image ni texture. */
function minimalGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Triangle" }],
    meshes: [{ name: "Triangle", primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json));
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  const out = Buffer.alloc(total);
  let o = 0;
  out.writeUInt32LE(0x46546c67, o); o += 4; // "glTF"
  out.writeUInt32LE(2, o); o += 4;
  out.writeUInt32LE(total, o); o += 4;
  out.writeUInt32LE(jsonBuf.length, o); o += 4;
  out.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
  jsonBuf.copy(out, o); o += jsonBuf.length;
  out.writeUInt32LE(bin.length, o); o += 4;
  out.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
  bin.copy(out, o);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
}

test("GLTFLoader et SkeletonUtils s'importent et exposent leur API", () => {
  assert.equal(typeof GLTFLoader, "function");
  assert.equal(typeof SkeletonUtils.clone, "function");
});

test("GLTFLoader.parse d'un GLB minimal produit une scène contenant le mesh", async () => {
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(minimalGlb(), "", resolve, reject));
  const meshes = [];
  gltf.scene.traverse((object) => { if (object.isMesh) meshes.push(object); });
  assert.equal(meshes.length, 1);
  assert.equal(meshes[0].name, "Triangle");
  assert.equal(meshes[0].geometry.getAttribute("position").count, 3);
});

test("SkeletonUtils.clone duplique la scène chargée sans partager les objets", async () => {
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(minimalGlb(), "", resolve, reject));
  const copy = SkeletonUtils.clone(gltf.scene);
  assert.notEqual(copy, gltf.scene);
  const mesh = copy.getObjectByProperty("isMesh", true);
  assert.ok(mesh instanceof THREE.Mesh);
  assert.equal(mesh.name, "Triangle");
  assert.notEqual(mesh, gltf.scene.getObjectByProperty("isMesh", true));
});
