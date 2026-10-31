// Module à précharger (`node --require tests/helpers/gh-preload.cjs …`) dans un sous-processus de test, SOUS WINDOWS
// UNIQUEMENT. Le faux `gh` y est un `.cmd`, qu'un `execFile` sans shell ne trouve pas : ce module redirige donc les
// appels `execFile("gh", args)` vers `node <fake-gh.cjs> args`, toujours sans shell.
// Le script du faux gh vient de la variable GEPET_TEST_FAKE_GH_SCRIPT, posée par le test. Rien de tout cela n'existe
// dans le code de production : le serveur ne lit aucune variable de ce genre.
const childProcess = require("child_process");

const script = process.env.GEPET_TEST_FAKE_GH_SCRIPT;
if (!script) throw new Error("gh-preload : GEPET_TEST_FAKE_GH_SCRIPT est absent");

const realExecFile = childProcess.execFile;
childProcess.execFile = function execFile(file, args, ...rest) {
  if (file === "gh" && Array.isArray(args)) return realExecFile.call(this, process.execPath, [script, ...args], ...rest);
  return realExecFile.call(this, file, args, ...rest);
};
