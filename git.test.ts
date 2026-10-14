import { expect, test } from "bun:test";
import { parseNumstat, parseStatusV2, parseUnified } from "./git.ts";

test("parseStatusV2", () => {
	const out = [
		"# branch.oid abcdef1234567",
		"# branch.head main",
		"# branch.upstream origin/main",
		"# branch.ab +2 -1",
		"1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
		"1 A. N... 000000 100644 100644 000 bbb new.ts",
		"2 R. N... 100644 100644 100644 aaa bbb R100 lib/new.ts",
		"lib/old.ts",
		"u UU N... 100644 100644 100644 100644 a b c conflict.ts",
		"? untracked.txt",
		"",
	].join("\0");
	const s = parseStatusV2(out);
	expect(s).toMatchObject({ branch: "main", ahead: 2, behind: 1 });
	expect(s.files.map((f) => `${f.code}:${f.path}`)).toEqual([
		"M:src/a b.ts",
		"A:new.ts",
		"R:lib/new.ts",
		"U:conflict.ts",
		"?:untracked.txt",
	]);
	expect(parseStatusV2("# branch.oid 1234567890\0# branch.head (detached)\0").branch).toBe("detached@1234567");
});

test("parseNumstat", () => {
	const m = parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg.png\n0\t0\tsrc/{old.ts => new.ts}\n1\t1\tx.ts => y.ts\n");
	expect(m.get("src/a.ts")).toEqual([3, 1]);
	expect(m.get("img.png")).toEqual([0, 0]);
	expect(m.has("src/new.ts")).toBe(true);
	expect(m.has("y.ts")).toBe(true);
});

test("parseUnified", () => {
	const diff = [
		"diff --git a/f.ts b/f.ts",
		"index 1..2 100644",
		"--- a/f.ts",
		"+++ b/f.ts",
		"@@ -10,3 +10,3 @@ fn",
		" keep",
		"-old",
		"+new",
		" keep2",
		"\\ No newline at end of file",
		"",
	].join("\n");
	const rows = parseUnified(diff);
	expect(rows.map((r) => [r.kind, r.oldNo, r.newNo])).toEqual([
		["hunk", undefined, undefined],
		["ctx", 10, 10],
		["del", 11, undefined],
		["add", undefined, 11],
		["ctx", 12, 12],
		["meta", undefined, undefined],
	]);
});
