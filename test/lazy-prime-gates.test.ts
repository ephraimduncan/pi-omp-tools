import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import lazyPrimeGates from "../packages/lazy-prime-gates/index.ts";
import type {
	GateContext,
	GateEventName,
	GateHandler,
	GateHookResult,
	GateHost,
} from "../packages/lazy-prime-gates/src/host.ts";

class RecordingHost implements GateHost {
	readonly handlers = new Map<GateEventName, GateHandler[]>();
	readonly notifications: string[] = [];
	readonly context: GateContext = {
		hasUI: true,
		ui: { notify: message => this.notifications.push(message) },
	};

	on(event: GateEventName, handler: GateHandler): void {
		this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
	}

	async emit(event: GateEventName, value: unknown): Promise<GateHookResult | void> {
		let result: GateHookResult | void = undefined;
		for (const handler of this.handlers.get(event) ?? []) result = await handler(value, this.context);
		return result;
	}
}

function setup(): RecordingHost {
	const host = new RecordingHost();
	lazyPrimeGates(host);
	return host;
}

function blocked(result: GateHookResult | void): string {
	assert.ok(result, "the observable tool call must return a block");
	assert.equal(result.block, true, "the observable tool call must be blocked");
	if (typeof result.reason !== "string") assert.fail("the observable block must include a reason");
	return result.reason;
}

function output(result: GateHookResult | void): string {
	if (!result) return "";
	return (result.content ?? [])
		.map(part => typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "")
		.join("\n");
}

async function toolCall(
	host: RecordingHost,
	toolName: string,
	input: Record<string, unknown>,
	toolCallId: string,
): Promise<GateHookResult | void> {
	return host.emit("tool_call", { type: "tool_call", toolName, toolCallId, input });
}

async function toolResult(
	host: RecordingHost,
	toolName: string,
	input: Record<string, unknown>,
	toolCallId: string,
	isError = false,
): Promise<GateHookResult | void> {
	return host.emit("tool_result", {
		type: "tool_result",
		toolName,
		toolCallId,
		input,
		content: [{ type: "text", text: "tool completed" }],
		isError,
	});
}

async function nextTurn(host: RecordingHost): Promise<void> {
	await host.emit("turn_start" as GateEventName, { type: "turn_start" });
}

async function commitReview(
	host: RecordingHost,
	path: string,
	sequence: string,
): Promise<void> {
	const input = { path, content: "export const value = 1;" };
	blocked(await toolCall(host, "write", input, `${sequence}-blocked`));
	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, `${sequence}-allowed`), undefined);
	assert.match(output(await toolResult(host, "write", input, `${sequence}-allowed`)), /allowed after combined review/);
}

test("registration: duplicate handlers cannot apply one gate more than once", () => {
	const host = setup();
	assert.deepEqual([...host.handlers.keys()].sort(), [
		"agent_start",
		"session_before_switch",
		"session_branch",
		"session_compact",
		"session_start",
		"session_switch",
		"session_tree",
		"tool_call",
		"tool_result",
		"turn_start",
	]);
	for (const handlers of host.handlers.values()) assert.equal(handlers.length, 1);
});

test("hard policy: AI co-author text cannot reach a Git commit", async () => {
	const host = setup();
	const input = {
		command: "git commit -m $'feat: ship change\\n\\nCo-Authored-By: Claude <noreply@anthropic.com>'",
	};
	const reason = blocked(await toolCall(host, "bash", input, "ai-credit"));
	assert.match(reason, /credits an AI agent or bot/);
	assert.match(reason, /Co-Authored-By: Claude/);
});

test("hard policy: file-based commit messages cannot hide AI attribution", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lazy-prime-gates-attribution-"));
	const message = path.join(dir, "commit message.txt");
	try {
		await fs.writeFile(message, "feat: ship change\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n", "utf8");
		const reason = blocked(await toolCall(
			setup(),
			"bash",
			{ command: `git commit --file ${JSON.stringify(message)}` },
			"file-ai-credit",
		));
		assert.match(reason, /Co-Authored-By: Claude/);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

test("hard policy: --no-verify cannot bypass hooks through bash or IPython", async () => {
	const bashHost = setup();
	const bashReason = blocked(await toolCall(
		bashHost,
		"bash",
		{ command: "git commit --no-verify -m 'fix: hooks'" },
		"bash-no-verify",
	));
	assert.match(bashReason, /--no-verify is not permitted/);

	const ipythonHost = setup();
	const ipythonReason = blocked(await toolCall(
		ipythonHost,
		"ipython",
		{ code: "%%bash\ngit push --no-verify origin HEAD" },
		"ipython-no-verify",
	));
	assert.match(ipythonReason, /--no-verify is not permitted/);
});

test("hard policy: short flags and all IPython shell forms cannot bypass hooks", async () => {
	const cases: Array<{ toolName: string; input: Record<string, unknown> }> = [
		{ toolName: "bash", input: { command: "git commit -n -m 'fix: hooks'" } },
		{ toolName: "ipython", input: { code: "out = !git push --no-verify origin HEAD" } },
		{ toolName: "ipython", input: { code: "%sx git commit --no-verify -m blocked" } },
		{ toolName: "ipython", input: { code: "get_ipython().system('git push --no-verify origin HEAD')" } },
	];
	for (const [index, item] of cases.entries()) {
		const reason = blocked(await toolCall(setup(), item.toolName, item.input, `hook-bypass-${index}`));
		assert.match(reason, /not permitted/);
	}
});

test("Git handling: every shell surface receives a noninteractive editor environment", async () => {
	const bashHost = setup();
	const bashInput = { command: "git status --short" };
	assert.equal(await toolCall(bashHost, "bash", bashInput, "bash-editor"), undefined);
	assert.match(bashInput.command, /^export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n/);

	for (const magic of ["%%bash", "%%sh"]) {
		const host = setup();
		const input = { code: `${magic}\ngit status --short` };
		assert.equal(await toolCall(host, "ipython", input, `magic-${magic}`), undefined);
		assert.match(input.code, new RegExp(`^${magic}\\nexport GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\\n`));
	}

	const escapeHost = setup();
	const escapeInput = { code: "value = 1\n!cd repo && git status --short\nvalue += 1" };
	assert.equal(await toolCall(escapeHost, "ipython", escapeInput, "escape-editor"), undefined);
	assert.equal(
		escapeInput.code,
		"value = 1\n!export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no; cd repo && git status --short\nvalue += 1",
	);
});

test("Git handling: only an effective editor environment suppresses injection", async () => {
	const inert = {
		command: "echo GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no; git status --short",
	};
	assert.equal(await toolCall(setup(), "bash", inert, "inert-editor-env"), undefined);
	assert.match(inert.command, /^export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no\n/);

	const assignment = { code: "out = !git status --short" };
	assert.equal(await toolCall(setup(), "ipython", assignment, "assignment-editor"), undefined);
	assert.equal(assignment.code, "out = !export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no; git status --short");

	const lineMagic = { code: "%sx git status --short" };
	assert.equal(await toolCall(setup(), "ipython", lineMagic, "line-magic-editor"), undefined);
	assert.equal(lineMagic.code, "%sx export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no; git status --short");

	const systemCall = { code: "get_ipython().system('git status --short')" };
	assert.equal(await toolCall(setup(), "ipython", systemCall, "system-call-editor"), undefined);
	assert.equal(systemCall.code, "get_ipython().system('export GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no; git status --short')");
});

test("combined code review: overlapping policies cause one pause and one result note", async () => {
	const host = setup();
	const input = {
		path: "test/widget.test.tsx",
		content: "test('shows the break', () => {});\nuseEffect(() => subscribe(), []);",
	};
	const reason = blocked(await toolCall(host, "write", input, "combined-block"));
	assert.match(reason, /===== GUIDE: Simplify =====/);
	assert.match(reason, /===== GUIDE: Writing Better Tests =====/);
	assert.match(reason, /===== GUIDE: No Direct useEffect =====/);

	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "combined-reissue"), undefined);
	const result = output(await toolResult(host, "write", input, "combined-reissue"));
	assert.equal((result.match(/\[lazy-prime-gates\]/g) ?? []).length, 1);
	assert.match(result, /code in test\/widget\.test\.tsx/);
	assert.match(result, /tests in test\/widget\.test\.tsx/);
	assert.match(result, /direct useEffect in test\/widget\.test\.tsx/);
	assert.equal(await toolCall(host, "write", input, "combined-after-review"), undefined);
});

test("review window: sibling calls cannot consume a review before the next model turn", async () => {
	const host = setup();
	const input = { path: "src/parallel.ts", content: "export const parallel = true;" };
	blocked(await toolCall(host, "write", input, "parallel-first"));
	blocked(await toolCall(host, "write", input, "parallel-sibling"));
	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "parallel-reissue"), undefined);
	assert.match(output(await toolResult(host, "write", input, "parallel-reissue")), /allowed after combined review/);
});

test("review result: failed or mismatched results cannot commit an open review", async () => {
	const host = setup();
	const input = { path: "src/result-match.ts", content: "export const resultMatch = true;" };
	blocked(await toolCall(host, "write", input, "result-block"));

	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "result-error"), undefined);
	assert.equal(await toolResult(host, "write", input, "result-error", true), undefined);

	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "result-mismatch"), undefined);
	assert.equal(await toolResult(host, "write", { path: "notes.txt", content: "text" }, "result-mismatch"), undefined);

	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "result-success"), undefined);
	assert.match(output(await toolResult(host, "write", input, "result-success")), /allowed after combined review/);
});

test("review window: a new agent turn cannot reuse an abandoned reissue", async () => {
	const host = setup();
	const input = { path: "src/abandoned.ts", content: "export const abandoned = true;" };
	blocked(await toolCall(host, "write", input, "abandoned-first"));
	await host.emit("agent_start", { type: "agent_start" });
	const reason = blocked(await toolCall(host, "write", input, "abandoned-second"));
	assert.match(reason, /code in src\/abandoned\.ts/);
});

test("lifecycle reset: compaction, navigation, branch, switch, and fork require review again", async () => {
	const host = setup();
	const path = "src/lifecycle.ts";
	const input = { path, content: "export const lifecycle = true;" };
	await commitReview(host, path, "initial");
	assert.equal(await toolCall(host, "write", input, "before-compact"), undefined);

	await host.emit("session_compact", { type: "session_compact" });
	blocked(await toolCall(host, "write", input, "after-compact"));
	await nextTurn(host);
	assert.equal(await toolCall(host, "write", input, "compact-reissue"), undefined);
	await toolResult(host, "write", input, "compact-reissue");

	for (const [event, sequence] of [
		["session_tree", "tree"],
		["session_branch", "branch"],
		["session_switch", "switch"],
		["session_before_switch", "before-switch"],
	] as const) {
		await host.emit(event as GateEventName, { type: event });
		blocked(await toolCall(host, "write", input, `after-${sequence}`));
		await nextTurn(host);
		assert.equal(await toolCall(host, "write", input, `${sequence}-reissue`), undefined);
		await toolResult(host, "write", input, `${sequence}-reissue`);
	}

	await host.emit("session_start", { type: "session_start", reason: "fork" });
	blocked(await toolCall(host, "write", input, "after-fork"));
});

test("PR fill policy: neither gh nor github can derive a PR body from commits", async () => {
	const bashHost = setup();
	const bashReason = blocked(await toolCall(
		bashHost,
		"bash",
		{ command: "gh pr create --fill" },
		"gh-fill",
	));
	assert.match(bashReason, /fill-derived PR body is not permitted/);

	const githubHost = setup();
	const githubReason = blocked(await toolCall(
		githubHost,
		"github",
		{ op: "pr_create", title: "Change", fill: true },
		"github-fill",
	));
	assert.match(githubReason, /fill-derived PR body is not permitted/);
});

test("STE review: commits, tags, issues, releases, and docs cannot skip the writing standard", async () => {
	const cases: Array<{ toolName: string; input: Record<string, unknown>; label: RegExp }> = [
		{ toolName: "bash", input: { command: "git commit -mfeat" }, label: /git commit message/ },
		{ toolName: "bash", input: { command: "git commit --message 'feat: long message flag'" }, label: /git commit message/ },
		{ toolName: "bash", input: { command: "git tag --file release.txt v2.0.0" }, label: /git tag message/ },
		{ toolName: "bash", input: { command: "git tag -Frelease.txt v1.0.0" }, label: /git tag message/ },
		{ toolName: "bash", input: { command: "gh issue create --title 'Problem' --body 'Details'" }, label: /gh issue create/ },
		{ toolName: "bash", input: { command: "gh release create v1.0.0 --notes 'Details'" }, label: /gh release create/ },
		{ toolName: "write", input: { path: "docs/gates.md", content: "Gate details." }, label: /documentation in docs\/gates\.md/ },
	];
	for (const [index, surface] of cases.entries()) {
		const reason = blocked(await toolCall(setup(), surface.toolName, surface.input, `ste-${index}`));
		assert.match(reason, surface.label);
		assert.match(reason, /===== GUIDE: STE-100 Writing Standard =====/);
		assert.match(reason, /lazy-prime-gates\/guides\/ste100-wordlist\.md/);
	}
});

test("PR review: shell and github prose receive the PR and STE guides on every call", async () => {
	const shellHost = setup();
	const shellInput = { command: "gh pr comment 42 --body 'Decision details'" };
	let reason = blocked(await toolCall(shellHost, "bash", shellInput, "pr-comment-first"));
	assert.match(reason, /===== GUIDE: PR Description Writing =====/);
	assert.match(reason, /===== GUIDE: STE-100 Writing Standard =====/);
	assert.match(reason, /skill:\/\/humanizer/);
	await nextTurn(shellHost);
	assert.equal(await toolCall(shellHost, "bash", shellInput, "pr-comment-reissue"), undefined);
	assert.match(output(await toolResult(shellHost, "bash", shellInput, "pr-comment-reissue")), /allowed after combined review/);
	reason = blocked(await toolCall(shellHost, "bash", shellInput, "pr-comment-next"));
	assert.match(reason, /gh pr comment/);

	const githubReason = blocked(await toolCall(
		setup(),
		"github",
		{ op: "pr_create", title: "fix: gate", body: "Details", fill: false },
		"github-pr",
	));
	assert.match(githubReason, /github pr_create/);
	assert.match(githubReason, /PR Description Writing/);
	assert.match(githubReason, /skill:\/\/humanizer/);
});

test("hashline edit parsing: added code stays with its file and move destinations are reviewed", async () => {
	const host = setup();
	const input = {
		input: [
			"[src/plain.ts#AAAA]",
			"PUT 1.=1:",
			"+export const plain = true;",
			"[test/effect.test.tsx#BBBB]",
			"PUT 1.=1:",
			"+useEffect(() => subscribe(), []);",
			"+test('catches the break', () => {});",
			"MV 'src/moved effect.test.tsx'",
		].join("\n"),
	};
	const reason = blocked(await toolCall(host, "edit", input, "hashline"));
	assert.match(reason, /direct useEffect in test\/effect\.test\.tsx/);
	assert.doesNotMatch(reason, /direct useEffect in src\/plain\.ts/);
	assert.match(reason, /direct useEffect in src\/moved effect\.test\.tsx/);
	assert.match(reason, /tests in src\/moved effect\.test\.tsx/);
});

test("hashline edit parsing: recovered tags use the real snapshot destination", async () => {
	const key = Symbol.for("lazy-prime.snapshots.v1");
	const globals = globalThis as Record<PropertyKey, unknown>;
	const previous = globals[key];
	globals[key] = {
		findByHash: (hash: string) => hash === "DDDD"
			? [{ path: "/repo/src/recovered.tsx", text: "export const oldValue = true;", hash, recordedAt: 0 }]
			: [],
	};
	try {
		const reason = blocked(await toolCall(setup(), "edit", {
			input: "[missing.txt#DDDD]\nPUT 1.=1:\n+useEffect(() => recover(), []);",
		}, "hashline-recovered"));
		assert.match(reason, /code in \/repo\/src\/recovered\.tsx/);
		assert.match(reason, /direct useEffect in \/repo\/src\/recovered\.tsx/);
	} finally {
		if (previous === undefined) delete globals[key];
		else globals[key] = previous;
	}
});

test("Prime edit parsing: edits newText triggers the policy for its one target path", async () => {
	const host = setup();
	const input = {
		path: "src/prime-component.tsx",
		edits: [
			{ oldText: "const value = 1;", newText: "const value = 2;" },
			{ oldText: "render();", newText: "useEffect(() => render(), []);" },
		],
	};
	const reason = blocked(await toolCall(host, "edit", input, "prime-edit"));
	assert.match(reason, /direct useEffect in src\/prime-component\.tsx/);
	assert.match(reason, /code in src\/prime-component\.tsx/);
});

test("Prime edit parsing: partial replacements cannot hide useEffect", async () => {
	const reason = blocked(await toolCall(setup(), "edit", {
		path: "src/partial-component.tsx",
		edits: [{ oldText: "useMemo", newText: "useEffect" }],
	}, "prime-partial-edit"));
	assert.match(reason, /direct useEffect in src\/partial-component\.tsx/);
});

test("ast_edit parsing: codemod output cannot hide a direct useEffect call", async () => {
	const host = setup();
	const preview = {
		paths: ["src/**/*"],
		ops: [{ pat: "$A", out: "useEffect(() => sync(), [])" }],
		apply: false,
	};
	assert.equal(await toolCall(host, "ast_edit", preview, "ast-preview"), undefined);
	const input = { ...preview, apply: true };
	const reason = blocked(await toolCall(host, "ast_edit", input, "ast-edit"));
	assert.match(reason, /code in src\/\*\*\/\*/);
	assert.match(reason, /direct useEffect in src\/\*\*\/\*/);
});
