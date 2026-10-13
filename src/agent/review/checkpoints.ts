import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { hash } from './live';
import type { ReviewHostState } from './host';

/** Content-addressed tasks avoid rewriting every sibling history at each checkpoint. */
export class ReviewCheckpointStore {
 private readonly written = new Set<string>();
 public constructor(private readonly directory: vscode.Uri) {}
 public async save(state: ReviewHostState): Promise<string> {
  await vscode.workspace.fs.createDirectory(this.directory);
  const tasks: Record<string, string> = {};
  for (const [id, task] of Object.entries(state.tasks)) { tasks[id] = await this.put(JSON.stringify(task)); }
  return this.put(JSON.stringify({ ...state, tasks }));
 }
 public async load(ref: string): Promise<ReviewHostState> {
  const state = JSON.parse(await this.get(ref)) as Omit<ReviewHostState, 'tasks'> & { tasks: Record<string, string> };
  if (state.version !== 2 || !state.tasks || typeof state.tasks !== 'object') { throw new Error('Invalid review checkpoint'); }
  const tasks: ReviewHostState['tasks'] = {};
  for (const [id, taskRef] of Object.entries(state.tasks)) {
   const task = JSON.parse(await this.get(taskRef));
   if (task.id !== id) { throw new Error('Review task checkpoint identity mismatch'); }
   tasks[id] = task;
  }
  return { ...state, tasks };
 }
 private uri(ref: string): vscode.Uri {
  if (!/^[a-f0-9]{64}$/.test(ref)) { throw new Error('Invalid checkpoint reference'); }
  return vscode.Uri.joinPath(this.directory, ref + '.json');
 }
 private async get(ref: string): Promise<string> {
  const value = Buffer.from(await vscode.workspace.fs.readFile(this.uri(ref))).toString('utf8');
  if (hash(value) !== ref) { throw new Error('Corrupt review checkpoint; existing progress has been retained'); }
  return value;
 }
 private async put(value: string): Promise<string> {
  const ref = hash(value);
  if (this.written.has(ref)) { return ref; }
  const temporary = vscode.Uri.joinPath(this.directory, randomUUID() + '.tmp');
  await vscode.workspace.fs.writeFile(temporary, Buffer.from(value, 'utf8'));
  await vscode.workspace.fs.rename(temporary, this.uri(ref), { overwrite: true });
  this.written.add(ref);
  return ref;
 }
}
