import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getLanguageFromPath,
	highlightCode,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	matchesKey,
	type OverlayHandle,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type DiffRow, type FileEntry, parseNumstat, parseStatusV2, parseUnified, type RepoState } from "./git.ts";

type Position = "bottom" | "left" | "right";
const POSITIONS: Position[] = ["bottom", "left", "right"];

// ctrl+\ is unused by pi and reaches pi from macOS terminals (ctrl+alt and cmd chords often don't).
const DEFAULT_KEYS = ["ctrl+\\"];

/** Reads the `diffPanel` block of ~/.pi/agent/settings.json. Changes apply after /reload. */
function loadConfig(): { position: Position; keys: string[]; autoShow: boolean } {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"))?.diffPanel ?? {};
	} catch {
		// missing or invalid settings: use defaults
	}
	const keys = (Array.isArray(raw.key) ? raw.key : [raw.key]).filter(
		(k): k is string => typeof k === "string" && k.length > 0,
	);
	return {
		position: POSITIONS.includes(raw.position as Position) ? (raw.position as Position) : "bottom",
		keys: keys.length ? keys : DEFAULT_KEYS,
		autoShow: raw.autoShow !== false,
	};
}

const CONFIG = loadConfig();
const KEY_LABEL = CONFIG.keys[0]!;
// shortcut: fixed rows kept free under the side panel for editor + footer; a tall multi-line editor can still be covered.
const BOTTOM_RESERVE = 7;
const BAR_ROWS = 3;
const REFRESH_MS = 2000;
// shortcut: very large diffs are cut at this many rows to keep highlighting fast.
const MAX_ROWS = 5000;

const HELP = [
	"pi-diff-panel",
	"  /diff-panel                 toggle the panel",
	"  /diff-panel on | off        show or hide",
	"  /diff-panel bottom|left|right  move it (this session)",
	`  ${KEY_LABEL.padEnd(26)}  open diffs (bottom) or focus panel (side)`,
	"  /diff                       open the diff viewer",
	"Settings (~/.pi/agent/settings.json, then /reload):",
	'  "diffPanel": { "position": "bottom", "key": "ctrl+\\\\", "autoShow": true }',
].join("\n");

type Ui = ExtensionContext["ui"];

export default function (pi: ExtensionAPI) {
	let state: RepoState = { branch: "", ahead: 0, behind: 0, files: [] };
	let cwd = process.cwd();
	let position: Position = CONFIG.position;
	let shown = false;
	let ui: Ui | undefined;
	let tui: TUI | undefined;
	let handle: OverlayHandle | undefined;
	let closePanel: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;

	const git = (args: string[]) => pi.exec("git", ["-c", "core.quotePath=false", ...args], { cwd, timeout: 10_000 });

	async function refresh(): Promise<void> {
		if (refreshing) return;
		refreshing = true;
		try {
			const st = await git(["status", "--porcelain=v2", "--branch", "-z", "-uall"]);
			if (st.code !== 0) {
				state = { branch: "", ahead: 0, behind: 0, files: [], error: "Not a git repository" };
			} else {
				const next = parseStatusV2(st.stdout);
				const ns = await git(["diff", "HEAD", "--numstat"]);
				const counts = ns.code === 0 ? parseNumstat(ns.stdout) : new Map<string, [number, number]>();
				for (const f of next.files) [f.added, f.removed] = counts.get(f.path) ?? [undefined, undefined];
				state = next;
			}
		} finally {
			refreshing = false;
		}
		tui?.requestRender();
	}

	async function loadDiff(f: FileEntry): Promise<string> {
		// --no-index exits 1 when files differ; that is the normal case here.
		if (f.untracked) return (await git(["diff", "--no-index", "--", "/dev/null", f.path])).stdout;
		const r = await git(["diff", "HEAD", "--", f.path]);
		if (r.code === 0) return r.stdout;
		// No HEAD yet (fresh repo): show staged + unstaged against the empty tree.
		const staged = await git(["diff", "--cached", "--", f.path]);
		const work = await git(["diff", "--", f.path]);
		return staged.stdout + work.stdout;
	}

	function openViewer(target: Ui, index: number): void {
		void target.custom<void>((t, theme, _kb, done) => new DiffView(t, theme, () => state, index, loadDiff, done, cwd), {
			overlay: true,
			overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" },
		});
	}

	/** Footer hint so users who have the extension know how to open the panel. */
	function setHint(ctx: ExtensionContext): void {
		ctx.ui.setStatus("diff-panel", shown ? undefined : ctx.ui.theme.fg("muted", `⎇ /diff-panel · ${KEY_LABEL} diff`));
	}

	function showPanel(ctx: ExtensionContext): void {
		if (shown || ctx.mode !== "tui") return;
		shown = true;
		ui = ctx.ui;
		cwd = ctx.cwd;
		if (position === "bottom") {
			ctx.ui.setWidget("diff-panel", (t, theme) => {
				tui = t;
				return new BottomBar(theme, () => state, (i) => ui && openViewer(ui, i));
			});
			closePanel = () => ctx.ui.setWidget("diff-panel", undefined);
		} else {
			void ctx.ui
				.custom<void>(
					(t, theme, _kb, done) => {
						tui = t;
						closePanel = () => done();
						return new DiffPanel(
							t,
							theme,
							() => state,
							(i) => ui && openViewer(ui, i),
							() => handle?.unfocus(),
							() => void refresh(),
						);
					},
					{
						overlay: true,
						overlayOptions: {
							nonCapturing: true,
							anchor: position === "right" ? "top-right" : "top-left",
							width: "34%",
							minWidth: 30,
							visible: (w, h) => w >= 80 && h >= 12,
						},
						onHandle: (h) => {
							handle = h;
						},
					},
				)
				.finally(() => {
					handle = undefined;
				});
		}
		clearInterval(timer);
		timer = setInterval(() => void refresh(), REFRESH_MS);
		void refresh();
		setHint(ctx);
	}

	function hidePanel(ctx?: ExtensionContext): void {
		if (!shown) return;
		shown = false;
		clearInterval(timer);
		timer = undefined;
		const close = closePanel;
		closePanel = undefined;
		tui = undefined;
		close?.();
		if (ctx) setHint(ctx);
	}

	pi.registerCommand("diff-panel", {
		description: "Show or hide the uncommitted-changes panel: /diff-panel [on|off|bottom|left|right|help]",
		getArgumentCompletions: (prefix) => {
			const opts = [
				{ value: "on", label: "on", description: "Show the panel" },
				{ value: "off", label: "off", description: "Hide the panel" },
				{ value: "bottom", label: "bottom", description: "Show the panel above the editor" },
				{ value: "left", label: "left", description: "Show the panel on the left side" },
				{ value: "right", label: "right", description: "Show the panel on the right side" },
				{ value: "help", label: "help", description: "Show keys and settings" },
			].filter((o) => o.value.startsWith(prefix.trim()));
			return opts.length ? opts : null;
		},
		handler: async (args, ctx) => {
			const want = args.trim();
			if (POSITIONS.includes(want as Position)) {
				position = want as Position;
				hidePanel(ctx);
				showPanel(ctx);
			} else if (want === "on") showPanel(ctx);
			else if (want === "off") hidePanel(ctx);
			else if (want === "help") ctx.ui.notify(HELP, "info");
			else if (want) ctx.ui.notify(`Unknown option "${want}". Try: on, off, bottom, left, right, help`, "warning");
			else if (shown) hidePanel(ctx);
			else showPanel(ctx);
		},
	});

	pi.registerCommand("diff", {
		description: "Browse uncommitted changes with syntax-highlighted diffs",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") return;
			cwd = ctx.cwd;
			await refresh();
			openViewer(ctx.ui, 0);
		},
	});

	// Side panel: toggle focus. Bottom bar (or hidden panel): open the diff viewer.
	const onKey = async (ctx: ExtensionContext) => {
		if (shown && position !== "bottom") {
			if (handle?.isFocused()) handle.unfocus();
			else handle?.focus();
			return;
		}
		cwd = ctx.cwd;
		await refresh();
		openViewer(ctx.ui, 0);
	};
	for (const key of CONFIG.keys) {
		pi.registerShortcut(key as Parameters<typeof pi.registerShortcut>[0], {
			description: "Open uncommitted diffs (focuses the side panel when it is on the left/right)",
			handler: onKey,
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		if (CONFIG.autoShow) showPanel(ctx);
		else setHint(ctx);
	});
	pi.on("agent_end", () => void refresh());
	pi.on("session_shutdown", () => {
		try {
			hidePanel();
		} catch {
			// UI may already be torn down
		}
	});
}

// ─── bottom bar ────────────────────────────────────────────────────────────────

/** Compact widget above the editor: branch, totals, and files in columns. Click a file to open its diff. */
class BottomBar implements Component {
	private hits: { row: number; from: number; to: number; idx: number }[] = [];

	constructor(
		private theme: Theme,
		private getState: () => RepoState,
		private onOpen: (index: number) => void,
	) {}

	render(width: number): string[] {
		const th = this.theme;
		const s = this.getState();
		this.hits = [];
		if (s.error) return []; // stay out of the way outside git repos
		const n = s.files.length;
		const add = s.files.reduce((a, f) => a + (f.added ?? 0), 0);
		const del = s.files.reduce((a, f) => a + (f.removed ?? 0), 0);
		const summary = n
			? `${th.fg("muted", `${n} file${n === 1 ? "" : "s"}`)} ${th.fg("success", `+${add}`)} ${th.fg("error", `-${del}`)}`
			: `${th.fg("success", "✓")} ${th.fg("muted", "clean")}`;
		const left = ` ${branchLine(th, s)}  ${summary}`;
		const hint = th.fg("muted", `${KEY_LABEL} diff · /diff-panel off `);
		const gap = width - visibleWidth(left) - visibleWidth(hint);
		const lines = [gap >= 2 ? left + " ".repeat(gap) + hint : truncateToWidth(left, width, "…")];
		if (!n) return lines;
		this.hits.push({ row: 0, from: 0, to: visibleWidth(left), idx: 0 });

		const stat = (f: FileEntry) => (f.added !== undefined ? ` +${f.added} -${f.removed}` : "");
		const widest = Math.max(...s.files.map((f) => 2 + f.path.length + stat(f).length));
		const cellW = Math.min(widest + 4, Math.max(20, width - 2));
		const cols = Math.max(1, Math.floor((width - 1) / cellW));
		const rows = Math.min(BAR_ROWS, Math.ceil(n / cols));
		const visible = n > rows * cols ? rows * cols - 1 : n;
		const grid: string[] = Array(rows).fill("");
		const place = (i: number, cell: string, idx: number) => {
			const r = i % rows;
			const from = 1 + Math.floor(i / rows) * cellW;
			grid[r] += " ".repeat(Math.max(0, from - visibleWidth(grid[r]!))) + truncateToWidth(cell, cellW - 2, "…");
			this.hits.push({ row: 1 + r, from, to: from + cellW - 2, idx });
		};
		for (let i = 0; i < visible; i++) {
			const f = s.files[i]!;
			const st = stat(f);
			const room = cellW - 4 - st.length;
			const path = f.path.length > room ? `…${f.path.slice(-(room - 1))}` : f.path;
			const stats = st ? ` ${th.fg("success", `+${f.added}`)} ${th.fg("error", `-${f.removed}`)}` : "";
			place(i, `${th.fg(statusColor(f.code), f.code)} ${path}${stats}`, i);
		}
		if (visible < n) place(visible, th.fg("muted", `+${n - visible} more…`), visible);
		return [...lines, ...grid.map((l) => truncateToWidth(l, width, "…"))];
	}

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (e.type !== "click" || e.button !== "left") return undefined;
		const hit = this.hits.find((h) => h.row === e.y && e.x >= h.from && e.x < h.to);
		if (!hit) return undefined;
		this.onOpen(hit.idx);
		return { handled: true };
	}

	invalidate(): void {}
}

// ─── rendering helpers ────────────────────────────────────────────────────────

function frame(theme: Theme, width: number, title: string, body: string[], footer: string, active: boolean): string[] {
	const inner = Math.max(4, width - 2);
	const c = (s: string) => theme.fg(active ? "accent" : "border", s);
	const edge = (left: string, label: string, right: string) => {
		const text = label ? truncateToWidth(` ${label} `, inner - 1, "…") : "";
		return c(left + "─") + text + c("─".repeat(Math.max(0, inner - 1 - visibleWidth(text))) + right);
	};
	return [
		edge("╭", title, "╮"),
		...body.map((l) => c("│") + truncateToWidth(l, inner, "…", true) + c("│")),
		edge("╰", footer, "╯"),
	];
}

function statusColor(code: string): "success" | "error" | "warning" | "accent" | "muted" {
	if (code === "A" || code === "?") return "success";
	if (code === "D" || code === "U") return "error";
	if (code === "M") return "warning";
	if (code === "R" || code === "C") return "accent";
	return "muted";
}

function branchLine(theme: Theme, s: RepoState): string {
	let line = `${theme.fg("accent", "⎇")} ${theme.bold(s.branch || "?")}`;
	if (s.ahead) line += theme.fg("success", ` ↑${s.ahead}`);
	if (s.behind) line += theme.fg("warning", ` ↓${s.behind}`);
	return line;
}

// ─── side panel ───────────────────────────────────────────────────────────────

class DiffPanel implements Component, Focusable {
	focused = false;
	private selected = 0;
	private listTop = 0;
	private listStart = 0;
	private listLen = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getState: () => RepoState,
		private onOpen: (index: number) => void,
		private onBlur: () => void,
		private onRefresh: () => void,
	) {}

	handleInput(data: string): void {
		const n = this.getState().files.length;
		if (matchesKey(data, "escape") || CONFIG.keys.some((k) => matchesKey(data, k))) this.onBlur();
		else if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(n - 1, this.selected + 1);
		else if (matchesKey(data, "enter") && n) this.onOpen(this.selected);
		else if (data === "r") this.onRefresh();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const s = this.getState();
		const inner = width - 2;
		const height = Math.max(6, this.tui.terminal.rows - BOTTOM_RESERVE);
		this.selected = Math.max(0, Math.min(this.selected, s.files.length - 1));

		const body: string[] = [` ${branchLine(th, s)}`];
		if (s.error) body.push(` ${th.fg("muted", s.error)}`);
		else if (!s.files.length) body.push(` ${th.fg("success", "✓")} ${th.fg("muted", "working tree clean")}`);
		else {
			const add = s.files.reduce((a, f) => a + (f.added ?? 0), 0);
			const del = s.files.reduce((a, f) => a + (f.removed ?? 0), 0);
			const count = `${s.files.length} file${s.files.length === 1 ? "" : "s"}`;
			body.push(` ${th.fg("muted", count)}  ${th.fg("success", `+${add}`)} ${th.fg("error", `-${del}`)}`);
		}
		body.push("");

		const listH = height - 2 - body.length;
		const start = Math.max(0, Math.min(this.selected - Math.floor(listH / 2), s.files.length - listH));
		[this.listTop, this.listStart, this.listLen] = [body.length + 1, start, Math.min(listH, s.files.length - start)];
		for (const [i, f] of s.files.slice(start, start + listH).entries()) {
			const idx = start + i;
			const stats =
				f.added !== undefined ? `${th.fg("success", `+${f.added}`)} ${th.fg("error", `-${f.removed}`)} ` : "";
			const avail = inner - 4 - visibleWidth(stats) - 1;
			const path = f.path.length > avail ? `…${f.path.slice(-(avail - 1))}` : f.path;
			const sel = this.focused && idx === this.selected;
			const left = `${sel ? th.fg("accent", "▶") : " "} ${th.fg(statusColor(f.code), f.code)} ${sel ? th.bold(path) : path}`;
			const line = left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(stats))) + stats;
			body.push(sel ? th.bg("selectedBg", truncateToWidth(line, inner, "…", true)) : line);
		}
		while (body.length < height - 2) body.push("");

		const hint = this.focused ? "↑↓ ⏎ diff · r · esc" : `${KEY_LABEL} or click`;
		return frame(th, width, "Changes", body, th.fg("muted", hint), this.focused);
	}

	/** Click focuses the panel and selects a file; double-click (or click on the selected file) opens its diff. */
	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (e.type === "wheel") {
			const n = this.getState().files.length;
			this.selected = Math.max(0, Math.min(n - 1, this.selected + Math.sign(e.wheelDelta ?? 0)));
			return { handled: true, render: true };
		}
		if (e.type !== "click" || e.button !== "left") return e.type === "press" ? { handled: true } : undefined;
		const row = e.y - this.listTop;
		if (row >= 0 && row < this.listLen) {
			const idx = this.listStart + row;
			const open = (e.clickCount ?? 1) >= 2 || (this.focused && idx === this.selected);
			this.selected = idx;
			if (open) this.onOpen(idx);
		}
		return { focus: true, render: true };
	}

	invalidate(): void {}
}

// ─── full diff viewer ─────────────────────────────────────────────────────────

class DiffView implements Component {
	private scroll = 0;
	private rows: DiffRow[] | undefined;
	private cache: { width: number; lines: string[] } | undefined;
	private loadId = 0;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getState: () => RepoState,
		private index: number,
		private load: (f: FileEntry) => Promise<string>,
		private done: () => void,
		private cwd: string,
	) {
		this.reload();
	}

	private get file(): FileEntry | undefined {
		return this.getState().files[this.index];
	}

	private reload(): void {
		const f = this.file;
		const id = ++this.loadId;
		this.rows = undefined;
		this.cache = undefined;
		this.scroll = 0;
		if (!f) return;
		this.load(f)
			.then((d) => parseUnified(d).slice(0, MAX_ROWS))
			.catch((e: unknown): DiffRow[] => [{ kind: "meta", text: `Failed to load diff: ${String(e)}` }])
			.then((rows) => {
				if (id !== this.loadId) return;
				this.rows = rows.length ? rows : [{ kind: "meta", text: "(no textual changes)" }];
				this.tui.requestRender();
			});
	}

	private bodyHeight(): number {
		return Math.max(3, Math.floor(this.tui.terminal.rows * 0.92) - 2);
	}

	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (e.type !== "wheel") return undefined;
		this.scroll += (e.wheelDelta ?? 0) * 3;
		return { handled: true, render: true };
	}

	handleInput(data: string): void {
		const page = this.bodyHeight() - 1;
		const n = this.getState().files.length;
		if (matchesKey(data, "escape") || data === "q") return this.done();
		if (matchesKey(data, "up") || data === "k") this.scroll--;
		else if (matchesKey(data, "down") || data === "j") this.scroll++;
		else if (matchesKey(data, "pageUp") || data === "b") this.scroll -= page;
		else if (matchesKey(data, "pageDown") || data === " ") this.scroll += page;
		else if (matchesKey(data, "home") || data === "g") this.scroll = 0;
		else if (matchesKey(data, "end") || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		else if ((matchesKey(data, "right") || data === "l" || data === "n") && n) {
			this.index = (this.index + 1) % n;
			this.reload();
		} else if ((matchesKey(data, "left") || data === "h" || data === "p") && n) {
			this.index = (this.index - 1 + n) % n;
			this.reload();
		}
		this.tui.requestRender();
	}

	private build(inner: number): string[] {
		const th = this.theme;
		const rows = this.rows ?? [];
		const lang = this.file ? getLanguageFromPath(this.file.path) : undefined;
		const text = rows.map((r) => r.text.replace(/\t/g, "    "));

		// Highlight each hunk as one block so multi-line constructs keep their context.
		const hl = [...text];
		for (let i = 0; i < rows.length; ) {
			if (rows[i]!.kind === "hunk" || rows[i]!.kind === "meta") {
				i++;
				continue;
			}
			let j = i;
			while (j < rows.length && rows[j]!.kind !== "hunk" && rows[j]!.kind !== "meta") j++;
			const out = highlightCode(text.slice(i, j).join("\n"), lang);
			if (out.length === j - i) hl.splice(i, j - i, ...out);
			i = j;
		}

		const numW = String(rows.reduce((m, r) => Math.max(m, r.oldNo ?? 0, r.newNo ?? 0), 0)).length;
		const num = (v?: number) => (v === undefined ? "" : String(v)).padStart(numW);
		return rows.map((r, i) => {
			if (r.kind === "hunk") return th.fg("accent", r.text);
			if (r.kind === "meta") return th.fg("muted", r.text);
			const gutter = th.fg("muted", `${num(r.oldNo)} ${num(r.newNo)} `);
			if (r.kind === "ctx") return `${gutter}  ${hl[i]}`;
			const [sign, color, bg] =
				r.kind === "add"
					? (["+", "success", "toolSuccessBg"] as const)
					: (["-", "error", "toolErrorBg"] as const);
			return th.bg(bg, truncateToWidth(`${gutter}${th.fg(color, sign)} ${hl[i]}`, inner, "…", true));
		});
	}

	render(width: number): string[] {
		const th = this.theme;
		const inner = width - 2;
		const h = this.bodyHeight();
		const s = this.getState();
		const f = this.file;

		let lines: string[];
		if (s.error) lines = [th.fg("warning", ` ${s.error}: ${this.cwd}`)];
		else if (!f) lines = [` ${th.fg("success", "✓")} ${th.fg("muted", "No uncommitted changes")}`];
		else if (!this.rows) lines = [th.fg("muted", " Loading…")];
		else {
			if (this.cache?.width !== inner) this.cache = { width: inner, lines: this.build(inner) };
			lines = this.cache.lines;
		}
		this.scroll = Math.max(0, Math.min(this.scroll, lines.length - h));
		const body = lines.slice(this.scroll, this.scroll + h);
		while (body.length < h) body.push("");

		const title = f
			? `${th.fg(statusColor(f.code), f.code)} ${th.bold(f.path)}  ${th.fg("muted", `${this.index + 1}/${s.files.length}`)}  ${branchLine(th, s)}`
			: branchLine(th, s);
		const pos = lines.length > h ? ` ${Math.round(((this.scroll + h) / lines.length) * 100)}%` : "";
		const footer = th.fg("muted", `↑↓ scroll · pgup/pgdn · ←→ file · esc close${pos}`);
		return frame(th, width, title, body, footer, true);
	}

	invalidate(): void {
		this.cache = undefined;
	}
}
