#!/usr/bin/env node
// Faux `gh` pour les tests. Ce script est copié dans un dossier temporaire par gh-stub.cjs,
// à côté de `responses.json` (les réponses de fixture) et de `calls.jsonl` (le journal des appels).
//
// Format de responses.json :
//   { "routes": [ { "match": ["issue", "list"], "json": [...], "stdout": "...", "stderr": "...", "exitCode": 0 } ] }
// Une route correspond quand ses éléments `match` sont le début des arguments reçus.
// La première route qui correspond gagne. Sans route : message sur stderr et code 1.
const fs = require("fs");
const path = require("path");

const dir = __dirname;
const args = process.argv.slice(2);

fs.appendFileSync(
  path.join(dir, "calls.jsonl"),
  JSON.stringify({ ts: new Date().toISOString(), args, cwd: process.cwd() }) + "\n",
);

let config = { routes: [] };
try {
  config = JSON.parse(fs.readFileSync(path.join(dir, "responses.json"), "utf8"));
} catch {
  // Pas de fixture lisible : on retombe sur « aucune route ».
}

const route = (config.routes || []).find(
  (r) => Array.isArray(r.match) && r.match.every((token, i) => args[i] === token),
);

if (!route) {
  process.stderr.write(`faux gh : aucune réponse de fixture pour : ${args.join(" ")}\n`);
  process.exit(1);
}

if (route.json !== undefined) process.stdout.write(JSON.stringify(route.json) + "\n");
else if (route.stdout) process.stdout.write(route.stdout);
if (route.stderr) process.stderr.write(route.stderr);
process.exitCode = route.exitCode || 0;
