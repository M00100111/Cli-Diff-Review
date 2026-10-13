import { matchingLines } from './search';
import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReviewFileState, ReviewHunk, ReviewSession } from '../../types';

export function canonicalJson(value: unknown): string {
 if (Array.isArray(value)) { return '[' + value.map(canonicalJson).join(',') + ']'; }
 if (value && typeof value === 'object') { return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item)).join(',') + '}'; }
 return JSON.stringify(value) ?? 'null';
}
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface Evidence { path: string; side: 'old' | 'new'; version: string; startLine: number; endLine: number }
export interface Chunk { chunkRef: string; path: string; file: ReviewFileState; hunk: ReviewHunk; version: string }
export interface LiveState { revision: number; versions: Record<string, string>; evidence: Record<string, Evidence> }

/** Cursor is query/version-bound. The raw content is never persisted in the review checkpoint. */
export function page(text: string, query: unknown, cursor: unknown, max = 12000): { text: string; nextCursor: string | null; truncated: boolean } {
 const key = hash(canonicalJson(query) + text);
 let offset = 0;
 if (cursor !== null && cursor !== undefined) {
  if (typeof cursor !== 'string') { throw new Error('Invalid cursor'); }
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { key: string; offset: number };
  if (decoded.key !== key || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0 || decoded.offset > text.length) { throw new Error('Stale cursor: restart this query'); }
  offset = decoded.offset;
 }
 const end = Math.min(text.length, offset + max);
 return { text: text.slice(offset, end), nextCursor: end < text.length ? Buffer.from(JSON.stringify({ key, offset: end })).toString('base64url') : null, truncated: end < text.length };
}

export class LiveReviewIndex {
 public chunks = new Map<string, Chunk>();
 public session: ReviewSession;
 public constructor(private readonly root: string, session: ReviewSession, public readonly state: LiveState, private readonly refresh?: () => Promise<ReviewSession>) { this.session = session; }
 public async scan(): Promise<string[]> {
  this.session = await this.refresh?.() ?? this.session;
  const versions: Record<string, string> = {};
  const chunks = new Map<string, Chunk>();
  for (const file of this.session.files.values()) {
   const relative = path.relative(this.root, file.uri.fsPath).replace(/\\/g, '/');
   if (relative.startsWith('../') || path.isAbsolute(relative)) { continue; }
   const version = hash(file.oldText + '\0' + file.newText + '\0' + (file.gitSnapshot?.indexBlobOid ?? ''));
   versions[relative] = version;
   for (const hunk of file.hunks) {
    const identity = hunk.reviewItemId ?? hunk.sourceHunkId ?? hunk.id;
    const chunkRef = `chunk:${hash(this.root + '\0' + relative + '\0' + identity + '\0' + version)}`;
    chunks.set(chunkRef, { chunkRef, path: relative, file, hunk, version });
   }
  }
  const changed = [...new Set([...Object.keys(versions), ...Object.keys(this.state.versions)])].filter((name) => versions[name] !== this.state.versions[name]);
  if (changed.length) { this.state.revision++; }
  this.state.versions = versions;
  this.chunks = chunks;
  return changed;
 }
 public chunk(ref: unknown): Chunk {
  const chunk = typeof ref === 'string' ? this.chunks.get(ref) : undefined;
  if (!chunk) { throw new Error('Unknown or stale chunkRef; call list_changes again'); }
  return chunk;
 }
 public async safePath(relative: string): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => ['..', '.git', '.cli-diff'].includes(part.toLowerCase()))) { throw new Error('Path must be inside the project and outside plugin/Git internal state'); }
  const root = await fs.realpath(this.root);
  const resolved = await fs.realpath(path.resolve(root, relative));
  const inside = path.relative(root, resolved);
  if (inside.split(path.sep).some((part) => ['.git', '.cli-diff'].includes(part.toLowerCase()))) { throw new Error('Symlink targets Git or plugin internal state'); }
  if (inside.startsWith('..' + path.sep) || inside === '..' || path.isAbsolute(inside)) { throw new Error('Symlink escapes project root'); }
  return resolved;
 }
 public async read(relative: string): Promise<string> {
  const target = await this.safePath(relative);
  const bytes = await fs.readFile(target);
  if (bytes.includes(0)) { throw new Error('Binary file cannot be read as source'); }
  return bytes.toString('utf8');
 }
 public evidence(relative: string, side: 'old' | 'new', text: string, startLine: number, endLine: number): string {
  const value: Evidence = { path: relative, side, version: hash(text), startLine, endLine };
  const ref = `evidence:${hash(JSON.stringify(value))}`;
  this.state.evidence[ref] = value;
  return ref;
 }
 public async verifyEvidence(value: { evidenceRef: string; side: string; startLine: number; endLine: number }): Promise<void> {
  const evidence = this.state.evidence[value.evidenceRef];
  if (!evidence || value.side !== evidence.side || value.startLine < evidence.startLine || value.endLine > evidence.endLine || value.endLine < value.startLine) { throw new Error('Unknown evidence or range outside the read evidence'); }
  const file = [...this.session.files.values()].find((candidate) => path.relative(this.root, candidate.uri.fsPath).replace(/\\/g, '/') === evidence.path);
  const text = evidence.side === 'new' ? await this.read(evidence.path) : file?.oldText;
  if (text === undefined || hash(text) !== evidence.version) { throw new Error('Evidence changed; reread before submitting'); }
 }
 public async assertCurrent(chunk: Chunk): Promise<void> {
  let actual: string;
  try { actual = await this.read(chunk.path); } catch (error) {
   if (!chunk.file.currentExists && (error as NodeJS.ErrnoException).code === 'ENOENT') { actual = ''; } else { throw error; }
  }
  if (actual !== chunk.file.newText) { throw new Error('Chunk changed on disk; refresh list_changes'); }
 }
 public async readTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (name === 'list_changes') {
   const entries = [...this.chunks.values()].filter((chunk) => !args.path || chunk.path.startsWith(String(args.path))).map(({ chunkRef, path: relative, hunk }) => ({ chunkRef, path: relative, oldStart: hunk.oldStart + 1, oldLines: hunk.oldLines, newStart: hunk.newStart + 1, newLines: hunk.newLines }));
   return { revision: this.state.revision, ...page(JSON.stringify(entries), { name, path: args.path }, args.cursor, Math.min(12000, Number(args.limit) * 250)) };
  }
  if (name === 'read_change') {
   const chunk = this.chunk(args.chunkRef);
   await this.assertCurrent(chunk);
   const context = Number(args.contextLines);
   const result: Record<string, unknown> = { chunkRef: chunk.chunkRef, path: chunk.path };
   for (const side of ['old', 'new'] as const) {
    const text = side === 'old' ? chunk.file.oldText : chunk.file.newText;
    const lines = text.split(/\r?\n/);
    const start = Math.max(0, chunk.hunk[`${side}Start`] - context);
    const end = Math.min(lines.length, chunk.hunk[`${side}Start`] + chunk.hunk[`${side}Lines`] + context);
    result[side] = { evidenceRef: this.evidence(chunk.path, side, text, start + 1, Math.max(start + 1, end)), startLine: start + 1, lines: lines.slice(start, end) };
   }
   return page(JSON.stringify(result), { name, chunkRef: args.chunkRef, context }, args.cursor);
  }
  if (name === 'Read') {
   const relative = String(args.path), text = await this.read(relative), lines = text.split(/\r?\n/);
   const start = Number(args.offset), end = Math.min(lines.length, start + Number(args.limit) - 1);
   if (start > lines.length) { throw new Error(`offset exceeds ${lines.length} lines`); }
   const evidenceRef = this.evidence(relative, 'new', text, start, end);
   return { evidenceRef, startLine: start, endLine: end, ...page(lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n'), { name, path: relative, start, end }, args.cursor) };
  }
  const base = args.path ? String(args.path) : '';
  if (base) { await this.safePath(base); }
  const pattern = name === 'Glob' ? String(args.pattern) : args.glob ? String(args.glob) : '**/*';
  const isFile = base ? (await fs.stat(await this.safePath(base))).isFile() : false;
  const files = isFile ? [vscode.Uri.file(await this.safePath(base))] : await vscode.workspace.findFiles(new vscode.RelativePattern(this.root, (base ? base.replace(/\/$/, '') + '/' : '') + pattern), '**/{.git,node_modules,.cli-diff}/**');
  const results: unknown[] = [];

  for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
   const relative = path.relative(this.root, uri.fsPath).replace(/\\/g, '/');
   if (name === 'Glob') { try { await this.safePath(relative); results.push(relative); } catch { /* skip escaping links */ } continue; }
   let text: string;
   try { text = await this.read(relative); } catch { continue; }
   const lines = text.split(/\r?\n/);
   const patternText = String(args.pattern);
   const indices = args.mode === 'regex' ? await matchingLines(text, patternText, Boolean(args.caseSensitive), signal) : lines.flatMap((line, i) => (args.caseSensitive ? line.includes(patternText) : line.toLowerCase().includes(patternText.toLowerCase())) ? [i] : []);
   for (const i of indices) {
    if (signal?.aborted) { throw new Error('Search cancelled'); }
    {
     const start = Math.max(0, i - Number(args.contextLines)), end = Math.min(lines.length, i + Number(args.contextLines) + 1);
     results.push({ path: relative, line: i + 1, evidenceRef: this.evidence(relative, 'new', text, start + 1, end), startLine: start + 1, lines: lines.slice(start, end) });
    }
   }
  }
  return page(JSON.stringify(results), { name, ...args, cursor: null }, args.cursor);
 }
}
