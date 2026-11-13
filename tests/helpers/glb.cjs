// Lecture du chunk JSON d'un GLB (glTF binaire 2.0), sans WebGL ni dépendance.
//   const { readGlb } = require("../helpers/glb.cjs");
//   readGlb(buffer) → { json, clips, embeddedImages, externalImages }
// Lève une Error si le buffer n'est pas un GLB valide (en-tête, version, longueur ou chunk JSON tronqué).
const MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"

function readGlb(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 20) throw new Error("GLB tronqué : en-tête incomplet");
  if (buffer.readUInt32LE(0) !== MAGIC) throw new Error("GLB invalide : magic absent");
  const version = buffer.readUInt32LE(4);
  if (version !== 2) throw new Error(`GLB invalide : version ${version} non gérée`);
  const total = buffer.readUInt32LE(8);
  if (total > buffer.length) throw new Error("GLB tronqué : longueur déclarée supérieure à la taille du fichier");
  const chunkLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== CHUNK_JSON) throw new Error("GLB invalide : le premier chunk n'est pas du JSON");
  if (20 + chunkLength > buffer.length) throw new Error("GLB tronqué : chunk JSON incomplet");

  const json = JSON.parse(buffer.subarray(20, 20 + chunkLength).toString("utf8"));
  const images = Array.isArray(json.images) ? json.images : [];
  return {
    json,
    clips: (json.animations || []).map((a) => a.name),
    // Image embarquée : stockée dans le binaire (bufferView). La CSP de l'ADR 0005 refuse le blob: qui en résulte.
    embeddedImages: images.filter((i) => i.bufferView !== undefined),
    // Image externe : chemin relatif (uri) à résoudre depuis le dossier du GLB.
    externalImages: images.filter((i) => typeof i.uri === "string").map((i) => i.uri),
  };
}

module.exports = { readGlb };
