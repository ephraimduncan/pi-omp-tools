/**
 * Shared tool registry + system-prompt contract, split out of register.ts so
 * every tool module (including self-registering ones under src/tools/) can
 * participate without touching a shared file:
 *
 *  - `registeredTools` — process-global set of omp tool names registered so
 *    far (anchored on globalThis, shared across separately-installed packages).
 *  - `ensurePromptContract(pi)` — wires the before_agent_start /
 *    session_start / tool_call handlers exactly once per process.
 */
import { type PiApi, sessionId } from "./host.ts";

/** Names of omp tools registered in this process (shared across packages). */
const REGISTERED_KEY = Symbol.for("omp-tools.registered.v1");
const CONTRACT_KEY = Symbol.for("omp-tools.contract.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[REGISTERED_KEY] ??= new Set<string>();
export const registeredTools = globalRegistry[REGISTERED_KEY] as Set<string>;

/**
 * Read-group tracker: consecutive `read` tool calls (no other tool, no
 * assistant prose, no user message in between) share one group id, so the
 * renderer can collapse them into a single omp-style `• Read (N)` tree.
 *
 * Group ids are stamped into each read result's details at execute time
 * (persisted with the session), so replayed transcripts group exactly like
 * the live session did. The boot prefix keeps ids from a previous process
 * from colliding with this one's counters, and the per-session counter map
 * keeps concurrent sessions in one process (daemon hosts) from either
 * splitting each other's groups or colliding into the same group id.
 */
const READ_GROUPS_KEY = Symbol.for("omp-tools.read-groups.v2");
interface ReadGroupTracker {
	boot: string;
	/** Per-session break counter; sessions are never removed (one number each). */
	counters: Map<string, number>;
	byCall: Map<string, string>;
}
globalRegistry[READ_GROUPS_KEY] ??= {
	boot: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
	counters: new Map<string, number>(),
	byCall: new Map<string, string>(),
} satisfies ReadGroupTracker;
const readGroups = globalRegistry[READ_GROUPS_KEY] as ReadGroupTracker;

/** Session bucket for group ids; hosts without a session ctx share "". */
function sessionKeyOf(ctx: unknown): string {
	return sessionId(ctx) ?? "";
}

/** Live group id for a read tool call, if the tracker saw its tool_call event. */
export function readGroupOf(toolCallId: string | undefined): string | undefined {
	return toolCallId ? readGroups.byCall.get(toolCallId) : undefined;
}

/** Stamp the group id into a read result's details so replays group identically. */
export function stampReadGroup(toolCallId: string, result: unknown): void {
	const group = readGroups.byCall.get(toolCallId);
	if (!group || !result || typeof result !== "object") return;
	const details = (result as { details?: Record<string, unknown> }).details;
	if (details && typeof details === "object") details.readGroup = group;
}

function breakReadGroup(sessionKey: string): void {
	readGroups.counters.set(sessionKey, (readGroups.counters.get(sessionKey) ?? 0) + 1);
}

function trackReadGroup(toolName: string | undefined, toolCallId: string | undefined, sessionKey: string): void {
	if (toolName !== "read") {
		breakReadGroup(sessionKey);
		return;
	}
	if (!toolCallId) {
		// A read we cannot track must fence the group: otherwise its solo
		// panel would sit between its neighbours' collapsed slots and the
		// group widget, visually reordering the transcript.
		breakReadGroup(sessionKey);
		return;
	}
	const scope = sessionKey ? `${sessionKey}:` : "";
	readGroups.byCall.set(toolCallId, `${readGroups.boot}:${scope}${readGroups.counters.get(sessionKey) ?? 0}`);
	if (readGroups.byCall.size > 1024) {
		for (const key of readGroups.byCall.keys()) {
			if (readGroups.byCall.size <= 512) break;
			readGroups.byCall.delete(key);
		}
	}
}

/** True when a finished message contains visible text (assistant prose / user prompt). */
function messageHasProse(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const { role, content } = message as { role?: unknown; content?: unknown };
	// Allowlist visible roles: hosts also finish invisible bookkeeping
	// messages (e.g. custom/display:false context notes) whose text must not
	// split a group, and unknown fork-specific roles must not disable
	// grouping wholesale by breaking after every read.
	if (role !== "assistant" && role !== "user") return false;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	return content.some(part => {
		if (!part || typeof part !== "object") return false;
		const { type, text } = part as { type?: unknown; text?: unknown };
		return type === "text" && typeof text === "string" && text.trim().length > 0;
	});
}

const FILE_TOOLS = ["read", "write", "edit", "search", "find"];

const TOOL_SUMMARIES: Record<string, string> = {
	read: "read — files, dirs, archives, SQLite, PDFs, notebooks, URLs through one path; mints [path#TAG] anchors",
	write: "write — create/overwrite a file, archive entry, or SQLite row",
	edit: "edit — hashline patches anchored on [path#TAG] + original line numbers from read/search",
	search: "search — regex over files/globs; output rows are valid edit anchors",
	find: "find — glob path lookup (newest-first)",
	ast_grep: "ast_grep — structural code queries via tree-sitter patterns",
	ast_edit: "ast_edit — structural rewrites, previewed before apply",
	todo: "todo — phased session task list; tasks referenced by verbatim content, earliest open task auto-promotes",
	web_search: "web_search — one web query (Exa or Parallel), answer plus citations",
	github: "github — gh CLI ops: repos, files, PRs, issue/PR view, code search, Actions run-watch",
	browser: "browser — persistent tabs over raw CDP (Obscura when installed, else Chromium); open once, then run JS with tab helpers",
	inspect_image: "inspect_image — vision-model analysis of a local image file",
};

const TOOL_ORDER = [
	"read",
	"write",
	"edit",
	"search",
	"find",
	"ast_grep",
	"ast_edit",
	"todo",
	"web_search",
	"github",
	"browser",
	"inspect_image",
];

function buildContractBlock(): string {
	if (registeredTools.size === 0) return "";
	const lines: string[] = ["## omp-tools"];
	if (FILE_TOOLS.some(name => registeredTools.has(name))) {
		lines.push(
			"ALL file and search work goes through these tools. NEVER use bash/ipython for file operations: no cat/head/tail (use read), no grep/rg (use search), no find/ls for discovery (use find), no sed/awk/tee/heredoc rewrites or python open()/read_text()/write_text() (use edit/write). Such calls are blocked.",
		);
	}
	for (const name of TOOL_ORDER) {
		if (registeredTools.has(name)) lines.push(`- ${TOOL_SUMMARIES[name]}`);
	}
	if (registeredTools.has("edit")) {
		lines.push(
			"",
			"Anchor loop: `read`/`search` output `[path#TAG]` headers with `N:text` rows; `edit` sections copy that exact tag and name ORIGINAL line numbers. " +
				"After an edit, the response shows fresh line numbers and the new tag — use those (or re-read) before the next edit on the same file.",
		);
	}
	if (registeredTools.has("ast_edit")) {
		lines.push("`ast_edit` is dry-run by default: verify the preview, then re-issue with apply: true.");
	}
	if (registeredTools.has("browser")) {
		lines.push("`browser` tabs persist across calls: `open` once, then `run` — never re-open a live tab.");
	}
	return lines.join("\n");
}

/** Wire prompt-contract + builtin-retirement handlers exactly once per process. */
export function ensurePromptContract(pi: PiApi): void {
	if (globalRegistry[CONTRACT_KEY]) return;
	globalRegistry[CONTRACT_KEY] = true;
	if (typeof pi.on !== "function") return;

	pi.on("before_agent_start", async (event: unknown) => {
		const block = buildContractBlock();
		if (!block) return undefined;
		if (!event || typeof event !== "object" || !("systemPrompt" in event)) return undefined;
		const systemPrompt = event.systemPrompt;
		if (typeof systemPrompt !== "string" || systemPrompt.includes("## omp-tools")) return undefined;
		return { systemPrompt: `${systemPrompt}\n\n${block}` };
	});

	pi.on("session_start", async (_event: unknown, ctx?: unknown) => {
		// A new (or resumed) session starts fresh: never continue a group
		// across a session boundary in the same process.
		breakReadGroup(sessionKeyOf(ctx));
		retireOverlappingBuiltins(pi);
	});

	pi.on("tool_call", async (event: unknown, ctx?: unknown) => {
		if (!event || typeof event !== "object") return undefined;
		const toolName = "toolName" in event && typeof event.toolName === "string" ? event.toolName : undefined;
		const toolCallId = "toolCallId" in event && typeof event.toolCallId === "string" ? event.toolCallId : undefined;
		trackReadGroup(toolName, toolCallId, sessionKeyOf(ctx));
		let input: Record<string, unknown> | undefined;
		if ("input" in event && event.input && typeof event.input === "object") {
			// verified plain object above; widen to an index shape for field reads
			input = event.input as Record<string, unknown>;
		}
		const verdict = guardFileOps(toolName, input);
		if (verdict) return { block: true, reason: verdict };
		return undefined;
	});

	// Visible text between reads (assistant prose or a new user prompt)
	// separates their panels in the transcript, so it must break the group.
	pi.on("message_end", async (event: unknown, ctx?: unknown) => {
		if (!event || typeof event !== "object" || !("message" in event)) return undefined;
		if (messageHasProse((event as { message?: unknown }).message)) breakReadGroup(sessionKeyOf(ctx));
		return undefined;
	});
}

/**
 * Deactivate built-in tools that duplicate an installed omp tool's purpose.
 * Same-name tools (read/write/edit/todo/...) are replaced by registration
 * already; this handles differently-named ones (pi's grep/glob/ls vs
 * search/find).
 */
function retireOverlappingBuiltins(pi: PiApi): void {
	if (process.env.OMP_TOOLS_KEEP_BUILTINS === "1") return;
	try {
		// tool management is a host extra outside the minimal PiApi surface
		const host = pi as { getActiveTools?: () => unknown[]; setActiveTools?: (names: string[]) => void };
		if (typeof host.getActiveTools !== "function" || typeof host.setActiveTools !== "function") return;
		const active: string[] = [];
		for (const tool of host.getActiveTools.call(pi)) {
			if (typeof tool === "string") active.push(tool);
			else if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") active.push(tool.name);
		}
		const retire = new Set<string>();
		if (registeredTools.has("search")) {
			retire.add("grep");
			retire.add("rg");
		}
		if (registeredTools.has("find")) {
			retire.add("glob");
			retire.add("ls");
		}
		const next = active.filter(name => !retire.has(name));
		if (next.length !== active.length) host.setActiveTools.call(pi, next);
	} catch {
		/* host without tool management — fine */
	}
}

const BASH_FILE_IO_RE = new RegExp(
	[
		// leading or chained file-inspection commands (cat foo.txt, x && grep ...)
		String.raw`(?:^|&&|\|\||;)\s*(?:cat|head|tail|less|grep|rg|egrep|fgrep)\s+[^|<>]*$`,
		// in-place sed edits anywhere
		String.raw`(?:^|&&|\|\||;)\s*sed\s+(?:-[a-zA-Z]*\s+)*-i`,
		// find-based discovery
		String.raw`(?:^|&&|\|\||;)\s*find\s+\S`,
	].join("|"),
	"m",
);

const PY_FILE_IO_RE = new RegExp(
	[
		// open(..., 'w'/'a'/'x') writes and open('r'-less) mode strings
		String.raw`\bopen\s*\([^)]*["'][rwax]b?\+?["']`,
		// bare open(...).read()/readlines()
		String.raw`\bopen\s*\([^)]*\)\s*\.\s*read`,
		String.raw`\.write_text\s*\(`,
		String.raw`\.read_text\s*\(`,
		String.raw`\bshutil\.(?:copy|move|rmtree)`,
		String.raw`\bos\.(?:remove|unlink|rename)\s*\(`,
	].join("|"),
);

/** Extract shell command text from an ipython cell: `%%bash` cells and `!cmd` lines. */
function shellTextFromIpythonCode(code: string): string | null {
	const trimmed = code.trimStart();
	if (trimmed.startsWith("%%bash") || trimmed.startsWith("%%sh")) {
		const newline = trimmed.indexOf("\n");
		return newline === -1 ? "" : trimmed.slice(newline + 1);
	}
	const bangLines = code
		.split("\n")
		.filter(line => /^\s*!/.test(line))
		.map(line => line.replace(/^\s*!/, ""));
	return bangLines.length > 0 ? bangLines.join("\n") : null;
}

/**
 * Redirect obvious file I/O in bash/ipython to the omp tools. Escape hatches:
 * OMP_TOOLS_NO_GUARD=1 disables entirely; a literal `omp-ok` marker in the
 * command/code allows a specific call through (for legitimate data work).
 * Only active while at least one file tool (read/write/edit/search/find) is
 * registered — todo/browser/web_search installs alone must not block bash.
 */
function guardFileOps(toolName: string | undefined, input: Record<string, unknown> | undefined): string | null {
	if (process.env.OMP_TOOLS_NO_GUARD === "1") return null;
	if (!toolName || !input) return null;
	if (!FILE_TOOLS.some(name => registeredTools.has(name))) return null;

	const bashRedirect =
		"omp-tools: use the dedicated tools instead of shell file I/O — read (cat/head/tail), " +
		"search (grep/rg), find (find/ls), edit (sed -i). " +
		"If this command is genuinely not file inspection/editing (e.g. fixture setup), re-run it with `# omp-ok` appended.";

	if (toolName === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		if (!command || command.includes("omp-ok")) return null;
		if (BASH_FILE_IO_RE.test(command)) return bashRedirect;
		return null;
	}

	if (toolName === "ipython" && (registeredTools.has("read") || registeredTools.has("edit") || registeredTools.has("write"))) {
		const code = typeof input.code === "string" ? input.code : "";
		if (!code || code.includes("omp-ok")) return null;
		// prime runs shell through ipython `%%bash` cells and `!` escapes.
		const shellText = shellTextFromIpythonCode(code);
		if (shellText !== null) {
			return BASH_FILE_IO_RE.test(shellText) ? bashRedirect : null;
		}
		if (PY_FILE_IO_RE.test(code)) {
			return (
				"omp-tools: use the dedicated tools instead of python file I/O — read (open/read_text), " +
				"edit (targeted changes), write (open('w')/write_text). " +
				"If this code is genuinely data processing rather than file viewing/editing, re-run it with `# omp-ok` in the code."
			);
		}
	}
	return null;
}
