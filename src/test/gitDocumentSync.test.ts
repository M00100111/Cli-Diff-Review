import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ReviewController } from '../reviewController';

const exec = promisify(execFile);
suite('Git document synchronization', () => {
 for (const eol of ['\n', '\r\n']) {
  test(`reject and restore reload without saving, then allow normal save (${eol.length === 1 ? 'LF' : 'CRLF'})`, async function () {
   this.timeout(30000);
   const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-document-sync-'));
   const uri = vscode.Uri.file(path.join(directory, 'hello.go'));
   const git = (args: string[]) => exec('git', args, { cwd: directory, windowsHide: true });
   const baseline = `package main${eol}// hello${eol}`;
   const modified = baseline.replace('hello', 'world');
   let saves = 0;
   const listener = vscode.workspace.onWillSaveTextDocument(event => {
    if (event.document.uri.toString() === uri.toString()) { saves++; }
   });
   try {
    await git(['init', '--quiet']);
    await git(['config', 'core.autocrlf', eol.length === 1 ? 'false' : 'true']);
    await fs.writeFile(uri.fsPath, baseline); await git(['add', '--', 'hello.go']);
    await fs.writeFile(uri.fsPath, modified);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document);
    const patch = (await git(['diff', '--', 'hello.go'])).stdout;
    const patchPath = path.join(directory, 'change.patch');
    await fs.writeFile(patchPath, patch);
    const controller: any = Object.create(ReviewController.prototype);
    // Keep real disk reading and the production synchronization implementation.
    for (let cycle = 0; cycle < 3; cycle++) {
     for (const reverse of [true, false]) {
      await git(['apply', ...(reverse ? ['--reverse'] : []), patchPath]);
      await controller.synchronizeOpenDocumentAfterGitMutation(uri);
      const expected = reverse ? baseline : modified;
      assert.strictEqual(document.getText(), expected, 'Native reload must synchronize the open document');
      assert.strictEqual(document.isDirty, false, 'Git reload must not create unsaved edits');
      assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), expected);
      assert.strictEqual(saves, 0, 'Synchronization must not trigger save participants');
     }
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, document.positionAt(document.getText().length), `// user edit${eol}`);
    assert.ok(await vscode.workspace.applyEdit(edit));
    assert.ok(await document.save(), 'A subsequent user save must succeed without overwrite');
    assert.strictEqual(document.isDirty, false);
    assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), modified + `// user edit${eol}`);
   } finally {
    listener.dispose();
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString());
    await vscode.window.tabGroups.close(tabs, true);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
   }
  });
 }
 test('preserves edits made while the disk read is in flight', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-document-race-'));
  const uri = vscode.Uri.file(path.join(directory, 'hello.txt'));
  try {
   await fs.writeFile(uri.fsPath, 'original');
   const document = await vscode.workspace.openTextDocument(uri);
   const controller: any = Object.create(ReviewController.prototype);
   controller.readCurrentText = async () => {
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), 'unsaved ');
    assert.ok(await vscode.workspace.applyEdit(edit));
    return { exists: true, text: 'disk contents' };
   };
   await controller.synchronizeOpenDocumentAfterGitMutation(uri);
   assert.strictEqual(document.getText(), 'unsaved original');
   assert.ok(document.isDirty);
   assert.strictEqual(await fs.readFile(uri.fsPath, 'utf8'), 'original');
   // Restore the buffer for cleanup without invoking a save or a global revert command.
   const cleanup = new vscode.WorkspaceEdit();
   cleanup.delete(uri, new vscode.Range(0, 0, 0, 8));
   await vscode.workspace.applyEdit(cleanup);
  } finally {
   await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
 });
});
