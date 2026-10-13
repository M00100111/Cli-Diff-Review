import { Worker } from 'worker_threads';

/** A user/model regex cannot monopolize the extension host event loop. */
export function matchingLines(text: string, pattern: string, caseSensitive: boolean, signal?: AbortSignal, timeoutMs = 3000): Promise<number[]> {
 return new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('Search cancelled')); return; }
  const worker = new Worker(`
   const { parentPort, workerData } = require('worker_threads');
   try {
    const expression = new RegExp(workerData.pattern, workerData.caseSensitive ? '' : 'i');
    const lines = workerData.text.split(/\\r?\\n/), matches = [];
    for (let i = 0; i < lines.length; i++) { if (expression.test(lines[i])) matches.push(i); }
    parentPort.postMessage({ matches });
   } catch (error) { parentPort.postMessage({ error: error.message }); }
  `, { eval: true, workerData: { text, pattern, caseSensitive } });
  const finish = (error?: Error, matches?: number[]) => {
   clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate();
   if (error) { reject(error); } else { resolve(matches ?? []); }
  };
  const abort = () => finish(new Error('Search cancelled'));
  const timer = setTimeout(() => finish(new Error('Regex search timed out; use a narrower or simpler pattern')), timeoutMs);
  signal?.addEventListener('abort', abort, { once: true });
  worker.once('message', (result: { matches?: number[]; error?: string }) => finish(result.error ? new Error(result.error) : undefined, result.matches));
  worker.once('error', (error) => finish(error));
 });
}
