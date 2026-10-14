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
const DEFAULT_ROWS = 5;

/** Reads the `diffPanel` block of ~/.pi/agent/settings.json. Changes apply after /reload. */
function loadConfig(): { position: Position; keys: string[]; autoShow: boolean; rows: number } {
	let raw: Record<string, unknown> = {};
	try {
		raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8"))?.diffPanel ?? {};
	} catch {
		// missing or invalid settings: use defaults
	}
	const keys = (Array.isArray(raw.key) ? raw.key : [raw.key]).filter(
		(k): k is string => typeof k === "string" && k.length > 0,
	);
	const rows = Number(raw.height);
	return {
		position: POSITIONS.includes(raw.position as Position) ? (raw.position as Position) : "bottom",
		keys: keys.length ? keys : DEFAULT_KEYS,
		autoShow: raw.autoShow !== false,
		rows: Number.isInteger(rows) && rows >= 1 && rows <= 40 ? rows : DEFAULT_ROWS,
	};
}

const CONFIG = loadConfig();
const KEY_LABEL = CONFIG.keys[0]!;
// shortcut: fixed rows kept free under the side panel for editor + footer; a tall multi-line editor can still be covered.
const BOTTOM_RESERVE = 7;
const REFRESH_MS = 2000;
// shortcut: very large diffs are cut at this many rows to keep highlighting fast.
const MAX_ROWS = 5000;

const HELP = [
	"pi-diff-panel",
	"  /diff-panel                     toggle the panel",
	"  /diff-panel on | off            show or hide",
	"  /diff-panel bottom|left|right   move it (this session)",
	`  ${KEY_LABEL.padEnd(30)}  focus the panel (↑↓ select, ⏎ diff, esc back)`,
	"  /diff                           open the diff viewer",
	"Settings (~/.pi/agent/settings.json, then /reload):",
	'  "diffPanel": { "position": "bottom", "height": 5, "key": "ctrl+\\\\", "autoShow": true }',
].join("\n");

type Ui = ExtensionContext["ui"];
type FocusTui = TUI & { getFocusedComponent?(): Component | null };

export default function (pi: ExtensionAPI) {
	let state: RepoState = { branch: "", ahead: 0, behind: 0, files: [] };
	let cwd = process.cwd();
	let position: Position = CONFIG.position;
	let shown = false;
	let ui: Ui | undefined;
	let tui: FocusTui | undefined;
	let panel: DiffPanel | undefined;
	let handle: OverlayHandle | undefined;
	let closePanel: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing = false;
	let focusOnShow = false;
	// Bottom panel is a widget, not an overlay, so focus is restored by hand.
	let prevFocus: Component | null = null;
	let editorFocus: Component | null = null;

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

	function focusPanel(): void {
		if (!panel) {
			focusOnShow = true; // side overlay mounts asynchronously
			return;
		}
		if (position !== "bottom") return handle?.focus();
		if (!tui || panel.focused) return;
		prevFocus = tui.getFocusedComponent?.() ?? null;
		tui.setFocus(panel);
		tui.requestRender();
	}

	function blurPanel(): void {
		if (position !== "bottom") return handle?.unfocus();
		if (!tui || !panel?.focused) return;
		tui.setFocus(prevFocus ?? editorFocus);
		prevFocus = null;
		tui.requestRender();
	}

	/** Footer hint so users who have the extension know how to open the panel. */
	function setHint(ctx: ExtensionContext): void {
		ctx.ui.setStatus("diff-panel", shown ? undefined : ctx.ui.theme.fg("muted", `⎇ /diff-panel · ${KEY_LABEL} changes`));
	}

	function showPanel(ctx: ExtensionContext): void {
		if (shown || ctx.mode !== "tui") return;
		shown = true;
		ui = ctx.ui;
		cwd = ctx.cwd;
		const make = (t: TUI, theme: Theme) =>
			new DiffPanel(
				t,
				theme,
				() => state,
				position === "bottom" ? "bottom" : "side",
				(i) => ui && openViewer(ui, i),
				blurPanel,
				() => void refresh(),
			);
		if (position === "bottom") {
			ctx.ui.setWidget("diff-panel", (t, theme) => {
				tui = t;
				editorFocus = tui.getFocusedComponent?.() ?? null;
				panel = make(t, theme);
				return panel;
			});
			closePanel = () => ctx.ui.setWidget("diff-panel", undefined);
			if (focusOnShow) {
				focusOnShow = false;
				focusPanel();
			}
		} else {
			void ctx.ui
				.custom<void>(
					(t, theme, _kb, done) => {
						tui = t;
						closePanel = () => done();
						panel = make(t, theme);
						return panel;
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
							if (focusOnShow) h.focus();
							focusOnShow = false;
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
		blurPanel();
		shown = false;
		clearInterval(timer);
		timer = undefined;
		const close = closePanel;
		closePanel = undefined;
		panel = undefined;
		focusOnShow = false;
		close?.();
		tui = undefined;
		if (ctx) setHint(ctx);
	}

	pi.registerCommand("diff-panel", {
		description: "Show or hide the uncommitted-changes panel: /diff-panel [on|off|bottom|left|right|focus|help]",
		getArgumentCompletions: (prefix) => {
			const opts = [
				{ value: "on", label: "on", description: "Show the panel" },
				{ value: "off", label: "off", description: "Hide the panel" },
				{ value: "bottom", label: "bottom", description: "Show the panel above the editor" },
				{ value: "left", label: "left", description: "Show the panel on the left side" },
				{ value: "right", label: "right", description: "Show the panel on the right side" },
				{ value: "focus", label: "focus", description: `Focus the panel (same as ${KEY_LABEL})` },
				{ value: "help", label: "help", description: "Show keys and settings" },
			].filter((o) => o.value.startsWith(prefix.trim()));
			return opts.length ? opts : null;
		},
		handler: async (args, ctx) => {
			const want = args.trim();
			if (POSITIONS.includes(want as Position)) {
				hidePanel(ctx);
				position = want as Position;
				showPanel(ctx);
			} else if (want === "on") showPanel(ctx);
			else if (want === "off") hidePanel(ctx);
			else if (want === "focus") {
				focusPanel();
				showPanel(ctx);
			} else if (want === "help") ctx.ui.notify(HELP, "info");
			else if (want) ctx.ui.notify(`Unknown option "${want}". Try: on, off, bottom, left, right, focus, help`, "warning");
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

	// Fires only while the editor has focus; the focused panel handles the same key itself to give focus back.
	for (const key of CONFIG.keys) {
		pi.registerShortcut(key as Parameters<typeof pi.registerShortcut>[0], {
			description: "Focus the diff panel (opens it if hidden)",
			handler: (ctx) => {
				if (shown && position !== "bottom" && handle?.isFocused()) return blurPanel();
				focusPanel();
				showPanel(ctx);
			},
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

// ─── rendering helpers ────────────────────────────────────────────────────────

/** Body row drawn as a full-width ├───┤ divider. */
const DIVIDER = "\u0000divider";

/** Rounded box. `thumb` marks body rows whose right border is drawn as a scrollbar thumb. */
function frame(
	theme: Theme,
	width: number,
	title: string,
	body: string[],
	footer: string,
	active: boolean,
	thumb?: { from: number; len: number },
): string[] {
	const inner = Math.max(4, width - 2);
	const c = (s: string) => theme.fg(active ? "accent" : "border", s);
	const edge = (left: string, label: string, right: string) => {
		const text = label ? truncateToWidth(` ${label} `, inner - 1, "…") : "";
		return c(left + "─") + text + c("─".repeat(Math.max(0, inner - 1 - visibleWidth(text))) + right);
	};
	const right = (i: number) =>
		thumb && i >= thumb.from && i < thumb.from + thumb.len ? theme.fg("accent", "┃") : c("│");
	return [
		edge("╭", title, "╮"),
		...body.map((l, i) =>
			l === DIVIDER ? c(`├${"─".repeat(inner)}┤`) : c("│") + truncateToWidth(l, inner, "…", true) + right(i),
		),
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

function summaryLine(theme: Theme, s: RepoState): string {
	if (s.error) return theme.fg("muted", s.error);
	const n = s.files.length;
	if (!n) return `${theme.fg("success", "✓")} ${theme.fg("muted", "working tree clean")}`;
	const add = s.files.reduce((a, f) => a + (f.added ?? 0), 0);
	const del = s.files.reduce((a, f) => a + (f.removed ?? 0), 0);
	return `${theme.fg("muted", `${n} file${n === 1 ? "" : "s"}`)}  ${theme.fg("success", `+${add}`)} ${theme.fg("error", `-${del}`)}`;
}

// ─── changes panel (bottom or side) ─────────────────────────────────────────

/** Fixed-height, scrollable file list. Bottom: `CONFIG.rows` rows above the editor. Side: full height. */
class DiffPanel implements Component, Focusable {
	focused = false;
	private selected = 0;
	private top = 0;
	private listRow = 0;
	private listH = 1;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private getState: () => RepoState,
		private layout: "bottom" | "side",
		private onOpen: (index: number) => void,
		private onBlur: () => void,
		private onRefresh: () => void,
	) {}

	private clampTop(n: number): void {
		this.top = Math.max(0, Math.min(this.top, n - this.listH));
	}

	handleInput(data: string): void {
		const n = this.getState().files.length;
		const page = Math.max(1, this.listH - 1);
		const move = (to: number) => {
			this.selected = Math.max(0, Math.min(n - 1, to));
			if (this.selected < this.top) this.top = this.selected;
			else if (this.selected >= this.top + this.listH) this.top = this.selected - this.listH + 1;
		};
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || CONFIG.keys.some((k) => matchesKey(data, k)))
			this.onBlur();
		else if (matchesKey(data, "up") || data === "k") move(this.selected - 1);
		else if (matchesKey(data, "down") || data === "j") move(this.selected + 1);
		else if (matchesKey(data, "pageUp")) move(this.selected - page);
		else if (matchesKey(data, "pageDown")) move(this.selected + page);
		else if (matchesKey(data, "home") || data === "g") move(0);
		else if (matchesKey(data, "end") || data === "G") move(n - 1);
		else if (matchesKey(data, "enter") && n) this.onOpen(this.selected);
		else if (data === "r") this.onRefresh();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const th = this.theme;
		const s = this.getState();
		const bottom = this.layout === "bottom";
		if (bottom && s.error) return []; // stay out of the way outside git repos
		const inner = width - 2;
		const n = s.files.length;
		const header = bottom
			? [` ${branchLine(th, s)}   ${summaryLine(th, s)}`, DIVIDER]
			: [` ${branchLine(th, s)}`, ` ${summaryLine(th, s)}`, DIVIDER];
		const bodyH = bottom ? header.length + CONFIG.rows : Math.max(6, this.tui.terminal.rows - BOTTOM_RESERVE) - 2;
		this.selected = Math.max(0, Math.min(this.selected, n - 1));

		const body: string[] = [...header];
		this.listRow = 1 + body.length;
		this.listH = Math.max(1, bodyH - body.length);
		this.clampTop(n);
		for (let idx = this.top; idx < Math.min(n, this.top + this.listH); idx++) {
			const f = s.files[idx]!;
			const stats =
				f.added !== undefined ? `${th.fg("success", `+${f.added}`)} ${th.fg("error", `-${f.removed}`)} ` : "";
			const avail = inner - 4 - visibleWidth(stats) - 1;
			const path = f.path.length > avail ? `…${f.path.slice(-(avail - 1))}` : f.path;
			const sel = this.focused && idx === this.selected;
			const left = `${sel ? th.fg("accent", "▶") : " "} ${th.fg(statusColor(f.code), f.code)} ${sel ? th.bold(path) : path}`;
			const line = left + " ".repeat(Math.max(1, inner - visibleWidth(left) - visibleWidth(stats))) + stats;
			body.push(sel ? th.bg("selectedBg", truncateToWidth(line, inner, "…", true)) : line);
		}
		while (body.length < bodyH) body.push("");

		let thumb: { from: number; len: number } | undefined;
		let range = "";
		if (n > this.listH) {
			const len = Math.max(1, Math.round((this.listH * this.listH) / n));
			const from = Math.round((this.top / (n - this.listH)) * (this.listH - len));
			thumb = { from: this.listRow - 1 + from, len };
			range = ` · ${this.top + 1}–${Math.min(n, this.top + this.listH)} of ${n}`;
		}
		const title = th.bold("Changes");
		const hint = this.focused
			? "↑↓ select · ⏎ diff · r refresh · esc back"
			: `${KEY_LABEL} focus · click to open${bottom ? " · /diff-panel off" : ""}`;
		return frame(th, width, title, body, th.fg("muted", hint + range), this.focused, thumb);
	}

	/** Wheel scrolls the list; a click on a file opens its diff. */
	handleMouse(e: TuiMouseEvent): TuiMouseEventResult | undefined {
		const n = this.getState().files.length;
		if (e.type === "wheel") {
			this.top += Math.sign(e.wheelDelta ?? 0);
			this.clampTop(n);
			return { handled: true, render: true };
		}
		if (e.type === "press") return { handled: true };
		if (e.type !== "click" || e.button !== "left") return undefined;
		const row = e.y - this.listRow;
		if (row < 0 || row >= this.listH || this.top + row >= n) return { handled: true };
		this.selected = this.top + row;
		this.onOpen(this.selected);
		return { handled: true, render: true };
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
