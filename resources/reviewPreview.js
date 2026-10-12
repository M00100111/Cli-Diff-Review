/* Display-only preview controller. No Git mutations or persisted hunk identities. */
(function () {
	'use strict';
	class CliDiffPreview {
		constructor(workerUri, changed) {
			this.workerUri = workerUri; this.changed = changed;
			this.requestId = 0; this.baselineVersion = 0; this.cache = new Map();
			this.wordResults = {}; this.blocks = null; this.failed = false;
		}
		isPreview() { return Boolean(this.state && (this.state.dirty || this.text !== this.state.reviewText)); }
		update(state, model, immediate) {
			const text = model.getValue();
			const key = JSON.stringify([state.uri, state.comparisonBaseText, text, this.isFormal(state, text) ? state.pendingHunks.map(h => [h.id, h.oldText, h.newText]) : null]);
			if (!this.state || this.state.uri !== state.uri || this.state.comparisonBaseText !== state.comparisonBaseText) {
				this.baselineVersion++; this.cache.clear();
			}
			this.state = state; this.text = text; this.model = model;
			if (key === this.key) { return; }
			this.key = key; this.cancel(); this.blocks = null; this.wordResults = {}; this.failed = false;
			const cached = this.cache.get(key);
			if (cached) { this.apply(cached); return; }
			const id = this.requestId, baselineVersion = this.baselineVersion, modelVersion = model.getVersionId();
			this.timer = setTimeout(async () => {
				const request = { id, uri: state.uri, baselineVersion, modelVersion, oldText: state.comparisonBaseText, newText: text };
				if (this.isFormal(state, text)) { request.hunks = state.pendingHunks.filter(h => h.kind === 'modify').map(h => ({ id: h.id, oldText: h.oldText, newText: h.newText })); }
				try {
					this.watchdog = setTimeout(() => this.fail(id), 2000);
					// VS Code resources must be fetched in the page, not imported inside a worker.
					this.workerSource ??= fetch(this.workerUri).then(response => { if (!response.ok) { throw new Error('Worker resource unavailable'); } return response.text(); }).catch(error => { this.workerSource = null; throw error; });
					const source = await this.workerSource;
					if (id !== this.requestId) { return; }
					const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
					this.worker = new Worker(url); URL.revokeObjectURL(url);
					this.worker.onmessage = ({ data }) => {
						if (id !== this.requestId || data.id !== id || data.uri !== this.state.uri || data.baselineVersion !== this.baselineVersion || data.modelVersion !== this.model.getVersionId()) { return; }
						clearTimeout(this.watchdog); this.worker.terminate(); this.worker = null;
						if (!data.failed && !data.result?.timedOut) {
							this.cache.set(key, data);
							if (this.cache.size > 4) { this.cache.delete(this.cache.keys().next().value); }
						}
						this.apply(data);
					};
					this.worker.onerror = () => this.fail(id);
					// Includes worker startup; the computation itself has a 200ms budget.
					this.worker.postMessage(request);
				} catch { this.fail(id); }
			}, immediate ? 0 : 150);
		}
		isFormal(state, text) { return !state.dirty && text === state.reviewText; }
		fail(id) {
			if (id !== this.requestId) { return; }
			this.cancel(); this.failed = true; this.blocks = null; this.wordResults = {}; this.changed();
		}
		apply(data) {
			this.failed = Boolean(data.failed || data.result?.timedOut);
			this.blocks = this.failed ? null : data.result?.blocks ?? null;
			this.wordResults = data.hunks || {}; this.changed();
		}
		cancel() {
			this.requestId++; clearTimeout(this.timer); clearTimeout(this.watchdog);
			this.worker?.terminate(); this.worker = null;
		}
		dispose() { this.cancel(); this.cache.clear(); }
		entries(formal) {
			if (this.isPreview()) {
				if (this.blocks === null) {
					return formal.filter(e => !e.decided).map(e => ({ ...e, preview: true, oldRanges: [], newRanges: [] }));
				}
				return this.blocks.map((b, i) => ({ ...b, id: 'preview-' + this.requestId + '-' + i, displayStart: b.newStart, displayLines: b.newLines,
					zoneAfterLineNumber: b.newStart, oldLinesToShow: b.oldText.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) || [],
					state: 'pending', decided: false, source: 'preview', preview: true }));
			}
			return formal.map(entry => {
				if (entry.decided) { return { ...entry, oldRanges: [], newRanges: [] }; }
				const diff = this.wordResults[entry.id];
				const oldRanges = [], newRanges = [];
				if (diff && !diff.timedOut && !diff.wordsTimedOut) {
					for (const block of diff.blocks) {
						oldRanges.push(...block.oldRanges.map(r => ({ ...r, line: r.line + block.oldStart })));
						newRanges.push(...block.newRanges.map(r => ({ ...r, line: r.line + block.newStart })));
					}
				}
				return { ...entry, oldRanges, newRanges };
			});
		}
		status() {
			if (this.failed) { return '实时预览暂不可用 · 显示最近审查区块'; }
			if (this.isPreview()) { return this.state.dirty ? '未保存预览，保存后可审查' : '正在同步审查状态…'; }
			return '';
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
	window.CliDiffPreview = CliDiffPreview;
	window.cliColorizeOldLine = colorizeOldLine;
	window.cliPreviewRendering = { projectLine, markTextNodes };
})();
