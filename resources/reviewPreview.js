/* Word highlighting for formal Git hunks only. Never computes file-level chunks. */
(function () {
	'use strict';
	class CliDiffHunkHighlighter {
		constructor(workerUri, changed) {
			this.workerUri = workerUri; this.changed = changed;
			this.requestId = 0; this.wordResults = {}; this.cache = new Map();
		}
		suspend() {
			this.cancel(); this.key = undefined; this.wordResults = {};
		}
		update(state) {
			const hunks = state.pendingHunks.filter(h => h.kind === 'modify').map(h => ({ id: h.id, oldText: h.oldText, newText: h.newText }));
			const key = JSON.stringify([state.uri, state.revision, hunks]);
			if (key === this.key) { return; }
			this.cancel(); this.key = key; this.wordResults = {};
			if (!hunks.length) { return; }
			const cached = this.cache.get(key);
			if (cached) { this.wordResults = cached; return; }
			const id = this.requestId;
			const request = { id, uri: state.uri, revision: state.revision, hunks };
			this.timer = setTimeout(async () => {
				try {
					this.watchdog = setTimeout(() => this.fail(id), 2000);
					this.workerSource ??= fetch(this.workerUri).then(response => { if (!response.ok) { throw new Error('Worker resource unavailable'); } return response.text(); }).catch(error => { this.workerSource = null; throw error; });
					const source = await this.workerSource;
					if (id !== this.requestId) { return; }
					const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
					this.worker = new Worker(url); URL.revokeObjectURL(url);
					this.worker.onmessage = ({ data }) => {
						if (id !== this.requestId || data.id !== id || data.uri !== request.uri || data.revision !== request.revision) { return; }
						clearTimeout(this.watchdog); this.worker.terminate(); this.worker = null;
						this.wordResults = data.failed ? {} : data.hunks || {};
						if (!data.failed) {
							this.cache.set(key, this.wordResults);
							if (this.cache.size > 4) { this.cache.delete(this.cache.keys().next().value); }
						}
						this.changed();
					};
					this.worker.onerror = () => this.fail(id);
					this.worker.postMessage(request);
				} catch { this.fail(id); }
			}, 0);
		}
		fail(id) {
			if (id !== this.requestId) { return; }
			this.cancel(); this.wordResults = {}; this.changed();
		}
		cancel() {
			this.requestId++; clearTimeout(this.timer); clearTimeout(this.watchdog);
			this.worker?.terminate(); this.worker = null;
		}
		dispose() { this.cancel(); this.cache.clear(); }
		entries(formal) {
			return formal.map(entry => {
				const ranges = entry.decided ? undefined : this.wordResults[entry.id];
				return { ...entry, oldRanges: ranges?.oldRanges || [], newRanges: ranges?.newRanges || [] };
			});
		}
	}
	// Project source columns into the colorizer input, including expanded tabs.
	function projectLine(source, ranges, tabSize) {
		let text = '', column = 0;
		const offsets = [0];
		for (let i = 0; i < source.length;) {
			const cp = source.codePointAt(i), char = String.fromCodePoint(cp);
			const replacement = char === '\t' ? ' '.repeat(tabSize - column % tabSize) : char === '\uFEFF' ? '\u200B' : char;
			text += replacement;
			if (char === '\t') { column += replacement.length; }
			else { column += cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff || cp >= 0xff01 && cp <= 0xff60) ? 2 : 1; }
			for (let j = 1; j <= char.length; j++) { offsets[i + j] = text.length - char.length + j; }
			offsets[i + char.length] = text.length; i += char.length;
		}
		return { text, ranges: ranges.map(r => ({ start: offsets[r.start], end: offsets[r.end] })).filter(r => r.end > r.start) };
	}
	function markTextNodes(element, ranges) {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = [];
		while (walker.nextNode()) { nodes.push(walker.currentNode); }
		let offset = 0;
		for (const node of nodes) {
			const text = node.textContent, end = offset + text.length;
			const intersections = ranges.filter(r => r.start < end && r.end > offset).map(r => ({ start: Math.max(0, r.start - offset), end: Math.min(text.length, r.end - offset) }));
			if (intersections.length) {
				const fragment = document.createDocumentFragment(); let cursor = 0;
				for (const range of intersections) {
					const start = Math.max(cursor, range.start);
					if (range.end <= start) { continue; }
					fragment.appendChild(document.createTextNode(text.slice(cursor, start)));
					const span = document.createElement('span'); span.className = 'cli-word-delete'; span.textContent = text.slice(start, range.end);
					fragment.appendChild(span); cursor = range.end;
				}
				fragment.appendChild(document.createTextNode(text.slice(cursor))); node.replaceWith(fragment);
			}
			offset = end;
		}
	}
	async function colorizeOldLine(code, source, ranges, language, tabSize, valid) {
		const projection = projectLine(source, ranges, tabSize);
		code.textContent = projection.text; markTextNodes(code, projection.ranges);
		try {
			const html = await monaco.editor.colorize(projection.text || ' ', language, { tabSize });
			if (!valid()) { return; }
			const template = document.createElement('template'); template.innerHTML = html;
			template.content.querySelectorAll('br').forEach(node => node.remove());
			code.replaceChildren(template.content);
			markTextNodes(code, projection.ranges);
		} catch { /* Safe plain-text highlighting is already present. */ }
	}
	window.CliDiffHunkHighlighter = CliDiffHunkHighlighter;
	window.cliColorizeOldLine = colorizeOldLine;
	window.cliPreviewRendering = { projectLine, markTextNodes };
})();
