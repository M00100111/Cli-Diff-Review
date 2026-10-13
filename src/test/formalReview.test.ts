import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { ReviewWebviewManager } from '../reviewWebview';
import { ReviewController } from '../reviewController';
import { GitService } from '../gitService';

const exec = promisify(execFile);
suite('Saved Git review', () => {
 for (const eol of ['\n', '\r\n']) {
  test(`keeps formal chunks until saved Git results arrive (${eol === '\n' ? 'manual save, LF' : 'auto save, CRLF'})`, async function () {
   this.timeout(30000);
   const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'formal-review-'));
   const uri = vscode.Uri.file(path.join(directory, 'hello.go'));
   const root = { uri: vscode.Uri.file(directory), name: 'test', index: 0 };
   const git = (args: string[]) => exec('git', args, { cwd: directory, windowsHide: true });
   const baseline = ['package main', '', 'import "fmt"', '', 'func main() {', '\tfmt.Println("hello")', '}', '', '// outside chunk', '', '', ''].join(eol);
   const configuration = vscode.workspace.getConfiguration('files');
   const previousAutoSave = configuration.inspect<string>('autoSave')?.globalValue;
   const previousDelay = configuration.inspect<number>('autoSaveDelay')?.globalValue;
   const autoSave = eol === '\r\n';
   let panel: vscode.WebviewPanel | undefined;
   const disposables: vscode.Disposable[] = [];
   let timer: ReturnType<typeof setTimeout> | undefined;
   try {
    // These settings belong to the isolated extension-test profile and are restored below.
    await configuration.update('autoSave', autoSave ? 'afterDelay' : 'off', vscode.ConfigurationTarget.Global);
    await configuration.update('autoSaveDelay', 1500, vscode.ConfigurationTarget.Global);
    await git(['init', '--quiet']); await git(['config', 'core.autocrlf', 'true']);
    await fs.writeFile(uri.fsPath, baseline); await git(['add', '--', 'hello.go']);
    await fs.writeFile(uri.fsPath, baseline.replace('hello', 'world'));
    const document = await vscode.workspace.openTextDocument(uri);
    const files = new Map(); let revision = 0;
    const refresh = async () => {
     const pairs = await new GitService().createFilePairs(root); files.clear();
     for (const pair of pairs) { files.set(pair.uri.toString(), { ...pair, hunks: pair.pendingHunks, revision: ++revision, acceptedHunks: [], rejectedHunks: [], appliedAiSuggestions: [] }); }
    };
    await refresh();
    const manager: any = Object.create(ReviewWebviewManager.prototype);
    const controller: any = Object.create(ReviewController.prototype);
    const extensionUri = vscode.Uri.file(path.resolve(__dirname, '../..'));
    Object.assign(manager, { context: { extensionUri }, getSession: () => ({ files }), pendingMutations: new Set(), textEditQueues: new Map() });
    panel = vscode.window.createWebviewPanel('savedGitReviewTest', 'Saved Git review test', vscode.ViewColumn.One, {
     enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'resources')],
    });
    const host = { key: uri.toString(), uri, document, panel, ready: false, stateSequence: 0 };
    let html: string = manager.renderShell(panel.webview);
    const nonce = html.match(/<script nonce="([^"]+)"/)![1];
    const completed = new Promise<void>((resolve, reject) => {
     timer = setTimeout(() => reject(new Error('Review page timed out')), 25000);
     disposables.push(panel!.webview.onDidReceiveMessage(async message => {
      try {
       if (message.type === 'testDone') { if (message.error) { reject(new Error(message.error)); } else { resolve(); } return; }
       if (message.type !== 'testStep') { await manager.handleMessage(host, message); return; }
       if (message.step === 'dirty') {
        assert.ok(document.isDirty); assert.ok(document.getText().includes('world123'));
        assert.ok(controller.isFileReviewPending(files.get(uri.toString())));
       } else if (message.step === 'save') {
        if (autoSave) {
         await new Promise<void>(resolve => {
          const subscription = vscode.workspace.onDidSaveTextDocument(saved => { if (saved.uri.toString() === uri.toString()) { subscription.dispose(); resolve(); } });
          disposables.push(subscription);
         });
        } else { assert.ok(await document.save()); }
        assert.ok(controller.isFileReviewPending(files.get(uri.toString())), 'Saved text must wait for Git refresh');
        await manager.postState(host);
       } else if (message.step === 'refresh') {
        await refresh(); await manager.postState(host);
        assert.ok(!controller.isFileReviewPending(files.get(uri.toString())));
       } else if (message.step === 'external') {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(uri, new vscode.Position(8, 0), '// added outside original chunk' + eol);
        assert.ok(await vscode.workspace.applyEdit(edit)); await manager.postState(host);
       } else if (message.step === 'restore') {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), baseline);
        assert.ok(await vscode.workspace.applyEdit(edit)); assert.ok(await document.save());
        await refresh(); assert.strictEqual(files.size, 0); await manager.postState(host);
       }
       await panel!.webview.postMessage({ type: 'testReply', step: message.step });
      } catch (error) { reject(error); }
     }));
    });
    html = html.replace('</body>', `<script nonce="${nonce}">
     (async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      const step = name => new Promise(resolve => {
       const listener = event => { if (event.data.type === 'testReply' && event.data.step === name) { window.removeEventListener('message', listener); resolve(); } };
       window.addEventListener('message', listener); vscode.postMessage({type:'testStep',step:name});
      });
      const requests = []; const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (value, ...args) { if (value.hunks) requests.push(value); return post.call(this, value, ...args); };
      try {
       while (!ready || !model || !hunkEntries.length) await sleep(20);
       await sleep(350);
       check(!reviewUnavailable(), 'Initial review unavailable');
       const ids = JSON.stringify(hunkEntries.map(entry => entry.id));
       const count = requests.length;
       const column = model.getLineContent(6).indexOf('world') + 6;
       model.applyEdits([{range:new monaco.Range(6,column,6,column),text:'123'}]);
       await sleep(350); await step('dirty');
       check(reviewUnavailable(), 'Unsaved review enabled');
       check(requests.length === count, 'Typing launched a diff/highlight request');
       check(JSON.stringify(hunkEntries.map(entry => entry.id)) === ids, 'Typing replaced formal chunks');
       check(hunkEntries.every(entry => entry.displayLines < 7), 'Whole-file chunk flashed');
       await step('save'); check(reviewUnavailable(), 'Enabled before Git result');
       await step('refresh'); check(!reviewUnavailable(), 'Fresh Git result stayed disabled');
       check(state.pendingHunks.some(hunk => hunk.newText.includes('world123')), 'Git result missing edit');
       await step('external'); check(reviewUnavailable(), 'External unsaved edit enabled review');
       check(model.getValue().includes('added outside'), 'External document edit not synchronized');
       await step('save'); await step('refresh');
       check(state.pendingHunks.some(hunk => hunk.newText.includes('added outside')), 'Outside edit not detected');
       await sleep(350);
       check(requests.every(request => !('oldText' in request) && !('newText' in request)), 'Worker received whole-file text');
       await step('restore'); check(hunkEntries.length === 0, 'Stale chunks after restoring baseline');
       vscode.postMessage({type:'testDone'});
      } catch (error) { vscode.postMessage({type:'testDone',error:error.stack || String(error)}); }
     })();
    </script></body>`);
    panel.webview.html = html;
    await completed;
   } finally {
    clearTimeout(timer); for (const disposable of disposables) { disposable.dispose(); } panel?.dispose();
    await configuration.update('autoSave', previousAutoSave, vscode.ConfigurationTarget.Global);
    await configuration.update('autoSaveDelay', previousDelay, vscode.ConfigurationTarget.Global);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
   }
  });
 }
 test('discards a delayed per-file Git result after a newer refresh', async () => {
  const controller: any = Object.create(ReviewController.prototype);
  const uri = vscode.Uri.file(path.join(os.tmpdir(), 'stale-review-result.go'));
  const project = { rootUri: vscode.Uri.file(os.tmpdir()), id: 'test' };
  const session = { mode: 'git', files: new Map(), projects: [project] };
  let completeOld: (value: any) => void = () => {};
  const old = new Promise(resolve => { completeOld = resolve; });
  let calls = 0;
  Object.assign(controller, {
   activeSession: session, gitProjectForUri: () => project,
   createGitFilePair: () => ++calls === 1 ? old : Promise.resolve({ uri, newText: 'new', hunks: [{ id: 'new' }], appliedAiSuggestions: [] }),
   createFileState: (pair: any) => ({ ...pair, acceptedHunks: [], rejectedHunks: [] }),
   attachRejectedJournals: async () => {}, restoreStableReviewItemIdentities: () => {}, restoreAppliedSuggestionGroups: () => {}, restoreAcceptedAiSuggestions: () => {},
   refreshUi: () => {},
  });
  session.files.set(uri.toString(), { uri, newText: 'before', hunks: [], appliedAiSuggestions: [], acceptedHunks: [], rejectedHunks: [], revision: 0 });
  const first = controller.refreshGitReviewFile(uri);
  await controller.refreshGitReviewFile(uri);
  completeOld({ uri, newText: 'old', hunks: [{ id: 'old' }], appliedAiSuggestions: [] }); await first;
  assert.strictEqual(session.files.get(uri.toString()).newText, 'new');
 });
});
