// Pure git output parsers (no pi imports, so they are unit-testable).

export interface FileEntry {
	path: string;
	/** One-letter status: M A D R C U ? */
	code: string;
	untracked: boolean;
	added?: number;
	removed?: number;
}

export interface RepoState {
	branch: string;
	ahead: number;
	behind: number;
	files: FileEntry[];
	error?: string;
}

/** Parse `git status --porcelain=v2 --branch -z`. */
export function parseStatusV2(out: string): Omit<RepoState, "error"> {
	const state: Omit<RepoState, "error"> = { branch: "", ahead: 0, behind: 0, files: [] };
	let oid = "";
	const parts = out.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const e = parts[i]!;
		if (!e) continue;
		if (e.startsWith("# branch.head ")) state.branch = e.slice(14);
		else if (e.startsWith("# branch.oid ")) oid = e.slice(13);
		else if (e.startsWith("# branch.ab ")) {
			const m = /\+(\d+) -(\d+)/.exec(e);
			if (m) [state.ahead, state.behind] = [Number(m[1]), Number(m[2])];
		} else if (e.startsWith("? ")) state.files.push({ path: e.slice(2), code: "?", untracked: true });
		else if (/^[12u] /.test(e)) {
			const f = e.split(" ");
			const xy = f[1]!;
			const skip = e[0] === "1" ? 8 : e[0] === "2" ? 9 : 10;
			if (e[0] === "2") i++; // rename/copy: next NUL entry is the original path
			const code = e[0] === "u" ? "U" : xy[0] !== "." ? xy[0]! : xy[1]!;
			state.files.push({ path: f.slice(skip).join(" "), code, untracked: false });
		}
	}
	if (state.branch === "(detached)") state.branch = `detached@${oid.slice(0, 7)}`;
	return state;
}

/** Parse `git diff --numstat` into path -> [added, removed]. Binary files count as 0. */
export function parseNumstat(out: string): Map<string, [number, number]> {
	const map = new Map<string, [number, number]>();
	for (const line of out.split("\n")) {
		const [a, d, ...rest] = line.split("\t");
		if (!rest.length) continue;
		// Renames look like `src/{a.ts => b.ts}` or `a.ts => b.ts`; keep the new path.
		const path = rest
			.join("\t")
			.replace(/\{[^}]* => ([^}]*)\}/, "$1")
			.replace(/^.* => /, "")
			.replace("//", "/");
		map.set(path, [Number(a) || 0, Number(d) || 0]);
	}
	return map;
}

export interface DiffRow {
	kind: "hunk" | "add" | "del" | "ctx" | "meta";
	text: string;
	oldNo?: number;
	newNo?: number;
}

/** Parse a single-file unified diff into display rows with line numbers. */
export function parseUnified(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let o = 0;
	let n = 0;
	let inHunk = false;
	for (const line of diff.split("\n")) {
		const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (m) {
			o = Number(m[1]);
			n = Number(m[2]);
			inHunk = true;
			rows.push({ kind: "hunk", text: line });
		} else if (!inHunk) {
			if (/^(new file|deleted file|rename |old mode|new mode|Binary )/.test(line)) rows.push({ kind: "meta", text: line });
		} else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), newNo: n++ });
		else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), oldNo: o++ });
		else if (line.startsWith(" ")) rows.push({ kind: "ctx", text: line.slice(1), oldNo: o++, newNo: n++ });
		else if (line.startsWith("\\")) rows.push({ kind: "meta", text: line });
	}
	return rows;
}
