"use strict";
// Routage HTTP, protections de l'ADR 0005 et fichiers statiques du serveur de visualisation.
//
// Les fonctions de décision sont pures (isAllowedHost, isAllowedMethod, resolveStaticPath, mimeFor, importmapHash,
// buildCsp, buildHeaders) et testées sans réseau. Seul createRequestListener touche au disque et à la réponse.
//
// Routes : GET/HEAD /health -> { ok: true, pid: <pid du serveur> } (le pid fait de /health la preuve de vie du verrou,
// voir lib/lock.cjs) ; GET/HEAD /state -> état fusionné ; GET /events -> flux SSE (voir
// createSseHub) ; tout le reste -> fichier statique du dossier public. Ordre des contrôles : Host (421), méthode (405),
// cible de la requête (400), puis le routage.
// Aucune réponse ne porte d'en-tête CORS, et toutes portent la CSP, `nosniff` et `Referrer-Policy: no-referrer`.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Liste blanche des types servis (ADR 0005). Toute autre extension reçoit 404.
const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".glb": "model/gltf-binary", // modèles 3D (ADR 0010) ; ni .gltf ni .bin
});

const ALLOWED_METHODS = Object.freeze(["GET", "HEAD"]);
const TEXT = "text/plain; charset=utf-8";

// Messages d'erreur fixes : jamais d'écho du chemin ni des en-têtes reçus.
const MESSAGES = Object.freeze({
  400: "Requête invalide.",
  403: "Accès interdit.",
  404: "Introuvable.",
  405: "Méthode non autorisée.",
  421: "Hôte non autorisé.",
  500: "Erreur interne du serveur.",
});

// ---------------------------------------------------------------------------------------------------------------
// Fonctions pures
// ---------------------------------------------------------------------------------------------------------------

/**
 * Vrai si l'en-tête `Host` désigne ce serveur : `127.0.0.1:<port>` ou `localhost:<port>` (rien d'autre). C'est la
 * protection contre le DNS rebinding : un site tiers résolu vers 127.0.0.1 envoie son propre nom de domaine.
 * Le port 80 est le seul cas où un navigateur omet le port.
 * @param {unknown} host valeur de l'en-tête
 * @param {number} port port d'écoute réel
 */
function isAllowedHost(host, port) {
  if (typeof host !== "string" || !Number.isInteger(port) || port < 0 || port > 65535) return false;
  const value = host.toLowerCase();
  if (value === `127.0.0.1:${port}` || value === `localhost:${port}`) return true;
  return port === 80 && (value === "127.0.0.1" || value === "localhost");
}

/** Vrai pour GET et HEAD, les seules méthodes acceptées (sensible à la casse, comme le protocole). */
function isAllowedMethod(method) {
  return ALLOWED_METHODS.includes(method);
}

/** Type MIME de la liste blanche pour un nom de fichier, ou null (insensible à la casse de l'extension). */
function mimeFor(filePath) {
  const ext = path.extname(String(filePath)).toLowerCase();
  return Object.hasOwn(MIME_TYPES, ext) ? MIME_TYPES[ext] : null;
}

/**
 * Résout la cible d'une requête vers un fichier du dossier public, sans accès au disque.
 * - la requête et le fragment sont ignorés ; le chemin est décodé (`%2e%2e`, `..%2f`) AVANT la vérification ;
 * - `/` désigne `index.html` ;
 * - le chemin résolu doit rester sous `publicDir` (sinon 403), y compris avec des `\` sous Windows ;
 * - une extension hors liste blanche donne 404.
 * @param {string} publicDir dossier public (chemin absolu)
 * @param {string} rawTarget cible brute de la requête (`req.url`), qui commence par `/`
 * @param {typeof path} [pathApi] `path.win32` / `path.posix` pour tester l'autre plateforme
 * @returns {{ status: 200, file: string, mime: string } | { status: 400 | 403 | 404 }}
 */
function resolveStaticPath(publicDir, rawTarget, pathApi = path) {
  if (typeof rawTarget !== "string" || !rawTarget.startsWith("/")) return { status: 400 };

  const rawPath = rawTarget.split(/[?#]/, 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 }; // pourcentage mal formé
  }
  // Un octet nul tronque les chemins dans certaines API : refus net.
  if (decoded.includes("\0")) return { status: 403 };

  const relative = decoded === "/" ? "index.html" : decoded;
  // `resolve` interprète `..` ; le préfixe `./` empêche un chemin absolu ou un lecteur (`C:`) de remplacer la racine.
  const root = pathApi.resolve(publicDir);
  const file = pathApi.resolve(root, "." + (relative.startsWith("/") ? relative : "/" + relative));
  if (!isInside(root, file, pathApi)) return { status: 403 };

  const mime = mimeFor(file);
  if (mime === null) return { status: 404 };
  return { status: 200, file, mime };
}

/** Vrai si `target` est `root` ou se trouve dessous (comparaison de chemins résolus). */
function isInside(root, target, pathApi = path) {
  const relative = pathApi.relative(root, target);
  // Un nom comme « ..cache » reste sous la racine : seul un premier segment égal à « .. » en sort.
  return relative === "" || (!pathApi.isAbsolute(relative) && relative.split(/[\\/]/)[0] !== "..");
}

/**
 * Empreinte CSP (`sha256-<base64>`) du premier `<script type="importmap">` de la page, ou null s'il n'y en a pas.
 * Le navigateur hache le texte du script après normalisation des fins de ligne (CRLF et CR deviennent LF) : on fait
 * de même, sinon un `index.html` en CRLF aurait une empreinte fausse.
 * @param {string} html contenu de index.html
 */
function importmapHash(html) {
  const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of String(html).matchAll(scripts)) {
    if (/(?:^|\s)type\s*=\s*(?:"importmap"|'importmap'|importmap(?=[\s/>]|$))/i.test(match[1])) {
      const text = match[2].replace(/\r\n?/g, "\n");
      return "sha256-" + crypto.createHash("sha256").update(text, "utf8").digest("base64");
    }
  }
  return null;
}

/**
 * CSP de l'ADR 0005. `hash` est l'empreinte de l'importmap (`sha256-…`), ou null : alors aucun script inline n'est
 * autorisé.
 */
function buildCsp(hash) {
  const scriptSrc = hash ? `script-src 'self' '${hash}'` : "script-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * En-têtes d'une réponse. La CSP, `nosniff` et `Referrer-Policy` sont toujours présents ; jamais d'en-tête CORS.
 * @param {{ csp: string, contentType?: string, contentLength?: number, noStore?: boolean, allow?: string }} options
 */
function buildHeaders({ csp, contentType, contentLength, noStore = false, allow }) {
  const headers = {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (Number.isInteger(contentLength)) headers["Content-Length"] = String(contentLength);
  if (noStore) headers["Cache-Control"] = "no-store";
  if (allow) headers.Allow = allow;
  return headers;
}

// Noms d'événements SSE du contrat avec viz/public/js/state.js. Aucun autre nom n'est envoyé.
const SSE_EVENTS = Object.freeze(["evt", "snapshot", "warning"]);
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * Message SSE : `id` (facultatif), `event`, puis `data` (JSON sur une seule ligne), terminé par une ligne vide.
 * @param {{ event: "evt" | "snapshot" | "warning", data: unknown, id?: string }} message
 * @throws {Error} nom d'événement hors contrat, `id` contenant un saut de ligne, ou `data` non sérialisable
 */
function formatSse({ event, data, id }) {
  if (!SSE_EVENTS.includes(event)) throw new Error(`nom d'événement SSE hors contrat : ${String(event)}`);
  if (id !== undefined && (typeof id !== "string" || /[\r\n\0]/.test(id))) throw new Error("identifiant SSE invalide");
  const json = JSON.stringify(data);
  if (typeof json !== "string") throw new Error("data SSE non sérialisable");
  // JSON.stringify échappe les sauts de ligne : une seule ligne `data:`. U+2028/2029 sont aussi des fins de ligne
  // pour certains analyseurs : on les échappe.
  const line = json.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return (id === undefined ? "" : `id: ${id}\n`) + `event: ${event}\ndata: ${line}\n\n`;
}

/** Commentaire SSE (battement de cœur, accusé de connexion). Les navigateurs l'ignorent, les proxys le voient passer. */
function formatComment(text = "") {
  return `: ${String(text).replace(/[\r\n]+/g, " ")}\n\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------

/**
 * Ensemble des clients SSE connectés.
 * - un seul minuteur pour tous les clients (battement toutes les `heartbeatMs`), actif seulement tant qu'il y a des
 *   clients : un client déconnecté ne laisse ni minuteur ni écouteur derrière lui ;
 * - un client qui accumule plus de `maxBufferedBytes` non lus (connexion bloquée) est coupé.
 * @param {object} options
 * @param {string} options.csp valeur de l'en-tête Content-Security-Policy
 * @param {number} [options.heartbeatMs] période du battement (15 000 ms)
 * @param {number} [options.maxBufferedBytes] tampon d'écriture maximal par client
 * @param {(level: string, message: string) => void} [options.log]
 */
function createSseHub({ csp, heartbeatMs = DEFAULT_HEARTBEAT_MS, maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES, log = () => {} }) {
  const clients = new Set();
  let timer = null;

  function drop(res) {
    clients.delete(res);
    if (clients.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function write(res, text) {
    if (res.destroyed || res.writableEnded) return drop(res);
    res.write(text);
    if (res.writableLength > maxBufferedBytes) {
      log("warn", "client SSE trop lent : connexion fermée");
      res.destroy();
      drop(res);
    }
  }

  function broadcast(text) {
    for (const res of [...clients]) write(res, text);
  }

  return {
    /**
     * Ouvre le flux sur `res` : en-têtes, accusé de connexion, messages initiaux (déjà formatés), puis inscription.
     * Tout se fait de façon synchrone : aucun message diffusé ne peut s'intercaler entre les messages initiaux.
     */
    open(res, initial = []) {
      res.writeHead(200, {
        ...buildHeaders({ csp, contentType: SSE_CONTENT_TYPE, noStore: true }),
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      if (res.socket) res.socket.setNoDelay(true);
      res.write(formatComment("connecté") + initial.join(""));
      clients.add(res);
      // Un seul rappel pour « close » et « error », retiré des deux événements dès que l'un des deux survient.
      const release = () => {
        res.off("close", release);
        res.off("error", release);
        drop(res);
      };
      res.on("close", release);
      res.on("error", release);
      if (timer === null) {
        timer = setInterval(() => broadcast(formatComment("battement")), heartbeatMs);
        timer.unref();
      }
    },
    /** Envoie un texte déjà formaté (formatSse, formatComment) à tous les clients. */
    broadcast,
    /** Nombre de clients connectés. */
    get size() {
      return clients.size;
    },
    /** Coupe tous les clients et arrête le battement. */
    close() {
      for (const res of [...clients]) res.destroy();
      clients.clear();
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * Écouteur `request` de `http.createServer`.
 * @param {object} options
 * @param {() => number} options.getPort port d'écoute réel (connu après `listen`)
 * @param {() => object} options.getState état `/state` à sérialiser
 * @param {string} options.publicDir dossier des fichiers statiques
 * @param {string} options.csp valeur de l'en-tête Content-Security-Policy
 * @param {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void} [options.openEvents]
 *   ouvre le flux SSE de `GET /events` (sans lui, la route répond 404)
 * @param {(level: string, message: string) => void} [options.log] journal du serveur (stderr)
 */
function createRequestListener({ getPort, getState, publicDir, csp, openEvents, log = () => {} }) {
  const root = path.resolve(publicDir);

  function send(req, res, status, { body = "", contentType = TEXT, noStore = false, allow } = {}) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
    res.writeHead(status, buildHeaders({ csp, contentType, contentLength: buffer.length, noStore, allow }));
    res.end(req.method === "HEAD" ? undefined : buffer);
  }

  const sendError = (req, res, status, extra) => send(req, res, status, { body: MESSAGES[status] + "\n", ...extra });

  async function serveStatic(req, res) {
    const target = resolveStaticPath(root, req.url);
    if (target.status !== 200) return sendError(req, res, target.status);

    // Le chemin textuel est sûr : on vérifie aussi la cible réelle (lien symbolique ou jonction qui sortirait).
    let real;
    try {
      real = await fs.promises.realpath(target.file);
    } catch {
      return sendError(req, res, 404);
    }
    let realRoot;
    try {
      realRoot = await fs.promises.realpath(root);
    } catch {
      return sendError(req, res, 404);
    }
    if (!isInside(realRoot, real)) return sendError(req, res, 403);

    let content;
    try {
      const stat = await fs.promises.stat(real);
      if (!stat.isFile()) return sendError(req, res, 404);
      content = await fs.promises.readFile(real);
    } catch {
      return sendError(req, res, 404);
    }
    return send(req, res, 200, { body: content, contentType: target.mime });
  }

  async function route(req, res) {
    if (!isAllowedHost(req.headers.host, getPort())) return sendError(req, res, 421);
    if (!isAllowedMethod(req.method)) return sendError(req, res, 405, { allow: ALLOWED_METHODS.join(", ") });
    if (typeof req.url !== "string" || !req.url.startsWith("/")) return sendError(req, res, 400);

    const pathname = req.url.split(/[?#]/, 1)[0];
    if (pathname === "/health") {
      return send(req, res, 200, {
        body: JSON.stringify({ ok: true, pid: process.pid }),
        contentType: MIME_TYPES[".json"],
        noStore: true,
      });
    }
    if (pathname === "/state") {
      return send(req, res, 200, {
        body: JSON.stringify(getState()),
        contentType: MIME_TYPES[".json"],
        noStore: true,
      });
    }
    if (pathname === "/events") {
      if (typeof openEvents !== "function") return sendError(req, res, 404);
      if (req.method !== "GET") return sendError(req, res, 405, { allow: "GET" });
      return openEvents(req, res);
    }
    return serveStatic(req, res);
  }

  return function onRequest(req, res) {
    route(req, res).catch((error) => {
      // Le détail reste sur stderr ; le navigateur ne reçoit qu'un message générique.
      log("error", `requête en échec : ${error && error.message ? error.message : "erreur inconnue"}`);
      if (!res.headersSent) sendError(req, res, 500);
      else res.destroy();
    });
  };
}

module.exports = {
  MIME_TYPES,
  isAllowedHost,
  isAllowedMethod,
  mimeFor,
  resolveStaticPath,
  isInside,
  importmapHash,
  buildCsp,
  buildHeaders,
  SSE_EVENTS,
  formatSse,
  formatComment,
  createSseHub,
  createRequestListener,
};
