// Synchronisation du client avec le serveur : libellé de l'état de la connexion, et rapprochement entre `/state` et
// les messages SSE reçus pendant qu'on le lisait. Module pur : aucun import de `three`, aucun DOM, ni horloge.
//
// Ordre de connexion (voir main.js) : l'`EventSource` est ouvert AVANT la lecture de `/state`. Les messages reçus
// entre-temps sont mis de côté, puis rejoués sur l'état lu. Le serveur n'envoie ni rejeu ni snapshot à une première
// connexion sans `Last-Event-ID`, et un `EventSource` ne permet pas d'en fixer un : le client écarte donc lui-même les
// événements que `/state` reflète déjà (sinon un vieil événement rejoué remettrait une feature dans une station
// qu'elle a déjà quittée).

// Un événement du journal est repris par `/state` s'il est antérieur à l'instant de l'état, moins cette marge. La marge
// couvre le délai de suivi du journal côté serveur (500 ms) : un événement écrit juste avant la lecture peut ne pas
// encore être dans `/state`, et il ne faut surtout pas le perdre. Rejouer un événement dans la marge est sans danger :
// les événements suivants du même flux sont rejoués après lui, et l'état final est celui du dernier.
export const REFLECTED_MARGIN_MS = 2000;

// Nombre maximal de messages gardés tant que `/state` n'est pas lu (un instantané périodique remplace de toute façon
// les précédents).
export const MAX_PENDING_MESSAGES = 2000;

// États de `EventSource.readyState`.
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

// Libellé de l'indicateur de connexion. `wasOpen` : la connexion a déjà été établie au moins une fois.
// Renvoie { state: "connecting" | "open" | "reconnecting" | "closed", text }.
export function connectionStatus(readyState, wasOpen) {
  if (readyState === OPEN) return { state: "open", text: "connecté" };
  if (readyState === CLOSED) return { state: "closed", text: "déconnecté" };
  if (readyState === CONNECTING) {
    return wasOpen ? { state: "reconnecting", text: "reconnexion…" } : { state: "connecting", text: "connexion…" };
  }
  return { state: "closed", text: "déconnecté" };
}

const toMs = (value) => {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
};

// Limite en ms sous laquelle un événement est considéré comme déjà repris par l'état daté de `updatedAt`, ou `null`
// si la date est inconnue (alors rien n'est écarté).
export function reflectedCutoff(updatedAt, marginMs = REFLECTED_MARGIN_MS) {
  const t = typeof updatedAt === "number" ? updatedAt : toMs(updatedAt);
  return t === null ? null : t - marginMs;
}

// Écarte d'un message SSE `evt` les événements antérieurs à `cutoffMs`. Renvoie le message tel quel (rien d'écarté, ou
// message d'un autre type, ou illisible : `apply` le signalera), un message réduit aux événements conservés (lot
// partiellement repris), ou `null` (tout est repris).
export function dropReflected(message, cutoffMs) {
  if (cutoffMs === null || cutoffMs === undefined) return message;
  if (message === null || typeof message !== "object" || message.event !== "evt" || typeof message.data !== "string") return message;
  let data;
  try {
    data = JSON.parse(message.data);
  } catch {
    return message;
  }
  const isOld = (ev) => {
    const t = ev !== null && typeof ev === "object" ? toMs(ev.ts) : null;
    return t !== null && t < cutoffMs;
  };
  if (Array.isArray(data)) {
    const kept = data.filter((ev) => !isOld(ev));
    if (kept.length === data.length) return message;
    return kept.length === 0 ? null : { event: message.event, data: JSON.stringify(kept) };
  }
  return isOld(data) ? null : message;
}
