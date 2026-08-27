import * as fs from "node:fs";
import * as path from "node:path";
import type { GuideName } from "./guides.ts";
import { parseMutations } from "./mutations.ts";
import { shellCommands } from "./shell.ts";

/** A permanent policy rejection with no reissue bypass. */
export interface HardBlock {
	readonly title: string;
	readonly reason: string;
}

/** One instructional review keyed by its policy and target path or surface. */
export interface ReviewMatch {
	readonly key: string;
	readonly policy: "simplify" | "test-quality" | "use-effect" | "ste" | "pr-writing";
	readonly target: string;
	readonly label: string;
	readonly instruction: string;
	readonly guides: GuideName[];
	readonly recurring: boolean;
}

const GIT_COMMIT = /\bgit(?:\s+(?:-[cC]\s+\S+|--?\S+))*\s+commit\b/;
const GIT_TAG = /\bgit(?:\s+(?:-[A-Za-z]\s+\S+|--\S+))*\s+tag\b/;
const GIT_MESSAGE_FLAG = /(?:^|\s)(?:--(?:message|file)(?==|\s|$)|-[A-Za-z]*[mF]\S*)(?=\s|$)/;
const NO_VERIFY = /--no-verify\b/;
const SHORT_NO_VERIFY = /(?:^|\s)-[A-Za-z]*n[A-Za-z]*(?=\s|$)/;

const AI_IDENTITY_SOURCE = [
	String.raw`\bclaude\b`,
	String.raw`anthropic`,
	String.raw`chatgpt`,
	String.raw`openai`,
	String.raw`\bgpt-?\d`,
	String.raw`\bcodex\b`,
	String.raw`copilot`,
	String.raw`\bcursor\b`,
	String.raw`devin[-\s]?ai`,
	String.raw`\baider\b`,
	String.raw`\bgemini\b`,
	String.raw`google-labs`,
	String.raw`\bdroid\b`,
	String.raw`factory\.ai`,
	String.raw`\bamp\b`,
	String.raw`ampcode`,
	String.raw`sourcegraph`,
	String.raw`windsurf`,
	String.raw`codeium`,
	String.raw`\bcline\b`,
	String.raw`\broo\s?code\b`,
	String.raw`kilo\s?code`,
	String.raw`opencode`,
	String.raw`openhands`,
	String.raw`all-hands`,
	String.raw`\bgoose\b`,
	String.raw`\bsweep\b`,
	String.raw`qodo`,
	String.raw`tabnine`,
	String.raw`greptile`,
	String.raw`coderabbit`,
	String.raw`zencoder`,
	String.raw`\[bot\]`,
	String.raw`\bbot\b`,
	String.raw`(?:^|[<\s])(?:ai|bot|agent|noreply)@`,
].join("|");
const AI_IDENTITY = new RegExp(AI_IDENTITY_SOURCE, "i");
const TRAILER_LINE = /^.*\b[\w-]+-by\s*:.*$/gim;
const PROSE_ATTRIBUTION = new RegExp(
	String.raw`^.*(?:🤖|(?:generated|created|written|authored|assisted|co-created|produced|made)\s+(?:with|by|using|via))[^\n]{0,80}(?:${AI_IDENTITY_SOURCE}).*$`,
	"gim",
);

const PR_CREATE = /\bgh(?:\s+--?\S+(?:[= ]\S+)?)*\s+pr\s+(?:create|new)\b/;
const PR_EDIT_BODY = /\bgh(?:\s+--?\S+(?:[= ]\S+)?)*\s+pr\s+edit\b[\s\S]*?(?:--body(?:-file)?\b|\s-[bF]\b)/;
const PR_COMMENT = /\bgh(?:\s+--?\S+(?:[= ]\S+)?)*\s+pr\s+comment\b[\s\S]*?(?:--body(?:-file)?\b|\s-[bF]\b)/;
const PR_REVIEW = /\bgh(?:\s+--?\S+(?:[= ]\S+)?)*\s+pr\s+review\b[\s\S]*?(?:--body(?:-file)?\b|\s-[bF]\b)/;
const PR_FILL = /--fill(?:-first|-verbose)?\b|\s-f\b/;

const GH_PROSE = /\bgh(?:\s+--?\S+(?:[= ]\S+)?)*\s+(issue\s+(?:create|comment|edit)|release\s+(?:create|edit))\b/;
const GH_BODY_FLAG = /(?:--body(?:-file)?\b|--notes(?:-file)?\b|--title\b|\s-[btF]\b)/;

const CODE_PATH = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|rb|java|kt|kts|swift|c|h|m|mm|cpp|cc|hpp|cs|php|sh|bash|zsh|fish|sql|vue|svelte|astro|scala|ex|exs|lua|zig|dart|css|scss)$/i;
const CODE_EXCLUDE = /(?:^|\/)(?:node_modules|\.git)\//;
const TEST_PATH = /(^|\/)__tests__\/|(^|\/)tests?\/|\.(test|spec)\.[^/]+$|_test\.[a-z]+$|(^|\/)test_[^/]*\.py$/i;
const TEST_CONTENT = /\b(?:describe|it|test)(?:\.(?:each|only|skip|todo|concurrent|failing|fails|sequential)(?:\([^)]*\))?)?\s*\(\s*[`'"]|#\[(?:tokio::)?test\]|\bfunc\s+Test[A-Z]\w*\s*\(\s*\w+\s+\*testing\.T|^\s*def\s+test_\w+\s*\(/m;
const TEST_CODE_PATH = /\.[mc]?[tj]sx?$|\.(py|go|rs|rb|java|kt|swift)$/i;
const TYPESCRIPT_PATH = /\.[mc]?[tj]sx?$/i;
const USE_EFFECT_REFERENCE = /\b(?:React\s*\.\s*)?useEffect\b/;
const DOC_PATH = /\.(?:md|mdx)$/i;
const DOC_EXCLUDE = /(?:^|\/)node_modules\/|(?:^|\/)lazy-prime-gates\/guides\//;

/** Apply every permanent Git and PR rejection before instructional reviews. */
export function matchHardBlock(toolName: string, input: Record<string, unknown>): HardBlock | undefined {
	for (const command of shellCommands(toolName, input)) {
		if (GIT_COMMIT.test(command)) {
			const sources = [command, ...commitMessageFileContents(command, input)];
			const offending = [...new Set(sources.flatMap(aiAttributionLines))];
			if (offending.length > 0) {
				return {
					title: "AI attribution blocked",
					reason: [
						"BLOCKED: this commit credits an AI agent or bot:",
						...offending.map(line => `  ${line}`),
						"Remove the attribution. Human co-authors and human trailers are permitted.",
					].join("\n"),
				};
			}
		}
		if (/\bgit\b/.test(command) && (NO_VERIFY.test(command) || (GIT_COMMIT.test(command) && SHORT_NO_VERIFY.test(command)))) {
			return {
				title: "Git hook bypass blocked",
				reason: "BLOCKED: --no-verify is not permitted. The git commit -n alias is also not permitted. Correct the hook failure or ask the user for help.",
			};
		}
		const create = PR_CREATE.exec(command);
		if (create && PR_FILL.test(command.slice(create.index))) return fillBlock();
	}
	if (toolName === "github" && input.op === "pr_create" && input.fill === true) return fillBlock();
	return undefined;
}

/** Collect all instructional policies that apply to one tool call. */
export function matchReviews(toolName: string, input: Record<string, unknown>): ReviewMatch[] {
	const matches = [
		...matchMutationReviews(toolName, input),
		...matchShellReviews(toolName, input),
		...matchGithubReviews(toolName, input),
	];
	return [...new Map(matches.map(match => [match.key, match])).values()];
}

function fillBlock(): HardBlock {
	return {
		title: "Fill-derived PR body blocked",
		reason: "BLOCKED: a fill-derived PR body is not permitted. Remove fill and compose the title and body with the bundled PR guide.",
	};
}

function aiAttributionLines(text: string): string[] {
	const trailers = (text.match(TRAILER_LINE) ?? []).filter(line => AI_IDENTITY.test(line));
	const prose = text.match(PROSE_ATTRIBUTION) ?? [];
	return [...new Set([...trailers, ...prose].map(line => line.trim()))];
}

function commitMessageFileContents(command: string, input: Record<string, unknown>): string[] {
	const contents: string[] = [];
	const base = typeof input.cwd === "string" ? input.cwd : process.cwd();
	const flags = /(?:^|\s)(?:-F\s*|--file(?:=|\s+))((?:"(?:\\.|[^"])*")|(?:'[^']*')|[^\s;&|]+)/g;
	for (const match of command.matchAll(flags)) {
		const token = match[1];
		if (!token || token === "-") continue;
		const file = shellWord(token);
		try {
			contents.push(fs.readFileSync(path.resolve(base, file), "utf8"));
		} catch {
			// Git reports missing or unreadable message files itself.
		}
	}
	return contents;
}

function shellWord(token: string): string {
	if (token.startsWith("'") && token.endsWith("'")) return token.slice(1, -1);
	if (token.startsWith('"') && token.endsWith('"')) {
		try {
			return JSON.parse(token) as string;
		} catch {
			return token.slice(1, -1);
		}
	}
	return token;
}

function matchMutationReviews(toolName: string, input: Record<string, unknown>): ReviewMatch[] {
	const matches: ReviewMatch[] = [];
	for (const change of parseMutations(toolName, input)) {
		if (isCodePath(change.path, toolName)) {
			matches.push(review("simplify", change.path, `code in ${change.path}`, "Apply the Simplify guide while you compose the change.", ["simplify"], false));
		}
		if (TEST_PATH.test(change.path) || (TEST_CODE_PATH.test(change.path) && TEST_CONTENT.test(change.added))) {
			matches.push(review("test-quality", change.path, `tests in ${change.path}`, "Decide whether each test is necessary, then make each test name an observable break and exercise the real interface.", ["writing-better-tests"], false));
		}
		if ((isTypeScriptPath(change.path) || toolName === "ast_edit") && USE_EFFECT_REFERENCE.test(change.added)) {
			matches.push(review("use-effect", change.path, `direct useEffect in ${change.path}`, "Remove direct component useEffect calls or justify the reusable-hook escape hatch after the review.", ["no-use-effect"], false));
		}
		if (DOC_PATH.test(change.path) && !DOC_EXCLUDE.test(change.path)) {
			matches.push(review("ste", change.path, `documentation in ${change.path}`, "Rewrite the documentation with the bundled STE-100 standard.", ["ste100-writing"], false));
		}
	}
	return matches;
}

function matchShellReviews(toolName: string, input: Record<string, unknown>): ReviewMatch[] {
	const matches: ReviewMatch[] = [];
	for (const command of shellCommands(toolName, input)) {
		const pr = matchPrCommand(command);
		if (pr) matches.push(pr);

		const commit = GIT_COMMIT.exec(command);
		if (commit && GIT_MESSAGE_FLAG.test(command.slice(commit.index))) {
			matches.push(review("ste", "git:commit", "git commit message", "Recompose the commit message with the STE-100 standard.", ["ste100-writing"], true));
		}
		const tag = GIT_TAG.exec(command);
		if (tag && GIT_MESSAGE_FLAG.test(command.slice(tag.index))) {
			matches.push(review("ste", "git:tag", "git tag message", "Recompose the tag message with the STE-100 standard.", ["ste100-writing"], true));
		}
		const gh = GH_PROSE.exec(command);
		if (gh && GH_BODY_FLAG.test(command.slice(gh.index))) {
			const target = gh[1]?.replace(/\s+/g, ":") ?? "gh:prose";
			matches.push(review("ste", `gh:${target}`, `gh ${gh[1] ?? "prose"}`, "Recompose the issue or release text with the STE-100 standard.", ["ste100-writing"], true));
		}
	}
	return matches;
}

function matchGithubReviews(toolName: string, input: Record<string, unknown>): ReviewMatch[] {
	if (toolName !== "github" || typeof input.op !== "string") return [];
	if (input.op === "pr_create") {
		return [review("pr-writing", "github:pr_create", "github pr_create", "Compose the PR title and body with the PR guide and the STE-100 standard.", ["pr-description-writing", "ste100-writing"], true)];
	}
	if (["issue_create", "issue_comment", "issue_edit", "release_create", "release_edit"].includes(input.op)) {
		return [review("ste", `github:${input.op}`, `github ${input.op}`, "Compose the issue or release text with the STE-100 standard.", ["ste100-writing"], true)];
	}
	return [];
}

function matchPrCommand(command: string): ReviewMatch | undefined {
	if (PR_CREATE.test(command)) return prReview("create", "gh pr create");
	if (PR_EDIT_BODY.test(command)) return prReview("edit", "gh pr edit");
	if (PR_COMMENT.test(command)) return prReview("comment", "gh pr comment");
	if (PR_REVIEW.test(command)) return prReview("review", "gh pr review");
	return undefined;
}

function prReview(category: string, label: string): ReviewMatch {
	const instruction = category === "comment" || category === "review"
		? "Write only the decision or context that the thread cannot show. Apply the PR prose rules and the STE-100 standard."
		: "Compose the PR title and body from reviewer decision cost, then apply the STE-100 standard.";
	return review("pr-writing", `gh:pr:${category}`, label, instruction, ["pr-description-writing", "ste100-writing"], true);
}

function review(
	policy: ReviewMatch["policy"],
	target: string,
	label: string,
	instruction: string,
	guides: GuideName[],
	recurring: boolean,
): ReviewMatch {
	return { key: `${policy}:${target}`, policy, target, label, instruction, guides, recurring };
}

function isCodePath(path: string, toolName: string): boolean {
	if (CODE_EXCLUDE.test(path)) return false;
	return CODE_PATH.test(path) || (toolName === "ast_edit" && (path.includes("*") || path.length > 0));
}

function isTypeScriptPath(path: string): boolean {
	return TYPESCRIPT_PATH.test(path) || (path.includes("*") && /[tj]s/i.test(path));
}
