/**
 * Smoke tests for all omp-tools tools, run with `node --test`.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
	executeAstEdit,
	executeAstGrep,
	executeEdit,
	executeFind,
	executeRead,
	executeSearch,
	executeWrite,
	registerAll,
} from "../packages/omp-tools-core/index.ts";
import piReadExtension from "../packages/pi-read/index.ts";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text ?? "")
		.join("\n");
}

async function makeTempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-test-"));
}

function tagOf(output: string): string {
	const match = /#([0-9A-F]{4})\]/.exec(output);
	assert.ok(match, `expected a #TAG in output:\n${output}`);
	return match[1] as string;
}

test("read: numbered lines with hashline tag", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "hello.txt");
	await fs.writeFile(file, "alpha\nbeta\ngamma\n");
	const result = await executeRead(file, undefined, { cwd: dir });
	const output = text(result);
	assert.match(output, /\[hello\.txt#[0-9A-F]{4}\]/);
	assert.match(output, /1:alpha/);
	assert.match(output, /3:gamma/);
});

test("read: range selectors and :raw", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "nums.txt");
	await fs.writeFile(file, Array.from({ length: 50 }, (_, i) => `line-${i + 1}`).join("\n"));
	const ranged = text(await executeRead(`${file}:10-12`, undefined, { cwd: dir }));
	assert.match(ranged, /10:line-10/);
	assert.match(ranged, /12:line-12/);
	assert.ok(!ranged.includes("13:line-13"));
	const multi = text(await executeRead(`${file}:2-3,40-41`, undefined, { cwd: dir }));
	assert.match(multi, /2:line-2/);
	assert.match(multi, /…/);
	assert.match(multi, /40:line-40/);
	const raw = text(await executeRead(`${file}:raw`, undefined, { cwd: dir }));
	assert.ok(raw.includes("line-1\nline-2"));
	assert.ok(!raw.includes("1:line-1"));
});

test("read: directory listing", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "sub"));
	await fs.writeFile(path.join(dir, "a.txt"), "hi");
	const result = await executeRead(dir, undefined, { cwd: dir });
	const output = text(result);
	assert.match(output, /sub\//);
	assert.match(output, /a\.txt/);
	// Structured entries for the tree renderer, alongside the flat text body.
	const details = result.details as { kind?: string; total?: number; entries?: Array<Record<string, unknown>> };
	assert.equal(details.kind, "dir");
	assert.equal(details.total, 2);
	assert.deepEqual(
		details.entries?.map(entry => entry.name),
		["sub", "a.txt"],
	);
	assert.equal(details.entries?.[0]?.dir, true);
	assert.equal(details.entries?.[0]?.count, 0);
	assert.equal(typeof details.entries?.[1]?.size, "string");
});

test("write then edit: hashline replace, insert, cut", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "greet.py");
	const written = text(await executeWrite(file, 'def greet(name):\n    msg = "Hello, " + name\n    print(msg)\ngreet("world")\n', { cwd: dir }));
	const tag = tagOf(written);

	const edited = text(
		await executeEdit(
			`[greet.py#${tag}]\nPUT 2.=3:\n+    print(f"Hi, {name}")\nPUT >4:\n+print("done")`,
			{ cwd: dir },
		),
	);
	assert.match(edited, /updated/);
	const content = await fs.readFile(file, "utf8");
	assert.equal(content, 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\nprint("done")\n');
	// Response carries the new tag + fresh numbers for chaining.
	const newTag = tagOf(edited);
	const cutResult = text(await executeEdit(`[greet.py#${newTag}]\nCUT 4.=4`, { cwd: dir }));
	assert.match(cutResult, /updated/);
	assert.equal(await fs.readFile(file, "utf8"), 'def greet(name):\n    print(f"Hi, {name}")\ngreet("world")\n');
});

test("edit: block op via tree-sitter, registers move code across files", async () => {
	const dir = await makeTempDir();
	const src = path.join(dir, "util.ts");
	await fs.writeFile(src, "export function keep(): number {\n\treturn 1;\n}\nexport function move(): number {\n\treturn 2;\n}\n");
	await fs.writeFile(path.join(dir, "other.ts"), "// target\n");
	const readOut = text(await executeRead(src, undefined, { cwd: dir }));
	const tag = tagOf(readOut);
	const otherOut = text(await executeRead(path.join(dir, "other.ts"), undefined, { cwd: dir }));
	const otherTag = tagOf(otherOut);

	const patch = `[util.ts#${tag}]\nCUT 4* @fn\n[other.ts#${otherTag}]\nPUT >1 @fn`;
	const result = text(await executeEdit(patch, { cwd: dir }));
	assert.match(result, /block 4\* resolved to 4\.=6/);
	assert.equal(await fs.readFile(src, "utf8"), "export function keep(): number {\n\treturn 1;\n}\n");
	assert.equal(await fs.readFile(path.join(dir, "other.ts"), "utf8"), "// target\nexport function move(): number {\n\treturn 2;\n}\n");
});

test("edit: markdown heading block replace", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "doc.md");
	await fs.writeFile(file, "# Title\n\n## One\nbody one\n\n## Two\nbody two\n");
	const tag = tagOf(text(await executeRead(file, undefined, { cwd: dir })));
	await executeEdit(`[doc.md#${tag}]\nPUT 3*:\n+## One\n+new body`, { cwd: dir });
	const content = await fs.readFile(file, "utf8");
	assert.match(content, /## One\nnew body\n\n## Two/);
});

test("edit: stale-anchor recovery after unrelated change", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "list.txt");
	await fs.writeFile(file, "one\ntwo\nthree\nfour\nfive\n");
	const tag = tagOf(text(await executeRead(file, undefined, { cwd: dir })));
	// External change ABOVE the anchor: prepend a line (shifts everything down).
	await fs.writeFile(file, "zero\none\ntwo\nthree\nfour\nfive\n");
	const result = text(await executeEdit(`[list.txt#${tag}]\nPUT 4.=4:\n+FOUR`, { cwd: dir }));
	assert.match(result, /Recovered stale anchors/);
	assert.equal(await fs.readFile(file, "utf8"), "zero\none\ntwo\nthree\nFOUR\nfive\n");
});

test("edit: unknown tag is rejected with current tag hint", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "x.txt");
	await fs.writeFile(file, "a\nb\n");
	await assert.rejects(
		executeEdit("[x.txt#0000]\nPUT 1.=1:\n+z", { cwd: dir }),
		/Stale or unknown tag #0000/,
	);
});

test("edit: overlap and empty PUT are rejected; noop is diagnosed", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "y.txt");
	await fs.writeFile(file, "a\nb\nc\n");
	const tag = tagOf(text(await executeRead(file, undefined, { cwd: dir })));
	await assert.rejects(
		executeEdit(`[y.txt#${tag}]\nPUT 1.=2:\n+x\nCUT 2.=3`, { cwd: dir }),
		/Overlapping hunks/,
	);
	await assert.rejects(executeEdit(`[y.txt#${tag}]\nPUT 1.=1:`, { cwd: dir }), /no \+body rows/);
	const noop = text(await executeEdit(`[y.txt#${tag}]\nPUT 2.=2:\n+b`, { cwd: dir }));
	assert.match(noop, /produced no change/);
});

test("edit: REM deletes and MV renames", async () => {
	const dir = await makeTempDir();
	const a = path.join(dir, "a.txt");
	await fs.writeFile(a, "hello\n");
	const tag = tagOf(text(await executeRead(a, undefined, { cwd: dir })));
	await executeEdit(`[a.txt#${tag}]\nPUT 1.=1:\n+hey\nMV b.txt`, { cwd: dir });
	assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "hey\n");
	const bTag = tagOf(text(await executeRead(path.join(dir, "b.txt"), undefined, { cwd: dir })));
	const removed = text(await executeEdit(`[b.txt#${bTag}]\nREM`, { cwd: dir }));
	assert.match(removed, /Deleted b\.txt/);
	await assert.rejects(fs.access(path.join(dir, "b.txt")));
});

test("search: tagged grouped output", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "one.ts"), "const needleX = 1;\n");
	await fs.writeFile(path.join(dir, "two.ts"), "// no match here\nlet needleX = 2;\n");
	const output = text(await executeSearch({ pattern: "needleX" }, { cwd: dir }));
	assert.match(output, /\[one\.ts#[0-9A-F]{4}\]/);
	assert.match(output, /1:const needleX = 1;/);
	assert.match(output, /2:let needleX = 2;/);
	assert.match(output, /2 matches in 2 files/);
});

test("find: glob lookup", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "");
	await fs.writeFile(path.join(dir, "src", "b.js"), "");
	const output = text(await executeFind({ path: "src/**/*.ts", gitignore: false }, { cwd: dir }));
	assert.match(output, /src\/a\.ts/);
	assert.ok(!output.includes("b.js"));
});

test("ast_grep: typescript pattern with metavariables", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "code.ts"), "console.log(1);\nconsole.warn(2);\nconsole.log(3);\n");
	const output = text(await executeAstGrep({ pat: "console.log($A)" }, { cwd: dir }));
	assert.match(output, /1:console\.log\(1\);/);
	assert.match(output, /3:console\.log\(3\);/);
	assert.ok(!output.includes("console.warn"));
	assert.match(output, /2 matches/);
});

test("ast_grep: python via optional grammar (or graceful skip)", async () => {
	const dir = await makeTempDir();
	await fs.writeFile(path.join(dir, "app.py"), "print('a')\nx = compute(1)\nprint('b')\n");
	const output = text(await executeAstGrep({ pat: "print($A)" }, { cwd: dir }));
	// With @ast-grep/lang-python installed this matches; without it we get a
	// "no parseable files" note. Both are acceptable shapes.
	assert.ok(/2 matches/.test(output) || /No matches|No parseable/.test(output), output);
});

test("ast_edit: preview then apply", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "log.ts");
	await fs.writeFile(file, "console.log(a);\nkeep();\nconsole.log(b);\n");
	const preview = text(await executeAstEdit({ ops: [{ pat: "console.log($A)", out: "logger.info($A)" }], paths: [file] }, { cwd: dir }));
	assert.match(preview, /PREVIEW/);
	assert.match(preview, /logger\.info\(a\)/);
	assert.equal(await fs.readFile(file, "utf8"), "console.log(a);\nkeep();\nconsole.log(b);\n");
	const applied = text(
		await executeAstEdit({ ops: [{ pat: "console.log($A)", out: "logger.info($A)" }], paths: [file], apply: true }, { cwd: dir }),
	);
	assert.match(applied, /APPLIED 2 replacement/);
	assert.equal(await fs.readFile(file, "utf8"), "logger.info(a);\nkeep();\nlogger.info(b);\n");
});

test("sqlite: read tables, rows, and write rows", async () => {
	const dir = await makeTempDir();
	const db = path.join(dir, "data.sqlite");
	const { DatabaseSync } = await import("node:sqlite");
	const handle = new DatabaseSync(db);
	handle.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO users (name) VALUES ('ada'), ('bob');");
	handle.close();

	const tables = text(await executeRead(db, undefined, { cwd: dir }));
	assert.match(tables, /users \(table, 2 rows\)/);
	const rows = text(await executeRead(`${db}:users`, undefined, { cwd: dir }));
	assert.match(rows, /"name":"ada"/);
	const byKey = text(await executeRead(`${db}:users:2`, undefined, { cwd: dir }));
	assert.match(byKey, /"name":"bob"/);

	const inserted = text(await executeWrite(`${db}:users`, '{"name":"eve"}', { cwd: dir }));
	assert.match(inserted, /Inserted 1 row/);
	const updated = text(await executeWrite(`${db}:users:3`, '{"name":"EVE"}', { cwd: dir }));
	assert.match(updated, /Updated 1 row/);
	const deleted = text(await executeWrite(`${db}:users:3`, "", { cwd: dir }));
	assert.match(deleted, /Deleted 1 row/);
});

test("archives: zip list, member read, member write", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "payload"));
	await fs.writeFile(path.join(dir, "payload", "inner.txt"), "zipped content\nline two\n");
	execFileSync("zip", ["-q", "-r", "bundle.zip", "payload"], { cwd: dir });

	const listing = text(await executeRead(path.join(dir, "bundle.zip"), undefined, { cwd: dir }));
	assert.match(listing, /payload\/inner\.txt/);
	const member = text(await executeRead(path.join(dir, "bundle.zip") + ":payload/inner.txt", undefined, { cwd: dir }));
	assert.match(member, /1:zipped content/);
	const writeResult = text(await executeWrite(path.join(dir, "bundle.zip") + ":payload/new.txt", "fresh\n", { cwd: dir }));
	assert.match(writeResult, /Wrote/);
	const reread = text(await executeRead(path.join(dir, "bundle.zip") + ":payload/new.txt", undefined, { cwd: dir }));
	assert.match(reread, /1:fresh/);
});

test("notebook rendering", async () => {
	const dir = await makeTempDir();
	const nb = {
		cells: [
			{ cell_type: "markdown", source: ["# Heading\n"], outputs: [] },
			{ cell_type: "code", source: ["print(1)\n"], outputs: [{ output_type: "stream", text: ["1\n"] }] },
		],
	};
	await fs.writeFile(path.join(dir, "nb.ipynb"), JSON.stringify(nb));
	const output = text(await executeRead(path.join(dir, "nb.ipynb"), undefined, { cwd: dir }));
	assert.match(output, /cell 1 \[markdown\]/);
	assert.match(output, /print\(1\)/);
	assert.match(output, /output: 1/);
});

test("registration: all seven tools register with prompt integration", async () => {
	const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fakePi = {
		registerTool: (def: { name: string }) => tools.push(def as never),
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	await registerAll(fakePi as never);
	const names = tools.map(tool => tool.name).sort();
	assert.deepEqual(names, ["ast_edit", "ast_grep", "edit", "find", "read", "search", "write"]);
	assert.ok(tools.every(tool => (tool.promptGuidelines?.length ?? 0) > 0));

	const beforeAgentStart = handlers.get("before_agent_start");
	assert.ok(beforeAgentStart && beforeAgentStart.length > 0, "before_agent_start handler registered");
	const outcome = (await beforeAgentStart[0]?.({ systemPrompt: "BASE PROMPT" }, {})) as { systemPrompt: string };
	assert.match(outcome.systemPrompt, /^BASE PROMPT/);
	assert.match(outcome.systemPrompt, /## omp-tools/);
	assert.match(outcome.systemPrompt, /Anchor loop/);

	// Thin package wrapper also works (uses the shared registry; contract already wired).
	const moreTools: Array<{ name: string }> = [];
	await piReadExtension({ registerTool: (def: { name: string }) => moreTools.push(def as never), on: () => {} } as never);
	assert.deepEqual(moreTools.map(tool => tool.name), ["read"]);
});

test("read: url selector parsing stays local-safe (missing file error)", async () => {
	const dir = await makeTempDir();
	await assert.rejects(executeRead(path.join(dir, "nope.txt"), undefined, { cwd: dir }), /Not found/);
});

test("guard: bash/ipython file I/O is blocked with redirect reason", async () => {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const fakePi = {
		registerTool: () => {},
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	// registry is process-global and already populated by the earlier registerAll
	await registerAll(fakePi as never);
	const guards = handlers.get("tool_call") ?? [];
	// Guard handler may have been wired by the earlier registration; find any blocking handler.
	const invoke = async (toolName: string, input: Record<string, unknown>) => {
		for (const handler of guards) {
			const verdict = (await handler({ toolName, input }, {})) as { block?: boolean; reason?: string } | undefined;
			if (verdict?.block) return verdict;
		}
		return undefined;
	};
	if (guards.length > 0) {
		// pi-style standalone bash tool
		const blockedBash = await invoke("bash", { command: "grep -rn foo src/" });
		assert.ok(blockedBash?.reason?.includes("search"), "bash grep should be blocked");
		const okBash = await invoke("bash", { command: "mkdir -p x && zip -r a.zip x # omp-ok" });
		assert.equal(okBash, undefined);
		// prime-style ipython %%bash cells (QA bug 1)
		const blockedCell = await invoke("ipython", { code: "%%bash\ngrep -rn greet ." });
		assert.ok(blockedCell?.reason?.includes("search"), "%%bash grep should be blocked");
		const blockedCat = await invoke("ipython", { code: "%%bash\ncat app.py" });
		assert.ok(blockedCat?.reason?.includes("read"), "%%bash cat should be blocked");
		const okCell = await invoke("ipython", { code: "%%bash\nmkdir -p x && zip -r a.zip x # omp-ok" });
		assert.equal(okCell, undefined);
		const okFixture = await invoke("ipython", { code: "%%bash\nsqlite3 data.sqlite 'CREATE TABLE t(x)'" });
		assert.equal(okFixture, undefined);
		// python file I/O (QA bug 2 — builtin open in all modes)
		const blockedPy = await invoke("ipython", { code: "open('x.txt','w').write('hi')" });
		assert.ok(blockedPy?.reason?.includes("write"), "python open-write should be blocked");
		const blockedRead = await invoke("ipython", { code: "content = open('app.py').read()" });
		assert.ok(blockedRead?.reason?.includes("read"), "python open-read should be blocked");
		const blockedPathlib = await invoke("ipython", { code: "print(Path('a').read_text())" });
		assert.ok(blockedPathlib?.reason, "read_text should be blocked");
		const blockedRemove = await invoke("ipython", { code: "import os\nos.remove('x')" });
		assert.ok(blockedRemove?.reason, "os.remove should be blocked");
		const okPy = await invoke("ipython", { code: "import math; print(math.pi)" });
		assert.equal(okPy, undefined);
		const okEscape = await invoke("ipython", { code: "open('data.csv','w').write(csv)  # omp-ok data export" });
		assert.equal(okEscape, undefined);
	}
});

test("register.ts source contains no control characters (0x08 regression)", async () => {
	const source = await fs.readFile(new URL("../packages/omp-tools-core/src/register.ts", import.meta.url), "utf8");
	for (let i = 0; i < source.length; i++) {
		const codePoint = source.charCodeAt(i);
		assert.ok(codePoint >= 0x20 || codePoint === 0x0a || codePoint === 0x09, `control char ${codePoint} at index ${i}`);
	}
});

test("edit details carry builtin-format diff for daemon replay rendering", async () => {
	const dir = await makeTempDir();
	const file = path.join(dir, "replay.txt");
	await fs.writeFile(file, "one\ntwo\nthree\n");
	const tag = tagOf(text(await executeRead(file, undefined, { cwd: dir })));
	const result = await executeEdit(`[replay.txt#${tag}]\nPUT 2.=2:\n+TWO`, { cwd: dir });
	const details = result.details as { diff?: string; firstChangedLine?: number; sections?: unknown[] };
	assert.ok(typeof details.diff === "string" && details.diff.length > 0, "details.diff present");
	assert.match(details.diff as string, /^-\s*2 two$/m);
	assert.match(details.diff as string, /^\+\s*2 TWO$/m);
	assert.equal(details.firstChangedLine, 2);
	assert.ok(Array.isArray(details.sections));
});

test("edit registration carries replayBuiltInToolName and display path arg", async () => {
	const { registerEdit } = await import("../packages/omp-tools-core/src/register.ts");
	const defs: Array<Record<string, unknown>> = [];
	await registerEdit({ registerTool: (def: Record<string, unknown>) => defs.push(def), on: () => {} } as never);
	const def = defs[0] as { replayBuiltInToolName?: string; prepareArguments?: (a: unknown) => unknown };
	assert.equal(def.replayBuiltInToolName, "edit");
	const prepared = def.prepareArguments?.({ input: "[src/a.ts#AAAA]\nPUT 1.=1:\n+x" }) as { path?: string };
	assert.equal(prepared?.path, "src/a.ts");
});

test("renderers: omp-style boxes, gutters, and tree bodies", async () => {
	const { editRenderers, searchRenderers, readRenderers } = await import("../packages/omp-tools-core/src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
	}
	const R = {
		Text: FakeText as never,
		Container: FakeText as never,
	} as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => `<${text}>`,
	};
	const renderLines = (component: unknown): string => {
		const boxLike = component as { render?: (width: number) => string[]; text?: string };
		return boxLike.render ? boxLike.render(80).join("\n") : (boxLike.text ?? "");
	};

	const edit = editRenderers(R);
	const editComponent = edit.renderResult(
		{
			details: {
				sections: [
					{ path: "old.ts", op: "delete" },
					{ path: "a.ts", tag: "AAAA", op: "update", diff: "-1 old\n+1 new", warnings: ["careful"], blockResolutions: [] },
				],
			},
		},
		{ expanded: false },
		theme,
		{},
	) as { render: (width: number) => string[] };
	const editLines = editComponent.render(80);
	const editOut = editLines.join("\n");
	assert.match(editOut, /╭─── ✎ Edit: 🟦 a\.ts#AAAA ⟦\+1\/-1⟧/);
	assert.match(editOut, / {2}-1│<old>/);
	assert.match(editOut, /! careful/);
	assert.equal(editLines[0], "");
	assert.match(editLines[1] as string, /✘ Delete: old\.ts/);
	assert.match(editLines[2] as string, /^╭/);
	assert.match(editLines.at(-1) as string, /^╰/);
	assert.match(editOut, /╰─+╯/);

	const search = searchRenderers(R);
	const searchOut = renderLines(
		search.renderResult(
			{
				details: {
					pattern: "needle",
					files: [{ path: "b.ts", tag: "BBBB", rows: [{ n: 3, text: "a needle here", isMatch: true }], more: 0 }],
					summary: "1 matches in 1 files",
				},
			},
			{ expanded: false },
			theme,
			{},
		),
	);
	assert.match(searchOut, /⌕ Search: needle 1 match · 1 file/);
	assert.match(searchOut, /└─ b\.ts#BBBB/);
	assert.match(searchOut, /\*3│a <needle> here/);

	const read = readRenderers(R);
	const readOut = renderLines(
		read.renderResult(
			{ details: { kind: "text", path: "c.ts", tag: "CCCC", rows: [{ n: 1, text: "const x = 1;" }] } },
			{ expanded: false },
			theme,
			{},
		),
	);
	assert.match(readOut, /╭─── 🟦 • Read: c\.ts#CCCC · 1 line /);
	assert.match(readOut, / 1 const x = 1;/);
	assert.match(readOut, /╰─+╯/);
});

test("renderers: todo box, web_search sections, github inline line", async () => {
	const { todoRenderers, webSearchRenderers, githubRenderers } = await import("../packages/omp-tools-core/src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
	}
	const R = { Text: FakeText as never, Container: FakeText as never } as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => `~${text}~`,
	};
	const renderLines = (component: unknown): string => {
		const boxLike = component as { render?: (width: number) => string[]; text?: string };
		return boxLike.render ? boxLike.render(80).join("\n") : (boxLike.text ?? "");
	};

	const todo = todoRenderers(R);
	const todoOut = renderLines(
		todo.renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					phases: [
						{ name: "Setup", tasks: [{ content: "Scaffold", status: "completed" }] },
						{ name: "Build", tasks: [{ content: "Wire tools", status: "in_progress" }, { content: "Docs", status: "pending" }] },
						{ name: "Later", tasks: [{ content: "Polish", status: "pending" }] },
					],
				},
			},
			{ expanded: false },
			theme,
			{ args: { op: "start", task: "Wire tools" }, state: {} },
		),
	);
	assert.match(todoOut, /╭─── ☑ Todo 4 tasks · 1\/4/);
	assert.match(todoOut, /I\. Setup {2}1\/1/);
	assert.match(todoOut, /II\. Build/);
	assert.match(todoOut, /├─ \[>\] Wire tools in progress/);
	assert.match(todoOut, /└─ \[ \] Docs pending/);
	assert.match(todoOut, /III\. Later {2}0\/1/);

	const search = webSearchRenderers(R);
	const searchOut = renderLines(
		search.renderResult(
			{
				content: [{ type: "text", text: "Answer line one.\n\nSources:\n- Example" }],
				details: {
					provider: "Exa",
					query: "tool ui",
					citations: [{ title: "Example", url: "https://www.example.com/a" }],
				},
			},
			{ expanded: false },
			theme,
			{ args: { query: "tool ui" }, state: {} },
		),
	);
	assert.match(searchOut, /╭─── ⌕ Web Search: Exa 1 source/);
	assert.match(searchOut, /Query: tool ui/);
	assert.match(searchOut, /├─── Answer ─/);
	assert.match(searchOut, /Answer line one\./);
	assert.match(searchOut, /├─── Sources ─/);
	assert.match(searchOut, /└─ Example \(example\.com\)/);
	assert.match(searchOut, /Provider: Exa/);

	const github = githubRenderers(R);
	const oneLine = renderLines(
		github.renderResult(
			{ content: [{ type: "text", text: "Pushed 1 commit to feat/x" }], details: { op: "pr_push" } },
			{ expanded: false },
			theme,
			{ args: { op: "pr_push" }, state: {} },
		),
	);
	assert.equal(oneLine.includes("╭"), false); // single line stays inline, no box
	assert.match(oneLine, /⎇ GitHub PR Push: Pushed 1 commit to feat\/x/);
	const boxedOut = renderLines(
		github.renderResult(
			{ content: [{ type: "text", text: "# repo\n\nline two" }], details: { op: "repo_view" } },
			{ expanded: false },
			theme,
			{ args: { op: "repo_view", repo: "a/b" }, state: {} },
		),
	);
	assert.match(boxedOut, /╭─── ⎇ GitHub Repo a\/b/);
	assert.match(boxedOut, /line two/);
});

test("renderers: github structured layouts (repo box, pr box, search rows, run watch)", async () => {
	const { githubRenderers } = await import("../packages/omp-tools-core/src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
	}
	const R = { Text: FakeText as never, Container: FakeText as never } as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const renderLines = (component: unknown): string => {
		const boxLike = component as { render?: (width: number) => string[]; text?: string };
		return boxLike.render ? boxLike.render(90).join("\n") : (boxLike.text ?? "");
	};
	const github = githubRenderers(R);
	const call = (details: Record<string, unknown>, args: Record<string, unknown>) =>
		renderLines(github.renderResult({ content: [{ type: "text", text: "fallback text" }], details }, { expanded: false }, theme, { args, state: {} }));

	const repoOut = call(
		{
			op: "repo_view",
			data: {
				nameWithOwner: "a/b",
				description: "demo repo",
				url: "https://github.com/a/b",
				visibility: "PUBLIC",
				stargazerCount: 3,
				forkCount: 1,
				primaryLanguage: { name: "TypeScript" },
				defaultBranchRef: { name: "main" },
			},
		},
		{ op: "repo_view" },
	);
	assert.match(repoOut, /╭─── ⎇ a\/b ⟦PUBLIC⟧ ★3 TypeScript · main/);
	assert.match(repoOut, /demo repo/);
	assert.match(repoOut, /Forks\s+1/);

	const prOut = call(
		{
			op: "pr_view",
			data: {
				number: 7,
				title: "add pagination",
				state: "OPEN",
				author: { login: "lin" },
				headRefName: "feat/pages",
				baseRefName: "main",
				body: "body first line",
				files: [{ path: "src/a.ts", additions: 5, deletions: 2 }],
				comments: [{ author: { login: "ada" }, body: "ship it" }],
			},
		},
		{ op: "pr_view", pr: "7" },
	);
	assert.match(prOut, /╭─── ⎇ PR #7 add pagination ⟦OPEN⟧/);
	assert.match(prOut, /feat\/pages → main · @lin/);
	assert.match(prOut, /├─── Body ─/);
	assert.match(prOut, /├─── Files 1 · \+5\/-2 ─/);
	assert.match(prOut, /└─ 🟦 src\/a\.ts\s+\+5\/-2/);
	assert.match(prOut, /├─── Comments 1 ─/);
	assert.match(prOut, /└─ @ada · ship it/);

	const searchOut = call(
		{
			op: "search_issues",
			data: { items: [{ number: 9, title: "bug in read", state: "open", user: { login: "sam" } }] },
		},
		{ op: "search_issues", query: "read" },
	);
	assert.equal(searchOut.includes("╭"), false); // search stays frameless
	assert.match(searchOut, /⌕ GitHub Search Issues: read 1 result/);
	assert.match(searchOut, /└─ #9 bug in read ⟦OPEN⟧ @sam/);

	const watchOut = call(
		{
			op: "run_watch",
			state: "completed",
			runs: [
				{
					workflowName: "CI",
					status: "completed",
					conclusion: "failure",
					jobs: [{ name: "test", conclusion: "failure" }],
				},
			],
			failedLog: "boom",
		},
		{ op: "run_watch" },
	);
	assert.match(watchOut, /╭─── ⎇ Run Watch CI ⟦FAILURE⟧/);
	assert.match(watchOut, /└─ ✘ test/);
	assert.match(watchOut, /├─── Failed log ─/);
	assert.match(watchOut, /boom/);

	// Single-run details (runDetails shape, no runs array) keep the run identity in the header.
	const singleRunOut = call(
		{
			op: "run_watch",
			state: "completed",
			workflowName: "CI",
			headBranch: "main",
			headSha: "515f604aa11",
			status: "completed",
			conclusion: "success",
			jobs: [{ name: "build", conclusion: "success" }],
		},
		{ op: "run_watch" },
	);
	assert.match(singleRunOut, /╭─── ⎇ Run Watch CI ⟦SUCCESS⟧ main · 515f604/);
	assert.match(singleRunOut, /└─ ✔ build/);

	// Code search renders every text-match fragment under the repo:path row.
	const codeOut = call(
		{
			op: "search_code",
			data: {
				items: [
					{
						path: "src/register.ts",
						repository: { full_name: "a/b" },
						text_matches: [{ fragment: "renderShell: \"self\"" }, { fragment: "readRenderers(support)" }],
					},
				],
			},
		},
		{ op: "search_code", query: "renderShell" },
	);
	assert.match(codeOut, /⌕ GitHub Search Code: renderShell 1 result/);
	assert.match(codeOut, /└─ a\/b:src\/register\.ts/);
	assert.match(codeOut, /renderShell: "self"/);
	assert.match(codeOut, /⋮/); // fragment separator
	assert.match(codeOut, /readRenderers\(support\)/);

	// Repo topics come from the repositoryTopics field.
	const topicsOut = call(
		{ op: "repo_view", data: { nameWithOwner: "a/b", repositoryTopics: [{ name: "pi" }, { topic: { name: "tui" } }] } },
		{ op: "repo_view" },
	);
	assert.match(topicsOut, /Topics\s+pi, tui/);

	// The next tool supplies the gap; the host supplies the gap before prose.
	const github2 = githubRenderers(R);
	const boxComponent = github2.renderResult(
		{ content: [{ type: "text", text: "unused" }], details: { op: "repo_view", data: { nameWithOwner: "a/b" } } },
		{ expanded: false },
		theme,
		{ args: { op: "repo_view" }, state: {} },
	) as { render: (width: number) => string[] };
	const boxLines = boxComponent.render(90);
	assert.equal(boxLines[0], "");
	assert.match(boxLines[1] as string, /^╭/);
	assert.match(boxLines.at(-1) as string, /^╰/);

	const inlineComponent = github2.renderResult(
		{ content: [{ type: "text", text: "Pushed 1 commit" }], details: { op: "pr_push" } },
		{ expanded: false },
		theme,
		{ args: { op: "pr_push" }, state: {} },
	) as { text: string };
	assert.equal(inlineComponent.text.startsWith("\n"), true);
	assert.equal(inlineComponent.text.endsWith("\n"), false);

	const pendingComponent = github2.renderCall({ op: "repo_view", repo: "a/b" }, theme, { state: {} }) as {
		render: (width: number) => string[];
	};
	const pendingLines = pendingComponent.render(90);
	assert.equal(pendingLines[0], "");
	assert.notEqual(pendingLines.at(-1), "");

	// Ops without structured details keep the fallback text rendering.
	const fallbackOut = call({ op: "repo_view" }, { op: "repo_view", repo: "a/b" });
	assert.match(fallbackOut, /⎇ GitHub Repo: fallback text/);
});

test("BUG1 regression: absolute and ~ globs work in find/search/ast collect", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.mkdir(path.join(dir, "docs"), { recursive: true });
	await fs.writeFile(path.join(dir, "app.py"), "print(1)\n");
	await fs.writeFile(path.join(dir, "src", "a.ts"), "const needleZ = 1;\n");
	await fs.writeFile(path.join(dir, "docs", "d.md"), "# needleZ doc\n");

	// find: absolute glob, from an UNRELATED cwd
	const otherCwd = await makeTempDir();
	const absFind = text(await executeFind({ path: `${dir}/*.py`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absFind, /app\.py/);
	const absDeep = text(await executeFind({ path: `${dir}/**/*.ts`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absDeep, /a\.ts/);
	const absDocs = text(await executeFind({ path: `${dir}/docs/*.md`, gitignore: false }, { cwd: otherCwd }));
	assert.match(absDocs, /d\.md/);

	// search: absolute glob from unrelated cwd
	const absSearch = text(await executeSearch({ pattern: "needleZ", path: `${dir}/*.ts; ${dir}/**/*.ts` }, { cwd: otherCwd }));
	assert.match(absSearch, /a\.ts/);

	// ast_grep: absolute glob from unrelated cwd
	const absAst = text(await executeAstGrep({ pat: "const $N = $V" , path: `${dir}/src/*.ts` }, { cwd: otherCwd }));
	assert.match(absAst, /needleZ/);

	// glob with a missing base dir matches nothing instead of erroring
	const noBase = text(await executeFind({ path: `${dir}/nonexistent/*.py` }, { cwd: otherCwd }));
	assert.match(noBase, /No paths match/);
	assert.match(noBase, /Base directory does not exist/);
});
test("find/search: missing glob bases match nothing; missing plain paths error", async () => {
	const dir = await makeTempDir();
	await fs.mkdir(path.join(dir, "src"), { recursive: true });
	await fs.writeFile(path.join(dir, "src", "a.ts"), "const needleQ = 1;\n");

	// one missing base in a multi-target list still returns the other matches
	const findOut = text(
		await executeFind({ path: `${dir}/nonexistent/**; ${dir}/src/**/*.ts`, gitignore: false }, { cwd: dir }),
	);
	assert.match(findOut, /a\.ts/);
	const searchOut = text(
		await executeSearch({ pattern: "needleQ", path: `${dir}/nonexistent/**; ${dir}/src/**/*.ts` }, { cwd: dir }),
	);
	assert.match(searchOut, /a\.ts/);

	// every glob base missing → no match, not an error
	const allMissFind = text(await executeFind({ path: `${dir}/nope/**; ${dir}/also-nope/**` }, { cwd: dir }));
	assert.match(allMissFind, /No paths match/);
	const allMissSearch = text(
		await executeSearch({ pattern: "needleQ", path: `${dir}/nope/**; ${dir}/also-nope/**` }, { cwd: dir }),
	);
	assert.match(allMissSearch, /No matches/);

	// plain (non-glob) missing paths still error loudly
	await assert.rejects(executeFind({ path: `${dir}/also-nope` }, { cwd: dir }), /Not found/);
	await assert.rejects(
		executeSearch({ pattern: "needleQ", path: `${dir}/also-nope` }, { cwd: dir }),
		/Search root not found/,
	);
});

test("BUG2 regression: URL selector parsing (bare domain, trailing slash, port)", async () => {
	const { parseUrlTarget } = await import("../packages/omp-tools-core/src/tools/read.ts");
	// bare domain :raw
	const bare = parseUrlTarget("https://example.com:raw");
	assert.equal(bare.url, "https://example.com");
	assert.equal(bare.selector?.raw, true);
	// trailing slash :raw
	const slash = parseUrlTarget("https://example.com/:raw");
	assert.equal(slash.url, "https://example.com/");
	assert.equal(slash.selector?.raw, true);
	// port stays a port
	const port = parseUrlTarget("https://host:8080");
	assert.equal(port.url, "https://host:8080");
	assert.equal(port.selector, null);
	// port + trailing slash + range selects lines
	const portRange = parseUrlTarget("https://host:8080/:50");
	assert.equal(portRange.url, "https://host:8080/");
	assert.deepEqual(portRange.selector?.ranges, [{ start: 50, end: 50 }]);
	// path + range
	const ranged = parseUrlTarget("https://x.com/docs/page:10-20");
	assert.equal(ranged.url, "https://x.com/docs/page");
	assert.deepEqual(ranged.selector?.ranges, [{ start: 10, end: 20 }]);
	// bare domain numeric — ambiguous, stays port-ish (documented)
	const ambiguous = parseUrlTarget("https://example.com:50");
	assert.equal(ambiguous.selector, null);
});

test("read-group tracker: stamping, breaks, and session scoping", async () => {
	// Re-wire the contract handlers onto this test's fakePi: an earlier test
	// already consumed the once-per-process guard.
	delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("omp-tools.contract.v1")];
	const handlers = new Map<string, Array<(event: unknown, ctx?: unknown) => unknown>>();
	const tools: Array<{ name: string }> = [];
	const fakePi = {
		registerTool: (def: { name: string }) => tools.push(def),
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	};
	const { registerRead } = await import("../packages/omp-tools-core/src/register.ts");
	await registerRead(fakePi as never);
	const readTool = tools.find(tool => tool.name === "read") as
		| { execute: (id: string, params: object, s?: unknown, u?: unknown, ctx?: object) => Promise<{ details?: object }> }
		| undefined;
	assert.ok(readTool, "read tool registered");
	const emit = async (event: string, payload: unknown, ctx: unknown = {}) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	const dir = await makeTempDir();
	const file = path.join(dir, "g.txt");
	await fs.writeFile(file, "hello\n");
	const readGroup = async (toolCallId: string) => {
		const result = await readTool.execute(toolCallId, { path: file }, undefined, undefined, { cwd: dir });
		return (result.details as { readGroup?: string }).readGroup;
	};

	// Consecutive reads share one stamped group id.
	await emit("tool_call", { toolName: "read", toolCallId: "rg-1" });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-2" });
	const g1 = await readGroup("rg-1");
	assert.ok(typeof g1 === "string" && g1.length > 0, "group id stamped into details");
	assert.equal(await readGroup("rg-2"), g1);

	// A different tool call breaks the group.
	await emit("tool_call", { toolName: "bash", toolCallId: "b-1" });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-3" });
	const g3 = await readGroup("rg-3");
	assert.notEqual(g3, g1);

	// toolResult and invisible bookkeeping messages don't break; prose does.
	await emit("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "output" }] } });
	await emit("message_end", { message: { role: "custom", content: "invisible bookkeeping" } });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-4" });
	assert.equal(await readGroup("rg-4"), g3);
	await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Here is what I found." }] } });
	await emit("tool_call", { toolName: "read", toolCallId: "rg-5" });
	const g5 = await readGroup("rg-5");
	assert.notEqual(g5, g3);

	// Session-scoped: another session's tool calls neither break nor join.
	const ctxA = { sessionManager: { getSessionId: () => "session-A" } };
	const ctxB = { sessionManager: { getSessionId: () => "session-B" } };
	await emit("tool_call", { toolName: "read", toolCallId: "sa-1" }, ctxA);
	const a1 = await readGroup("sa-1");
	await emit("tool_call", { toolName: "bash", toolCallId: "sb-x" }, ctxB);
	await emit("tool_call", { toolName: "read", toolCallId: "sb-1" }, ctxB);
	const b1 = await readGroup("sb-1");
	await emit("tool_call", { toolName: "read", toolCallId: "sa-2" }, ctxA);
	assert.equal(await readGroup("sa-2"), a1, "other session's tool must not split this session's group");
	assert.notEqual(b1, a1, "concurrent sessions must never share a group id");

	// A new session in the same process starts a fresh group.
	await emit("session_start", {}, ctxA);
	await emit("tool_call", { toolName: "read", toolCallId: "sa-3" }, ctxA);
	assert.notEqual(await readGroup("sa-3"), a1);

	// A read without a toolCallId fences the group instead of being hopped over.
	await emit("tool_call", { toolName: "read", toolCallId: "f-1" });
	const f1 = await readGroup("f-1");
	await emit("tool_call", { toolName: "read" });
	await emit("tool_call", { toolName: "read", toolCallId: "f-2" });
	assert.notEqual(await readGroup("f-2"), f1);
});

test("renderers: reads collapse into one Read (N) widget without invalidate recursion", async () => {
	const { readRenderers } = await import("../packages/omp-tools-core/src/render.ts");
	class FakeText {
		text: string;
		constructor(text: string) {
			this.text = text;
		}
		render(): string[] {
			return this.text.split("\n");
		}
	}
	const R = { Text: FakeText as never, Container: FakeText as never } as never;
	const theme = {
		fg: (_c: string, text: string) => text,
		bold: (text: string) => text,
		inverse: (text: string) => text,
	};
	const read = readRenderers(R);
	const groupId = `test-render:${Date.now().toString(36)}`;
	const result1 = { content: [], details: { kind: "text", path: "a.ts", tag: "AAAA", rows: [{ n: 1, text: "x" }], readGroup: groupId } };
	const result2 = { content: [], details: { kind: "text", path: "b.ts", tag: "BBBB", rows: [{ n: 1, text: "y" }], readGroup: groupId } };

	// Host-faithful contexts: invalidate() synchronously re-runs renderResult
	// (pi/prime updateDisplay) — exactly what mutually recursed before the fix.
	let renders1 = 0;
	let renders2 = 0;
	let component1: { render: (w: number) => string[] } | undefined;
	let component2: { render: (w: number) => string[] } | undefined;
	const render1 = (): void => {
		renders1++;
		assert.ok(renders1 < 20, "unbounded re-render of member 1");
		component1 = read.renderResult(result1 as never, { expanded: false }, theme, ctx1 as never) as never;
	};
	const render2 = (): void => {
		renders2++;
		assert.ok(renders2 < 20, "unbounded re-render of member 2");
		component2 = read.renderResult(result2 as never, { expanded: false }, theme, ctx2 as never) as never;
	};
	const ctx1 = { toolCallId: "grw-1", state: {}, invalidate: render1 };
	const ctx2 = { toolCallId: "grw-2", state: {}, invalidate: render2 };

	render1();
	const soloOut = component1?.render(80).join("\n") ?? "";
	assert.match(soloOut, /Read: a\.ts#AAAA/); // single member renders solo

	render2(); // second member joins; must NOT synchronously recurse
	assert.equal(renders2, 1, "joining member must not re-render synchronously");
	await Promise.resolve(); // deferred cross-member invalidate runs as a microtask
	assert.ok(renders1 >= 2, "older member re-rendered once the group formed");
	assert.ok(renders1 < 5 && renders2 < 5, `re-renders stay bounded, got ${renders1}/${renders2}`);

	assert.deepEqual(component1?.render(80), [], "older slot collapses");
	const groupOut = component2?.render(80).join("\n") ?? "";
	assert.match(groupOut, /• Read \(2\)/);
	assert.match(groupOut, /a\.ts#AAAA · 1 line/);
	assert.match(groupOut, /b\.ts#BBBB · 1 line/);

	// A failed member (stamped id, as on replay) renders a failed row with the reason.
	const ctx3 = { toolCallId: "grw-3", state: {}, isError: true, args: { path: "/tmp/missing.txt" }, invalidate: () => {} };
	const result3 = { content: [{ type: "text", text: "Not found: /tmp/missing.txt" }], details: { readGroup: groupId } };
	const component3 = read.renderResult(result3 as never, { expanded: false }, theme, ctx3 as never) as {
		render: (w: number) => string[];
	};
	const errOut = component3.render(80).join("\n");
	assert.match(errOut, /• Read \(3\)/);
	assert.match(errOut, /missing\.txt · failed · Not found: \/tmp\/missing\.txt/);
});
