import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { acceptHunkInBaseline, computeLineDiff } from '../diffEngine';
import { GitService } from '../gitService';
import { isDotReviewPath, shouldSkipReviewPath } from '../reviewFileFilter';
import { ReviewTreeProvider } from '../reviewTree';
import {
	captureLineBlockContext,
	isStaleRevision,
	lineBlockWithContextMatchesUniquely,
	mapLineAfterLineEdits,
	SerialOperationQueue,
	shouldDeleteRejectedCurrentFileOnRefresh,
	skippedCurrentFile,
} from '../reviewState';
import { replaceLineBlock, splitLines } from '../text';
import { ReviewedHunk, ReviewFileState, ReviewHunk, ReviewSession } from '../types';

suite('Diff engine', () => {
	test('detects added lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'const a = 1;\n', 'const a = 1;\nconst b = 2;\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'add');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 0);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 1);
		assert.strictEqual(hunks[0].newText, 'const b = 2;\n');
	});

	test('detects deleted lines', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nb\nc\n', 'a\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'delete');
		assert.strictEqual(hunks[0].oldStart, 1);
		assert.strictEqual(hunks[0].oldLines, 1);
		assert.strictEqual(hunks[0].newStart, 1);
		assert.strictEqual(hunks[0].newLines, 0);
		assert.strictEqual(hunks[0].oldText, 'b\n');
	});

	test('detects modified blocks', () => {
		const hunks = computeLineDiff('file:///demo.ts', 'a\nold\nc\n', 'a\nnew\nc\n');

		assert.strictEqual(hunks.length, 1);
		assert.strictEqual(hunks[0].kind, 'modify');
		assert.strictEqual(hunks[0].oldText, 'old\n');
		assert.strictEqual(hunks[0].newText, 'new\n');
	});

	test('preserves CRLF line endings in accepted hunks', () => {
		const oldText = 'a\r\nold\r\nc\r\n';
		const newText = 'a\r\nnew\r\nc\r\n';
		const [hunk] = computeLineDiff('file:///demo.ts', oldText, newText);

		assert.strictEqual(acceptHunkInBaseline(oldText, hunk), newText);
	});

	test('accepting every hunk makes the baseline match the current text', () => {
		let baseline = 'one\nold\nthree\n';
		const current = 'zero\none\nnew\nthree\nfour\n';

		while (baseline !== current) {
			const [hunk] = computeLineDiff('file:///demo.ts', baseline, current);
			baseline = acceptHunkInBaseline(baseline, hunk);
		}

		assert.strictEqual(baseline, current);
		assert.deepStrictEqual(computeLineDiff('file:///demo.ts', baseline, current), []);
	});

	test('undoing an accepted hunk uses the baseline coordinate', () => {
		const baseline = 'a\nb\nc\n';
		const current = 'a\nx\nb\nC\n';
		const target = shiftedModifyHunk(baseline, current);
		const accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		const acceptedBaseline = acceptHunkInBaseline(baseline, target);

		const restoredWithDisplayStart = replaceLineBlock(acceptedBaseline, accepted.displayStart, accepted.newLines, accepted.oldText);
		const restoredWithBaselineStart = replaceLineBlock(acceptedBaseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.notStrictEqual(restoredWithDisplayStart, baseline);
		assert.strictEqual(restoredWithBaselineStart, baseline);
	});

	test('keeps shifted hunk content stable across accept undo reject undo accept', () => {
		const originalBaseline = 'a\nb\nc\n';
		const originalCurrent = 'a\nx\nb\nC\n';
		let baseline = originalBaseline;
		let current = originalCurrent;

		let target = shiftedModifyHunk(baseline, current);
		let accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);
		baseline = replaceLineBlock(baseline, accepted.baselineStart, accepted.newLines, accepted.oldText);

		assert.strictEqual(baseline, originalBaseline);

		target = shiftedModifyHunk(baseline, current);
		const rejected = reviewedHunk(target, 'reject', target.newStart, target.oldLines, target.oldStart, target.newStart);
		current = replaceLineBlock(current, target.newStart, target.newLines, target.oldText);
		current = replaceLineBlock(current, rejected.currentStart, rejected.displayLines, rejected.newText);

		assert.strictEqual(current, originalCurrent);

		target = shiftedModifyHunk(baseline, current);
		accepted = reviewedHunk(target, 'accept', target.newStart, target.newLines, target.oldStart, target.newStart);
		baseline = acceptHunkInBaseline(baseline, target);

		assert.strictEqual(accepted.baselineStart, 2);
		assert.strictEqual(accepted.displayStart, 3);
		assert.strictEqual(baseline, 'a\nb\nC\n');
		assert.strictEqual(current, originalCurrent);
	});

	test('anchors a delete hunk before the following current line', () => {
		const baseline = [
			'func main() {\n',
			'\thelloWorld()\n',
			'\tgreet("Go")\n',
			'\tgreetWithConfig(GreetingConfig{Name: "Agent", Age: 1})\n',
			'}\n',
		].join('');
		const current = [
			'func main() {\n',
			'\thelloWorld()\n',
			'}\n',
		].join('');

		const hunk = computeLineDiff('file:///main.go', baseline, current).find((item) => item.kind === 'delete');

		assert.ok(hunk);
		assert.strictEqual(hunk.newStart, 2);
		assert.strictEqual(hunk.zoneAfterLineNumber, 2);
		assert.deepStrictEqual(hunk.newContextBefore, ['func main() {\n', '\thelloWorld()\n']);
		assert.deepStrictEqual(hunk.newContextAfter, ['}\n']);
	});
});

suite('Review state', () => {
	test('skips dot files and dot folders in review file discovery', () => {
		assert.strictEqual(isDotReviewPath('.env'), true);
		assert.strictEqual(isDotReviewPath('.github/workflows/release.yml'), true);
		assert.strictEqual(isDotReviewPath('src/.cache/output.txt'), true);
		assert.strictEqual(shouldSkipReviewPath('src/app.ts'), false);
		assert.strictEqual(shouldSkipReviewPath('src/file.name.ts'), false);
	});

	test('treats mismatched expected revisions as stale', () => {
		assert.strictEqual(isStaleRevision(3), false);
		assert.strictEqual(isStaleRevision(3, 3), false);
		assert.strictEqual(isStaleRevision(3, 2), true);
	});

	test('serializes operations for the same file key', async () => {
		const queue = new SerialOperationQueue<string>();
		const order: string[] = [];
		let releaseFirst: () => void = () => undefined;

		const first = queue.enqueue('file:///demo.ts', async () => {
			order.push('first:start');
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push('first:end');
		});
		const second = queue.enqueue('file:///demo.ts', async () => {
			order.push('second');
		});

		await Promise.resolve();
		await Promise.resolve();
		assert.deepStrictEqual(order, ['first:start']);

		releaseFirst();
		await Promise.all([first, second]);
		assert.deepStrictEqual(order, ['first:start', 'first:end', 'second']);
	});

	test('allows refresh to delete a rejected empty new current file', () => {
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 1), true);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(true, '', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, 'kept\n', 0, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 1, 1), false);
		assert.strictEqual(shouldDeleteRejectedCurrentFileOnRefresh(false, '', 0, 0), false);
	});

	test('maps reviewed baseline starts through manual edits before the hunk', () => {
		const acceptedBaseline = 'a\nmanual\nb\nC\n';
		const mappedBaselineStart = mapLineAfterLineEdits(2, [{ oldStart: 1, oldLines: 0, newLines: 1 }]);
		const restored = replaceLineBlock(acceptedBaseline, mappedBaselineStart, 1, 'c\n');

		assert.strictEqual(mappedBaselineStart, 3);
		assert.strictEqual(restored, 'a\nmanual\nb\nc\n');
	});

	test('keeps skipped current snapshot files marked as existing', () => {
		const current = skippedCurrentFile('File exceeds cliDiff.maxFileBytes.');

		assert.strictEqual(current.exists, true);
		assert.strictEqual(current.text, '');
		assert.strictEqual(current.skippedReason, 'File exceeds cliDiff.maxFileBytes.');
	});

	test('shows skipped files in the review tree', () => {
		const file: ReviewFileState = {
			uri: vscode.Uri.file('D:/repo/src/reviewController.ts'),
			relativePath: 'src/reviewController.ts',
			oldText: '',
			newText: '',
			hunks: [],
			acceptedHunks: [],
			rejectedHunks: [],
			originalText: '',
			originalExists: true,
			baselineExists: true,
			currentExists: true,
			revision: 0,
			skippedReason: 'File diff exceeds cliDiff.maxDiffCells.',
		};
		const session: ReviewSession = {
			id: 'git-test',
			mode: 'git',
			rootUri: vscode.Uri.file('D:/repo'),
			createdAt: 1,
			files: new Map([[file.uri.toString(), file]]),
		};
		const provider = new ReviewTreeProvider(() => session);
		const [child] = provider.getChildren();
		const item = provider.getTreeItem(child);

		assert.strictEqual(child, file);
		assert.strictEqual(item.description, 'skipped');
		assert.strictEqual(item.contextValue, 'cliDiffFileSkipped');
	});

	test('requires delete insertion context to match uniquely', () => {
		const text = 'a\n}\na\n}\n';
		const context = captureLineBlockContext('a\n}\n', 1, 0);

		assert.strictEqual(lineBlockWithContextMatchesUniquely(text, 1, 0, '', context), false);
		assert.strictEqual(lineBlockWithContextMatchesUniquely('a\n}\n', 1, 0, '', context), true);
		assert.strictEqual(lineBlockWithContextMatchesUniquely('a\n}\n', 2, 0, '', context), false);
	});

	test('keeps file-level accept undo coordinates in final baseline space', () => {
		const baseline = 'a\nb\nkeep1\nc\nkeep2\nd\n';
		const current = 'x\na\nB\nkeep1\nkeep2\nd\nz\n';
		const hunks = computeLineDiff('file:///demo.ts', baseline, current);
		const accepted = hunks.map((hunk) => reviewedHunk(hunk, 'accept', hunk.newStart, hunk.newLines, hunk.newStart, hunk.newStart));

		const restored = accepted
			.sort((left, right) => right.baselineStart - left.baselineStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.baselineStart, hunk.newLines, hunk.oldText), current);

		assert.strictEqual(restored, baseline);
	});

	test('keeps file-level reject undo coordinates in final current space', () => {
		const baseline = 'a\nb\nkeep1\nc\nkeep2\nd\n';
		const current = 'x\na\nB\nkeep1\nkeep2\nd\nz\n';
		const hunks = computeLineDiff('file:///demo.ts', baseline, current);
		const rejectedCurrent = [...hunks]
			.sort((left, right) => right.newStart - left.newStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.newStart, hunk.newLines, hunk.oldText), current);
		const rejected = hunks.map((hunk) => reviewedHunk(hunk, 'reject', hunk.oldStart, hunk.oldLines, hunk.oldStart, hunk.oldStart));
		const restored = rejected
			.sort((left, right) => right.currentStart - left.currentStart)
			.reduce((text, hunk) => replaceLineBlock(text, hunk.currentStart, hunk.displayLines, hunk.newText), rejectedCurrent);

		assert.strictEqual(rejectedCurrent, baseline);
		assert.strictEqual(restored, current);
	});
});

suite('Git service', () => {
	test('uses the index as the Git review baseline', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			writeRepoFile(root, 'delete.txt', 'delete\n');
			git(root, 'add', 'tracked.txt', 'delete.txt');
			git(root, 'commit', '-m', 'initial');

			const service = new GitService();
			const folder = workspaceFolder(root);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\n');
			let pairs = await service.createFilePairs(folder);
			let byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('tracked.txt')?.oldText, 'base\n');
			assert.strictEqual(byPath.get('tracked.txt')?.newText, 'base\nwork\n');

			git(root, 'add', 'tracked.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('tracked.txt'), false);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\nunstaged\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('tracked.txt')?.oldText, 'base\nwork\n');
			assert.strictEqual(byPath.get('tracked.txt')?.newText, 'base\nwork\nunstaged\n');

			writeRepoFile(root, 'loose.txt', 'loose\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('loose.txt')?.baselineExists, false);
			assert.strictEqual(byPath.get('loose.txt')?.currentExists, true);

			git(root, 'add', 'loose.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('loose.txt'), false);

			fs.unlinkSync(path.join(root, 'delete.txt'));
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.get('delete.txt')?.oldText, 'delete\n');
			assert.strictEqual(byPath.get('delete.txt')?.currentExists, false);

			git(root, 'add', 'delete.txt');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('delete.txt'), false);

			writeRepoFile(root, '.env', 'secret\n');
			writeRepoFile(root, '.cache/output.txt', 'cache\n');
			writeRepoFile(root, '.gitignore', 'ignored.txt\n');
			writeRepoFile(root, 'ignored.txt', 'ignored\n');
			pairs = await service.createFilePairs(folder);
			byPath = filePairsByPath(pairs);
			assert.strictEqual(byPath.has('.env'), false);
			assert.strictEqual(byPath.has('.cache/output.txt'), false);
			assert.strictEqual(byPath.has('.gitignore'), false);
			assert.strictEqual(byPath.has('ignored.txt'), false);
		} finally {
			removeTempRepo(root);
		}
	});

	test('changes the index signature only for index or HEAD changes', async function (this: Mocha.Context) {
		this.timeout(10000);
		const root = createTempGitRepo();
		try {
			writeRepoFile(root, 'tracked.txt', 'base\n');
			git(root, 'add', 'tracked.txt');
			git(root, 'commit', '-m', 'initial');

			const service = new GitService();
			const folder = workspaceFolder(root);
			const cleanSignature = await service.indexStateSignature(folder);

			writeRepoFile(root, 'tracked.txt', 'base\nwork\n');
			assert.strictEqual(await service.indexStateSignature(folder), cleanSignature);

			git(root, 'add', 'tracked.txt');
			const stagedSignature = await service.indexStateSignature(folder);
			assert.notStrictEqual(stagedSignature, cleanSignature);

			git(root, 'commit', '-m', 'second');
			assert.notStrictEqual(await service.indexStateSignature(folder), stagedSignature);
		} finally {
			removeTempRepo(root);
		}
	});
});

suite('Text helpers', () => {
	test('splits lines while preserving terminators', () => {
		assert.deepStrictEqual(splitLines('a\nb\r\nc'), ['a\n', 'b\r\n', 'c']);
	});

	test('replaces a line block', () => {
		assert.strictEqual(replaceLineBlock('a\nb\nc\n', 1, 1, 'B\n'), 'a\nB\nc\n');
	});
});

function createTempGitRepo(): string {
	const base = fs.existsSync('C:\\tmp') ? 'C:\\tmp' : os.tmpdir();
	const root = fs.mkdtempSync(path.join(base, 'cli-diff-git-'));
	git(root, 'init');
	git(root, 'config', 'user.email', 'cli-diff@example.invalid');
	git(root, 'config', 'user.name', 'CLI Diff Test');
	git(root, 'config', 'core.autocrlf', 'false');
	return root;
}

function removeTempRepo(root: string): void {
	try {
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	} catch {
		// Windows can briefly keep Git metadata handles open after extension-host tests.
	}
}

function workspaceFolder(root: string): vscode.WorkspaceFolder {
	return {
		uri: vscode.Uri.file(root),
		name: path.basename(root),
		index: 0,
	};
}

function writeRepoFile(root: string, relativePath: string, text: string): void {
	const filePath = path.join(root, relativePath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, text);
}

function git(root: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function filePairsByPath<T extends { relativePath: string }>(pairs: T[]): Map<string, T> {
	return new Map(pairs.map((pair) => [pair.relativePath, pair]));
}

function shiftedModifyHunk(baseline: string, current: string): ReviewHunk {
	const hunk = computeLineDiff('file:///demo.ts', baseline, current).find((item) => item.kind === 'modify');
	assert.ok(hunk);
	assert.notStrictEqual(hunk.oldStart, hunk.newStart);
	return hunk;
}

function reviewedHunk(
	hunk: ReviewHunk,
	reviewSource: 'accept' | 'reject',
	displayStart: number,
	displayLines: number,
	baselineStart: number,
	currentStart: number,
): ReviewedHunk {
	return {
		...hunk,
		id: `${reviewSource}-${hunk.id}`,
		status: reviewSource === 'accept' ? 'accepted' : 'rejected',
		reviewSource,
		displayStart,
		displayLines,
		baselineStart,
		currentStart,
		baselineContextBefore: [],
		baselineContextAfter: [],
		currentContextBefore: [],
		currentContextAfter: [],
		zoneAfterLineNumber: displayStart,
		reviewedAt: 1,
	};
}
