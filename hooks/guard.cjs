#!/usr/bin/env node
// Garde-fou PreToolUse (Bash) de la squad gepet.
// Actif uniquement dans un repo qui contient .gepet-squad.json : ailleurs, il laisse tout passer.
// Bloque : push direct sur main/master, force-push sur develop, merge d'une PR vers main, `git merge` sur main.
// En mode économe local ("mode": "econome" dans .gepet-squad.json) : bloque aussi tout `git push` et les commandes
// `gh` qui écrivent sur GitHub (le projet ne consomme rien sur GitHub).
// En mode économe hybride (+ "suivi": "hybride") : issues et PR restent sur GitHub, mais les rapports sont des
// fichiers Markdown : bloque `gh pr comment`, `gh issue comment` et `gh pr review`.
// Ces actions reviennent à l'utilisateur, qui peut les faire lui-même, hors Claude.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function findConfig(dir) {
  let current = path.resolve(dir || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(current, ".gepet-squad.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// "normal", "econome-local" ou "econome-hybride".
function readMode(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, ".gepet-squad.json"), "utf8"));
    if (!cfg || cfg.mode !== "econome") return "normal";
    return cfg.suivi === "hybride" ? "econome-hybride" : "econome-local";
  } catch {
    return "normal";
  }
}

function currentBranch(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
  } catch {
    return "";
  }
}

// Commandes `gh` qui écrivent sur GitHub (interdites en mode économe). Les lectures restent permises.
const GH_WRITE = [
  /^gh\s+(issue|pr)\s+(create|edit|close|reopen|comment|merge|review|ready|delete|lock|unlock|transfer|pin|unpin|develop)\b/,
  /^gh\s+(label|release|workflow|secret|variable|project|cache)\s+(create|edit|delete|clone|upload|run|enable|disable|set|copy|close|item-add|item-create|item-edit|item-delete|link|field-create)\b/,
  /^gh\s+repo\s+(create|fork|edit|delete|rename|archive|sync)\b/,
  /^gh\s+run\s+(rerun|cancel|delete)\b/,
];

function isGhWrite(cmd) {
  if (GH_WRITE.some((re) => re.test(cmd))) return true;
  if (/^gh\s+api\b/.test(cmd)) {
    const method = cmd.match(/\s(?:-X\s*|--method[\s=]+)([A-Za-z]+)/);
    if (method) return method[1].toUpperCase() !== "GET";
    return /\s(?:-f|-F|--field|--raw-field|--input)(?:\s|=)/.test(cmd);
  }
  return false;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `[gepet-squad] ${reason}`,
      },
    })
  );
  process.exit(0);
}

function prBase(prRef, cwd) {
  try {
    return execFileSync("gh", ["pr", "view", prRef, "--json", "baseRefName", "--jq", ".baseRefName"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    }).trim();
  } catch {
    return "";
  }
}

let input;
try {
  input = JSON.parse(readStdin() || "{}");
} catch {
  process.exit(0);
}
if (input.tool_name !== "Bash") process.exit(0);

const command = String((input.tool_input && input.tool_input.command) || "");
const cwd = input.cwd || process.cwd();
const root = findConfig(cwd);
if (!root) process.exit(0);
const mode = readMode(root);
const econome = mode === "econome-local";
const hybride = mode === "econome-hybride";

// Branche courante, mise à jour par un `git switch` / `git checkout` qui précède dans la même ligne.
let branch = null;

// Une ligne de commande peut chaîner plusieurs commandes.
for (const part of command.split(/&&|\|\|?|;|\n/)) {
  const cmd = part.trim();

  const sw = cmd.match(/^git\s+(?:switch|checkout)\s+(?:-\S+\s+)*([^\s-]\S*)\s*$/);
  if (sw) branch = sw[1];

  if (/^git\s+merge\b/.test(cmd) && !/\s--(?:abort|quit|continue)\b/.test(cmd)) {
    if (branch === null) branch = currentBranch(cwd);
    if (branch === "main" || branch === "master") {
      deny("Merge sur main interdit : le merge des releases revient à l'utilisateur.");
    }
  }

  if (econome && /^git\b.*\bpush\b/.test(cmd)) {
    deny("Mode économe : aucun push. L'utilisateur pousse lui-même s'il le souhaite.");
  }

  if (econome && isGhWrite(cmd)) {
    deny("Mode économe : aucune écriture sur GitHub. Le suivi passe par docs/squad/ (voir mode-econome.md).");
  }

  if (hybride && /^gh\s+((pr|issue)\s+comment|pr\s+review)\b/.test(cmd)) {
    deny("Mode économe hybride : les rapports sont des fichiers docs/squad/rapports/, pas des commentaires GitHub.");
  }

  if (/^git\b.*\bpush\b/.test(cmd)) {
    const forced = /(\s--force(?!-with-lease)\b|\s-f\b)/.test(cmd);
    if (/(\s|:|\/)(main|master)(\s|$)/.test(cmd)) {
      deny("Push direct sur main interdit : main ne reçoit que les PR release/* mergées par l'utilisateur.");
    }
    if (forced && /(\s|:|\/)develop(\s|$)/.test(cmd)) {
      deny("Force-push sur develop interdit.");
    }
  }

  const merge = cmd.match(/^gh\s+pr\s+merge\s+(\S+)?/);
  if (merge) {
    const ref = merge[1] && !merge[1].startsWith("-") ? merge[1] : "";
    const base = ref ? prBase(ref, cwd) : "";
    if (base === "main" || base === "master" || /release\//.test(cmd)) {
      deny("Le merge d'une PR vers main (release) revient à l'utilisateur.");
    }
  }
}

process.exit(0);
