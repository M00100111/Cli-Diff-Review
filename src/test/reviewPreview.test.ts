import * as assert from 'assert';
import * as vscode from 'vscode';
import { ReviewWebviewManager } from '../reviewWebview';

suite('Preview host synchronization', () => {
	test('serializes the index baseline separately from HEAD and the review snapshot', () => {
		const manager = Object.create(ReviewWebviewManager.prototype);
		const uri = vscode.Uri.file('/preview.ts');
		const file = { uri, relativePath: 'preview.ts', oldText: 'HEAD', newText: 'saved', gitSnapshot: { indexText: 'INDEX' }, currentExists: true };
		const document = { uri, getText: () => 'unsaved', isDirty: true };
		const payload = manager.serialize(file, document);
		assert.strictEqual(payload.comparisonBaseText, 'INDEX');
		assert.strictEqual(payload.reviewText, 'saved');
		assert.strictEqual(payload.newText, 'unsaved');
		assert.strictEqual(payload.dirty, true);
	});
	test('rejects stale client edits without replacing external document changes', async () => {
		const manager = Object.create(ReviewWebviewManager.prototype);
		const document = await vscode.workspace.openTextDocument({ content: 'external version', language: 'plaintext' });
		await manager.applyTextEdits({ document }, { uri: document.uri.toString(), baseText: 'old version', text: 'local version', edits: [], clientVersion: 1 });
		assert.strictEqual(document.getText(), 'external version');
	});
	test('isolates acknowledgements when a webview reloads during an edit', async () => {
		const manager = Object.create(ReviewWebviewManager.prototype);
		let finish: () => void = () => {};
		const gate = new Promise<void>(resolve => { finish = resolve; });
		Object.assign(manager, { textEditQueues: new Map(), applyTextEdits: () => gate, postState: async () => {} });
		const host = { key: 'file:a', acknowledgedEditSession: 'old', acknowledgedEditVersion: 4 };
		const edit = manager.handleMessage(host, { type: 'applyTextEdits', clientSession: 'old', clientVersion: 5 });
		await Promise.resolve();
		await manager.handleMessage(host, { type: 'ready', clientSession: 'new' });
		finish(); await edit;
		assert.strictEqual(host.acknowledgedEditSession, 'new');
		assert.strictEqual(host.acknowledgedEditVersion, 0);
	});

	test('acknowledges queued edits only after applying them and queues saves behind edits', async () => {
		const manager = Object.create(ReviewWebviewManager.prototype);
		const events: string[] = [];
		let finish: () => void = () => {};
		const gate = new Promise<void>(resolve => { finish = resolve; });
		Object.assign(manager, {
			textEditQueues: new Map(),
			applyTextEdits: async () => { events.push('edit started'); await gate; events.push('edit applied'); },
			postState: async (host: { acknowledgedEditVersion: number }) => { events.push('ack ' + host.acknowledgedEditVersion); },
			saveDocument: async () => { events.push('saved'); },
		});
		const host = { key: 'file:a', acknowledgedEditVersion: 0 };
		const edit = manager.handleMessage(host, { type: 'applyTextEdits', clientVersion: 1 });
		const save = manager.handleMessage(host, { type: 'saveCurrentDocument', uri: 'file:a' });
		await Promise.resolve();
		assert.strictEqual(host.acknowledgedEditVersion, 0);
		finish(); await Promise.all([edit, save]);
		assert.deepStrictEqual(events, ['edit started', 'edit applied', 'ack 1', 'saved']);
	});
});
