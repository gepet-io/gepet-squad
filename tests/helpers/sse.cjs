// Client SSE minimal basé sur node:http, plus le parseur du flux.
const http = require("http");

/**
 * Parseur incrémental du format text/event-stream.
 * `feed(chunk)` accepte des morceaux découpés n'importe où et renvoie les événements complets.
 * Un événement est { event, data, id, retry } ; `event` vaut "message" par défaut.
 * Les commentaires (lignes commençant par ":") sont ignorés.
 */
function createSseParser() {
  let buffer = "";
  let current = { event: "", data: [], id: undefined, retry: undefined };

  function dispatch(out) {
    if (current.data.length > 0) {
      const evt = { event: current.event || "message", data: current.data.join("\n") };
      if (current.id !== undefined) evt.id = current.id;
      if (current.retry !== undefined) evt.retry = current.retry;
      out.push(evt);
    }
    current = { event: "", data: [], id: undefined, retry: undefined };
  }

  function feed(chunk) {
    buffer += chunk;
    const out = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(buffer);
      if (!match) break;
      // Un "\r" final peut être suivi d'un "\n" dans le morceau suivant : on attend.
      if (match[0] === "\r" && match.index + 1 === buffer.length) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      if (line === "") {
        dispatch(out);
      } else if (!line.startsWith(":")) {
        const sep = line.indexOf(":");
        const field = sep === -1 ? line : line.slice(0, sep);
        let value = sep === -1 ? "" : line.slice(sep + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") current.event = value;
        else if (field === "data") current.data.push(value);
        else if (field === "id") current.id = value;
        else if (field === "retry" && /^\d+$/.test(value)) current.retry = Number(value);
      }
    }
    return out;
  }

  return { feed };
}

/** Parse un texte SSE complet en liste d'événements. */
function parseSse(text) {
  return createSseParser().feed(text);
}

/**
 * Ouvre une connexion SSE. Résout dès que les en-têtes de la réponse sont reçus.
 * @param {string} url
 * @param {{ headers?: object, timeoutMs?: number }} options
 * @returns {Promise<{ status: number, headers: object, events: object[], waitFor: (predicate: (events: object[]) => boolean, timeoutMs?: number) => Promise<object[]>, close: () => void }>}
 */
function openSse(url, { headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const parser = createSseParser();
    const events = [];
    const waiters = new Set();

    const notify = () => {
      for (const waiter of [...waiters]) waiter();
    };

    const req = http.get(url, { headers: { Accept: "text/event-stream", ...headers } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        events.push(...parser.feed(chunk));
        notify();
      });
      // Le timeout d'inactivité ne vaut que jusqu'aux en-têtes : un flux SSE peut rester silencieux
      // entre deux battements (15 s d'après l'ADR 0002).
      req.setTimeout(0);
      let closed = false;
      res.on("close", () => {
        closed = true;
        notify();
      });

      const waitFor = (predicate, waitMs = timeoutMs) =>
        new Promise((resolveWait, rejectWait) => {
          const check = () => {
            if (predicate(events)) {
              clearTimeout(timer);
              waiters.delete(check);
              resolveWait(events);
            } else if (closed) {
              clearTimeout(timer);
              waiters.delete(check);
              rejectWait(new Error(`SSE : flux fermé avant la condition attendue (${events.length} événement(s) reçu(s))`));
            }
          };
          const timer = setTimeout(() => {
            waiters.delete(check);
            rejectWait(new Error(`SSE : délai de ${waitMs} ms dépassé (${events.length} événement(s) reçu(s))`));
          }, waitMs);
          waiters.add(check);
          check();
        });

      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        waitFor,
        close: () => {
          req.destroy();
          res.destroy();
        },
      });
    });

    req.setTimeout(timeoutMs, () => req.destroy(new Error(`SSE : pas de réponse en ${timeoutMs} ms`)));
    req.on("error", reject);
  });
}

module.exports = { createSseParser, parseSse, openSse };
