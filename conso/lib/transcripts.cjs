// Lecture d'une ligne de transcript Claude Code (ADR 0013). Module pur : aucune I/O.
// Seuls type, timestamp, message.id, message.model et les quatre compteurs sont lus.
"use strict";

const SYNTHETIC = "<synthetic>";

function counter(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Transforme une ligne JSONL en { messageId, model, ts, usage }, en { sidechain: true }
 * pour une ligne isSidechain, ou en null (sans usage, illisible, synthétique, compteurs nuls).
 * Ne lève jamais d'exception.
 */
function parseUsageLine(line) {
  if (typeof line !== "string" || !line.includes('"usage"')) return null;
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object") return null;
  if (obj.isSidechain === true) return { sidechain: true };
  if (obj.type !== "assistant") return null;
  const message = obj.message;
  if (message === null || typeof message !== "object") return null;
  const { id, model, usage } = message;
  if (typeof id !== "string" || id === "") return null;
  if (typeof model !== "string" || model === SYNTHETIC) return null;
  if (usage === null || typeof usage !== "object") return null;
  const counters = {
    input: counter(usage.input_tokens),
    output: counter(usage.output_tokens),
    cacheRead: counter(usage.cache_read_input_tokens),
    cacheWrite: counter(usage.cache_creation_input_tokens),
  };
  if (counters.input + counters.output + counters.cacheRead + counters.cacheWrite === 0) return null;
  const ts = typeof obj.timestamp === "string" ? obj.timestamp : null;
  return { messageId: id, model, ts, usage: counters };
}

/** Déduplique par messageId en gardant la dernière occurrence ; ignore null et { sidechain }. */
function dedupeByMessageId(entries) {
  const byId = new Map();
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || typeof entry.messageId !== "string") continue;
    byId.delete(entry.messageId);
    byId.set(entry.messageId, entry);
  }
  return [...byId.values()];
}

module.exports = { parseUsageLine, dedupeByMessageId };
