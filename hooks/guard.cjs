#!/usr/bin/env node
// Garde-fou PreToolUse (Bash) de la squad gepet.
// Actif uniquement dans un repo qui contient .gepet-squad.json : ailleurs, il laisse tout passer.
// Bloque : push direct sur main/master, force-push sur develop, merge d'une PR vers main.
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
if (!findConfig(cwd)) process.exit(0);

// Une ligne de commande peut chaîner plusieurs commandes.
for (const part of command.split(/&&|\|\||;|\n/)) {
  const cmd = part.trim();

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
