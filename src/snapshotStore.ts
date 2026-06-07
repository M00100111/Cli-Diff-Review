import { createHash } from 'crypto';
import * as vscode from 'vscode';
import { gitIgnoredReviewPaths, shouldSkipReviewPath } from './reviewFileFilter';
import { BaselineFile, uriKey } from './types';
import { decodeUtf8, encodeUtf8, isProbablyBinary, relativePath } from './text';

interface SnapshotManifest {
	version: 1;
	capturedAt: number;
	roots: SnapshotRootManifest[];
}

interface SnapshotRootManifest {
	rootUri: string;
	files: SnapshotFileManifest[];
}

interface SnapshotFileManifest {
	uri: string;
	relativePath: string;
	storageName: string;
	size: number;
	exists?: boolean;
}

export class SnapshotStore {
	private readonly snapshotDirectory: vscode.Uri;
	private readonly fileDirectory: vscode.Uri;
	private readonly manifestUri: vscode.Uri;

	public constructor(private readonly context: vscode.ExtensionContext) {
		const storageRoot = context.storageUri ?? context.globalStorageUri;
		this.snapshotDirectory = vscode.Uri.joinPath(storageRoot, 'snapshot');
		this.fileDirectory = vscode.Uri.joinPath(this.snapshotDirectory, 'files');
		this.manifestUri = vscode.Uri.joinPath(this.snapshotDirectory, 'manifest.json');
	}

	public async captureWorkspaceBaseline(): Promise<number> {
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (folders.length === 0) {
			throw new Error('Open a workspace folder before capturing a baseline.');
		}

		await vscode.workspace.fs.createDirectory(this.fileDirectory);
		const manifest: SnapshotManifest = { version: 1, capturedAt: Date.now(), roots: [] };
		const maxFileBytes = getNumberConfig('maxFileBytes', 2097152);
		const maxFiles = getNumberConfig('maxFiles', 2000);
		const exclude = getStringConfig('exclude', '**/{.git,node_modules,dist,out,.vscode-test}/**');
		let captured = 0;

		for (const folder of folders) {
			const rootManifest: SnapshotRootManifest = { rootUri: folder.uri.toString(), files: [] };
			const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), exclude, maxFiles);
			const relativePaths = new Map(uris.map((uri) => [uri.toString(), relativePath(folder.uri, uri)]));
			const ignoredPaths = await gitIgnoredReviewPaths(folder, [...relativePaths.values()]);

			for (const uri of uris) {
				if (captured >= maxFiles) {
					break;
				}

				const currentRelativePath = relativePaths.get(uri.toString()) ?? relativePath(folder.uri, uri);
				if (shouldSkipReviewPath(currentRelativePath) || ignoredPaths.has(currentRelativePath)) {
					continue;
				}

				const data = await vscode.workspace.fs.readFile(uri);
				if (data.length > maxFileBytes || isProbablyBinary(data)) {
					continue;
				}

				const text = decodeUtf8(data);
				const storageName = `${hash(uri.toString())}.txt`;
				await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.fileDirectory, storageName), encodeUtf8(text));
				rootManifest.files.push({
					uri: uri.toString(),
					relativePath: currentRelativePath,
					storageName,
					size: data.length,
					exists: true,
				});
				captured += 1;
			}

			manifest.roots.push(rootManifest);
		}

		await vscode.workspace.fs.writeFile(this.manifestUri, encodeUtf8(JSON.stringify(manifest, null, 2)));
		return captured;
	}

	public async loadBaselineFiles(): Promise<BaselineFile[]> {
		const manifest = await this.readManifest();
		const files: BaselineFile[] = [];

		for (const root of manifest.roots) {
			for (const file of root.files) {
				const exists = file.exists !== false;
				const text = exists
					? decodeUtf8(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.fileDirectory, file.storageName)))
					: '';
				files.push({
					uri: vscode.Uri.parse(file.uri),
					relativePath: file.relativePath,
					text,
					exists,
				});
			}
		}

		return files;
	}

	public async updateBaselineFile(uri: vscode.Uri, text: string, exists = true): Promise<void> {
		const manifest = await this.readManifest();
		const uriString = uriKey(uri);
		let target: SnapshotFileManifest | undefined;

		for (const root of manifest.roots) {
			target = root.files.find((file) => file.uri === uriString);
			if (target) {
				break;
			}
		}

		if (!target) {
			const folder = vscode.workspace.getWorkspaceFolder(uri);
			if (!folder) {
				return;
			}

			target = {
				uri: uriString,
				relativePath: relativePath(folder.uri, uri),
				storageName: `${hash(uriString)}.txt`,
				size: Buffer.byteLength(text, 'utf8'),
			};

			let root = manifest.roots.find((item) => item.rootUri === folder.uri.toString());
			if (!root) {
				root = { rootUri: folder.uri.toString(), files: [] };
				manifest.roots.push(root);
			}
			root.files.push(target);
		}

		target.size = Buffer.byteLength(text, 'utf8');
		target.exists = exists;
		await vscode.workspace.fs.createDirectory(this.fileDirectory);
		const targetUri = vscode.Uri.joinPath(this.fileDirectory, target.storageName);
		if (exists) {
			await vscode.workspace.fs.writeFile(targetUri, encodeUtf8(text));
		} else {
			try {
				await vscode.workspace.fs.delete(targetUri);
			} catch {
				// Missing snapshot payloads are fine for deleted baselines.
			}
		}
		await vscode.workspace.fs.writeFile(this.manifestUri, encodeUtf8(JSON.stringify(manifest, null, 2)));
	}

	private async readManifest(): Promise<SnapshotManifest> {
		try {
			const data = await vscode.workspace.fs.readFile(this.manifestUri);
			return JSON.parse(decodeUtf8(data)) as SnapshotManifest;
		} catch {
			throw new Error('No Cli Diff Review baseline found. Run "Cli Diff Review: Capture Baseline" first.');
		}
	}
}

function getNumberConfig(key: string, fallback: number): number {
	return vscode.workspace.getConfiguration('cliDiff').get<number>(key, fallback);
}

function getStringConfig(key: string, fallback: string): string {
	return vscode.workspace.getConfiguration('cliDiff').get<string>(key, fallback);
}

function hash(value: string): string {
	return createHash('sha1').update(value).digest('hex').slice(0, 16);
}
