import * as vscode from 'vscode';
import { ReviewController } from './reviewController';

let controller: ReviewController | undefined;

export function activate(context: vscode.ExtensionContext): void {
	controller = new ReviewController(context);
	context.subscriptions.push(controller);
}

export function deactivate(): void {
	controller?.dispose();
	controller = undefined;
}
