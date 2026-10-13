// @vscode/test-electron uses shell:true on Windows, which splits workspace paths
// containing spaces. Launch the test executable with native argument escaping.
const childProcess = require('node:child_process');
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
 if (process.platform === 'win32' && options?.shell && /^".*\.exe"$/i.test(command)) {
  return spawn.call(this, command.slice(1, -1), args, { ...options, shell: false, windowsHide: true });
 }
 return spawn.call(this, command, args, options);
};
import('../node_modules/@vscode/test-cli/out/bin.mjs');
