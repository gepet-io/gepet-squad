"use strict";
// Suivi du journal `events.jsonl` par offset (ADR 0003) et identifiants de reprise SSE.
//
// Sous Windows, `fs.watch` n'est pas fiable : on interroge le fichier avec `fs.watchFile` (500 ms par défaut) et on
// lit les octets ajoutés depuis le dernier offset. Les fonctions de décision sont pures (splitLines,
// parseJournalLine, isRotation, formatEventId, parseEventId, planResume) et testées sans disque. Seul `createTail`
// touche au disque.
//
// Offset : nombre d'OCTETS lus dans `events.jsonl`, toujours à la fin d'une ligne complète (après son `\n`). Une
// ligne en cours d'écriture (sans `\n`) n'est pas consommée : elle est relue au passage suivant.
//
// Génération : numéro qui change quand `events.jsonl` est recréé (rotation). L'identifiant SSE d'un événement est
// `<génération>:<offset>` ; l'offset n'a de sens que dans sa génération. La génération initiale est choisie par
// l'appelant (le serveur prend l'horloge) : après un redémarrage du serveur, les anciens identifiants sont donc
// d'une autre génération et reçoivent un instantané complet plutôt qu'un rejeu faux.

const fs = require("fs");

const { validate: validateEvent } = require("../../hooks/lib/schema.cjs");

const DEFAULT_INTERVAL_MS = 500;
// Une ligne valide fait au plus 4 Ko (schéma v1) : au-delà, un fragment sans `\n` n'est pas une ligne en cours
// d'écriture mais du bruit, qu'on saute pour ne pas le relire indéfiniment.
const MAX_PARTIAL_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Découpe un tampon en lignes complètes.
 * @param {Buffer} buffer octets lus à partir de `startOffset` dans le fichier
 * @param {number} [startOffset] offset du premier octet du tampon
 * @returns {{ lines: { text: string, end: number }[], consumed: number }} `end` est l'offset qui suit le `\n` de la
 *   ligne ; `consumed` est l'offset qui suit le dernier `\n` (donc `startOffset` si le tampon n'en contient aucun).
 *   Un `\r` final est retiré du texte ; le texte d'une ligne vide est "".
 */
function splitLines(buffer, startOffset = 0) {
  const lines = [];
  let from = 0;
  for (;;) {
    const newline = buffer.indexOf(0x0a, from);
    if (newline === -1) break;
    let to = newline;
    if (to > from && buffer[to - 1] === 0x0d) to -= 1;
    lines.push({ text: buffer.toString("utf8", from, to), end: startOffset + newline + 1 });
    from = newline + 1;
  }
  return { lines, consumed: startOffset + from };
}

/**
 * Événement d'une ligne du journal, ou null si la ligne est vide, n'est pas du JSON, ou ne passe pas `validate()`.
 * @param {string} text
 * @param {(event: unknown) => { valid: boolean }} [validate]
 */
function parseJournalLine(text, validate = validateEvent) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return validate(value).valid ? value : null;
}

const hasIno = (ino) => ino !== undefined && ino !== null && ino !== 0 && ino !== 0n;

/**
 * Vrai si `events.jsonl` a été recréé : il est plus petit que l'offset déjà lu, ou ce n'est plus le même fichier
 * (numéro d'inode différent, quand le système en donne un).
 * @param {{ offset: number, ino?: number | bigint }} previous
 * @param {{ size: number, ino?: number | bigint }} current
 */
function isRotation(previous, current) {
  if (current.size < previous.offset) return true;
  return hasIno(previous.ino) && hasIno(current.ino) && previous.ino !== current.ino;
}

/** Identifiant SSE : `<génération>:<offset>`. */
function formatEventId(generation, offset) {
  return `${generation}:${offset}`;
}

/**
 * Lit un `Last-Event-ID`. Renvoie null pour une valeur absente, mal formée ou hors limites.
 * @param {unknown} value
 * @returns {{ generation: number, offset: number } | null}
 */
function parseEventId(value) {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,16}):(\d{1,16})$/.exec(value.trim());
  if (!match) return null;
  const generation = Number(match[1]);
  const offset = Number(match[2]);
  if (!Number.isSafeInteger(generation) || !Number.isSafeInteger(offset)) return null;
  return { generation, offset };
}

/**
 * Décide quoi envoyer à un client qui se connecte.
 * - pas de `Last-Event-ID` : le flux seul ;
 * - `Last-Event-ID` de la génération courante, dans les limites du fichier : les événements postérieurs à cet offset ;
 * - `Last-Event-ID` inconnu, mal formé, d'une autre génération ou au-delà de la fin du fichier : un instantané
 *   complet, puis le flux.
 * @param {string | undefined} lastEventId
 * @param {{ generation: number, end: number }} position génération courante et offset de fin (consommé)
 * @returns {{ snapshot: boolean, after: number | null }} `after` : offset à partir duquel rejouer, ou null (aucun rejeu)
 */
function planResume(lastEventId, position) {
  if (lastEventId === undefined || lastEventId === null || lastEventId === "") return { snapshot: false, after: null };
  const id = parseEventId(lastEventId);
  if (id === null || id.generation !== position.generation || id.offset > position.end) {
    return { snapshot: true, after: null };
  }
  return { snapshot: false, after: id.offset };
}

// ---------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------

/** Lit les octets [from, to) d'un fichier. Renvoie un tampon plus court si le fichier a rétréci entre-temps. */
function readRange(file, from, to) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    let filled = 0;
    while (filled < buffer.length) {
      const read = fs.readSync(fd, buffer, filled, buffer.length - filled, from + filled);
      if (read === 0) break;
      filled += read;
    }
    return filled === buffer.length ? buffer : buffer.subarray(0, filled);
  } finally {
    fs.closeSync(fd);
  }
}

const statOrNull = (file) => {
  try {
    return fs.statSync(file, { bigint: true });
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
    throw error;
  }
};

/**
 * Suivi de `events.jsonl`.
 * @param {object} options
 * @param {string} options.file chemin de `events.jsonl`
 * @param {string} [options.rotatedFile] chemin de `events.1.jsonl` : à la rotation, ce qui restait à lire dans
 *   l'ancien fichier y est rattrapé (avec l'ancienne génération)
 * @param {number} [options.intervalMs] période de `fs.watchFile` (500 ms)
 * @param {number} [options.generation] génération initiale (1)
 * @param {(entry: { event: object, generation: number, offset: number }) => void} options.onEvent
 * @param {(generation: number) => void} [options.onRotate] appelé après chaque rotation, avec la nouvelle génération
 * @param {(count: number) => void} [options.onSkip] nombre de lignes complètes ignorées (JSON invalide, validate() faux)
 * @param {(error: Error) => void} [options.onError] erreur d'accès au fichier (le suivi continue)
 * @param {(event: unknown) => { valid: boolean }} [options.validate] contrôle d'un événement (défaut : schéma v1)
 */
function createTail({
  file,
  rotatedFile,
  intervalMs = DEFAULT_INTERVAL_MS,
  generation = 1,
  onEvent,
  onRotate = () => {},
  onSkip = () => {},
  onError = () => {},
  validate = validateEvent,
}) {
  let offset = 0;
  let ino;
  let currentGeneration = generation;
  let watching = false;
  let catchUp = null;
  let reading = false;

  function emitLines(lines, gen) {
    let skipped = 0;
    for (const { text, end } of lines) {
      if (text.trim() === "") continue;
      const event = parseJournalLine(text, validate);
      if (event === null) skipped += 1;
      else onEvent({ event, generation: gen, offset: end });
    }
    if (skipped > 0) onSkip(skipped);
  }

  /** Lit [offset, size) de `file` ; avance `offset` jusqu'à la dernière ligne complète. */
  function readNew(size) {
    if (size <= offset) return;
    const start = offset;
    const buffer = readRange(file, start, size);
    const { lines, consumed } = splitLines(buffer, start);
    const partial = buffer.length - (consumed - start); // octets d'une ligne sans `\n` (en cours d'écriture)
    offset = consumed;
    if (partial > MAX_PARTIAL_BYTES) {
      offset = start + buffer.length; // bruit sans fin de ligne : on le saute
      onSkip(1);
    }
    emitLines(lines, currentGeneration);
  }

  /** Rattrape la fin de l'ancien fichier après une rotation (events.jsonl -> events.1.jsonl). */
  function drainRotated(previousOffset, previousIno) {
    if (!rotatedFile) return;
    const stat = statOrNull(rotatedFile);
    if (stat === null) return;
    // Ce doit être l'ancien fichier : même inode (quand il est connu) et au moins aussi long que ce qu'on a lu.
    if (hasIno(previousIno) && hasIno(stat.ino) && previousIno !== stat.ino) return;
    const size = Number(stat.size);
    if (size <= previousOffset) return;
    const buffer = readRange(rotatedFile, previousOffset, size);
    emitLines(splitLines(buffer, previousOffset).lines, currentGeneration);
  }

  /** Un passage : détecte la rotation, lit les octets ajoutés, émet les événements. Ne lève jamais. */
  function poll() {
    if (reading) return;
    reading = true;
    try {
      const stat = statOrNull(file);
      if (stat === null) return; // pas (encore) de journal
      const size = Number(stat.size);
      if (isRotation({ offset, ino }, { size, ino: stat.ino })) {
        try {
          drainRotated(offset, ino);
        } catch (error) {
          onError(error);
        }
        currentGeneration += 1;
        offset = 0;
        ino = stat.ino;
        onRotate(currentGeneration);
      }
      ino = stat.ino;
      readNew(size);
    } catch (error) {
      onError(error);
    } finally {
      reading = false;
    }
  }

  const listener = () => poll();

  return {
    /** Lit tout le fichier existant (de façon synchrone, événements émis dans l'ordre), puis surveille les ajouts. */
    start() {
      if (watching) return;
      watching = true;
      poll();
      fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);
      // `fs.watchFile` prend son état de référence de façon asynchrone : une ligne ajoutée entre le `poll()` ci-dessus
      // et cette première mesure ferait partie de la référence et ne déclencherait jamais de changement. Un passage
      // de rattrapage, une période plus tard, la lit.
      catchUp = setTimeout(poll, intervalMs);
      catchUp.unref();
    },
    poll,
    stop() {
      if (!watching) return;
      watching = false;
      clearTimeout(catchUp);
      fs.unwatchFile(file, listener);
    },
    /** Génération courante. */
    get generation() {
      return currentGeneration;
    },
    /** Offset de fin du dernier événement lu (fin de la dernière ligne complète). */
    get offset() {
      return offset;
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  MAX_PARTIAL_BYTES,
  splitLines,
  parseJournalLine,
  isRotation,
  formatEventId,
  parseEventId,
  planResume,
  createTail,
};
