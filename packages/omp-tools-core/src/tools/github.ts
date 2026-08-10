import { execFile } from "node:child_process";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { promisify } from "node:util";
import { Type } from "typebox";
import { ToolError, textResult, type PiApi, type ToolCtx, type ToolResult } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { githubRenderers, loadRenderSupport } from "../render.ts";
import {
	buildGhArgs,
	buildSearchDateQualifier,
	parseSearchDateBound,
	RUN_FIELDS,
	type GithubOp,
	type GithubParams,
	type GithubRepoContext,
} from "./github-args.ts";
import {
	failed,
	formatIssueView,
	formatPrDiffFiles,
	formatPrView,
	formatRepoView,
	formatRunWatch,
	formatSearch,
	formatSearchPrs,
	runDetails,
	type GhIssue,
	type GhPr,
	type GhRepo,
	type GhRun,
	type GhSearchItem,
} from "./github-format.ts";

export {
	buildGhArgs,
	buildSearchDateQualifier,
	formatRepoView,
	formatRunWatch,
	formatSearchPrs,
	parseSearchDateBound,
};
export type { GithubOp, GithubParams, GithubRepoContext };

export const GITHUB_DESCRIPTION = `Op-based GitHub CLI wrapper for repositories, files, issues, pull requests, search, worktrees, pushes, and Actions runs.

Pick an operation with \`op\`:
- \`repo_view\`: Omit \`repo\` to view the current checkout.
- \`file_read\`: Read \`path\` from \`repo\`. Omit \`branch\` for the default branch.
- \`issue_view\`: Pass the issue number or URL in \`pr\`. The result includes comments.
- \`pr_view\`: Pass a pull request number, URL, or branch in \`pr\`. The result includes comments and reviews.
- \`pr_diff\`: Omit \`path\` for the file list. Set \`path\` to \`all\` for the full unified diff.
- \`pr_create\`: The \`head\` value defaults to the current branch.
- \`pr_checkout\`: Check out one or more pull requests into separate git worktrees. Pass an array in \`pr\` for a batch.
- \`pr_push\`: Push HEAD from a worktree made by \`pr_checkout\` to the pull request head branch.
- \`search_issues\`, \`search_prs\`, and \`search_commits\`: The query is optional when a date bound is present.
- \`search_code\`: The query is required. Date bounds do not apply.
- \`search_repos\`: This operation ignores \`repo\`. Use a query qualifier such as \`org:\` or \`language:\`.
- Search operations default to the current checkout unless the query contains \`repo:\`, \`org:\`, \`user:\`, or \`owner:\`.
- \`since\` and \`until\` accept a relative duration such as \`3d\`, \`2w\`, \`6mo\`, or \`1y\`. They also accept an ISO date or datetime.
- \`dateField: "updated"\` uses the updated date for issues and pull requests, and the pushed date for repositories.
- \`run_watch\`: Omit \`run\` to watch the runs for the current HEAD. The operation stops at the first failed job and includes failed log lines.`;

const OPS = [
	"repo_view",
	"file_read",
	"issue_view",
	"pr_view",
	"pr_diff",
	"pr_create",
	"pr_checkout",
	"pr_push",
	"search_issues",
	"search_prs",
	"search_code",
	"search_commits",
	"search_repos",
	"run_watch",
] as const;

const MAX_BUFFER = 32 * 1024 * 1024;
const POLL_MS = 3_000;
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/;
const exec = promisify(execFile);

interface RunOutput {
	stdout: string;
	stderr: string;
}

interface Checkout {
	prNumber: number;
	url?: string;
	branch: string;
	worktreePath: string;
	remoteBranch: string;
	reused: boolean;
}

export async function executeGithub(params: GithubParams, ctx?: ToolCtx, signal?: AbortSignal): Promise<ToolResult> {
	const cwd = ctx?.cwd ?? process.cwd();
	const repoCtx = await getRepoContext(cwd, signal);
	if (params.op === "pr_checkout") return checkout(params, repoCtx, cwd, signal);
	if (params.op === "pr_push") return push(params, repoCtx, cwd, signal);
	if (params.op === "run_watch") return watch(params, repoCtx, cwd, signal);

	const args = firstArgs(buildGhArgs(params.op, params, repoCtx));
	if (params.op === "file_read" || (params.op === "pr_diff" && params.path === "all")) {
		const output = await gh(args, cwd, signal);
		return textResult(output.stdout, {
			op: params.op,
			repo: params.repo ?? repoCtx.repo,
			path: params.path,
			branch: params.branch,
			output: output.stdout,
		});
	}
	if (params.op === "pr_create") {
		const output = await gh(args, cwd, signal);
		const url = output.stdout.split("\n").map(row => row.trim()).find(row => row.startsWith("https://github.com/"));
		return textResult(url ? `Created pull request: ${url}` : output.stdout.trim(), {
			op: params.op,
			url,
			title: params.title,
			head: params.head,
			base: params.base,
			draft: params.draft === true,
		});
	}

	const data = await ghJson<unknown>(args, cwd, signal);
	return formatJson(params, repoCtx, data);
}

export async function registerGithub(pi: PiApi): Promise<void> {
	registeredTools.add("github");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...githubRenderers(support) } : {}),
		name: "github",
		label: "GitHub",
		description: GITHUB_DESCRIPTION,
		promptSnippet: "GitHub repositories, files, pull requests, search, worktrees, pushes, and Actions runs",
		promptGuidelines: [
			"Use github for GitHub-hosted repositories, pull requests, and issues instead of curl or raw git where it fits.",
		],
		parameters: Type.Object({
			op: Type.Union(OPS.map(op => Type.Literal(op)), { description: "GitHub operation" }),
			repo: Type.Optional(Type.String({ description: "owner/repo" })),
			path: Type.Optional(Type.String({ description: "repository-relative file path, or all for a full PR diff" })),
			branch: Type.Optional(Type.String({ description: "branch" })),
			pr: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())], { description: "issue or PR number, URL, or branch" })),
			run: Type.Optional(Type.String({ description: "Actions run ID or URL" })),
			query: Type.Optional(Type.String({ description: "search query" })),
			since: Type.Optional(Type.String({ description: "lower date bound: relative duration, ISO date, or ISO datetime" })),
			until: Type.Optional(Type.String({ description: "upper date bound: relative duration, ISO date, or ISO datetime" })),
			dateField: Type.Optional(Type.Union([Type.Literal("created"), Type.Literal("updated")], { description: "date field" })),
			limit: Type.Optional(Type.Number({ description: "maximum search results" })),
			title: Type.Optional(Type.String({ description: "pull request title" })),
			body: Type.Optional(Type.String({ description: "pull request body markdown" })),
			base: Type.Optional(Type.String({ description: "pull request base branch" })),
			head: Type.Optional(Type.String({ description: "pull request head branch" })),
			draft: Type.Optional(Type.Boolean({ description: "open the pull request as a draft" })),
			fill: Type.Optional(Type.Boolean({ description: "fill the pull request title and body from commits" })),
			label: Type.Optional(Type.Array(Type.String(), { description: "labels" })),
			assignee: Type.Optional(Type.Array(Type.String(), { description: "assignees" })),
			reviewer: Type.Optional(Type.Array(Type.String(), { description: "reviewers" })),
			force: Type.Optional(Type.Boolean({ description: "reset an existing local PR branch" })),
			forceWithLease: Type.Optional(Type.Boolean({ description: "push with force-with-lease" })),
			tail: Type.Optional(Type.Number({ description: "failed log lines, default 40" })),
		}),
		async execute(_id: string, params: GithubParams, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolCtx) {
			return executeGithub(params, ctx, signal);
		},
	});
}

export function parseGithubRepo(remote: string): string | undefined {
	const value = remote.trim().replace(/\.git$/, "");
	const https = /^https?:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(value);
	if (https) return https[1];
	const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+)$/.exec(value);
	return ssh?.[1];
}

function formatJson(params: GithubParams, repoCtx: GithubRepoContext, data: unknown): ToolResult {
	const details = { op: params.op, repo: params.repo ?? repoCtx.repo, data };
	// Each cast matches the fields requested from gh for this operation.
	switch (params.op) {
		case "repo_view": {
			const repo = data as GhRepo;
			return textResult(formatRepoView(repo), details);
		}
		case "issue_view": {
			const issue = data as GhIssue;
			return textResult(formatIssueView(issue), details);
		}
		case "pr_view": {
			const pull = data as GhPr;
			return textResult(formatPrView(pull), details);
		}
		case "pr_diff": {
			const diff = data as { files?: GhPr["files"]; url?: string };
			return textResult(formatPrDiffFiles(diff), details);
		}
		case "search_prs": {
			const query = queryFromParams(params);
			const found = data as { items?: GhSearchItem[] };
			return textResult(formatSearchPrs(found, query, searchScope(params, repoCtx, query)), details);
		}
		case "search_issues":
		case "search_code":
		case "search_commits":
		case "search_repos": {
			const found = data as { items?: Array<Record<string, unknown>> };
			return textResult(formatSearch(found, params.op.slice("search_".length), queryFromParams(params)), details);
		}
		default:
			throw new ToolError(`unexpected JSON result for ${params.op}`);
	}
}

async function checkout(
	params: GithubParams,
	repoCtx: GithubRepoContext,
	cwd: string,
	signal?: AbortSignal,
): Promise<ToolResult> {
	const plans = buildGhArgs("pr_checkout", params, repoCtx);
	const root = (await git(["rev-parse", "--show-toplevel"], cwd, signal)).stdout.trim();
	const slug = params.repo ?? repoCtx.repo;
	const name = slug?.split("/").at(-1) ?? path.basename(root);
	const checkouts: Checkout[] = [];

	for (const args of plans) {
		const data = await ghJson<GhPr>(args, cwd, signal);
		if (!data.number || !data.headRefName) throw new ToolError("gh did not return the pull request head branch");
		const worktreePath = path.resolve(root, "..", `${name}-pr-${data.number}`);
		const branch = `pr-${data.number}`;
		const found = await stat(worktreePath);
		if (found) {
			if (!found.isDirectory()) throw new ToolError(`worktree path already exists: ${worktreePath}`);
			const top = await gitStatus(["-C", worktreePath, "rev-parse", "--show-toplevel"], root, signal);
			const current = await gitStatus(["-C", worktreePath, "branch", "--show-current"], root, signal);
			if (top.code !== 0 || path.resolve(top.stdout.trim()) !== worktreePath || current.stdout.trim() !== branch) {
				throw new ToolError(`worktree path already exists and is not ${branch}: ${worktreePath}`);
			}
			checkouts.push({ prNumber: data.number, url: data.url, branch, worktreePath, remoteBranch: data.headRefName, reused: true });
			continue;
		}
		const remoteRepo = data.headRepository?.nameWithOwner;
		if (!remoteRepo) throw new ToolError("gh did not return the pull request head repository");
		const remoteUrl = data.headRepository?.sshUrl ?? `https://github.com/${remoteRepo}.git`;
		await git(["fetch", remoteUrl, data.headRefName], root, signal);
		const exists = (await gitStatus(["show-ref", "--verify", `refs/heads/${branch}`], root, signal)).code === 0;
		if (exists && !params.force) throw new ToolError(`local branch ${branch} already exists; pass force=true to reset it`);
		if (exists) await git(["branch", "-f", branch, "FETCH_HEAD"], root, signal);
		else await git(["branch", branch, "FETCH_HEAD"], root, signal);
		await git(["worktree", "add", worktreePath, branch], root, signal);
		await git(["config", `branch.${branch}.ompPrUrl`, data.url ?? ""], root, signal);
		await git(["config", `branch.${branch}.ompPrHeadRef`, data.headRefName], root, signal);
		checkouts.push({ prNumber: data.number, url: data.url, branch, worktreePath, remoteBranch: data.headRefName, reused: false });
	}

	const lines = checkouts.map(item => `#${item.prNumber}: ${item.worktreePath} (${item.reused ? "reused" : "checked out"})`);
	return textResult(lines.join("\n"), { op: "pr_checkout", repo: slug, checkouts });
}

async function push(params: GithubParams, repoCtx: GithubRepoContext, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	const branch = params.branch ?? (await git(["branch", "--show-current"], cwd, signal)).stdout.trim();
	if (!branch) throw new ToolError("current git branch is unavailable");
	const url = (await gitStatus(["config", "--get", `branch.${branch}.ompPrUrl`], cwd, signal)).stdout.trim();
	if (!url) throw new ToolError("pr_push requires a branch checked out by pr_checkout");
	const parsed = PR_URL.exec(url);
	if (!parsed) throw new ToolError("the checked-out branch has an invalid pull request URL");
	const repo = params.repo ?? parsed[1] ?? repoCtx.repo;
	const next = { ...params, repo, pr: parsed[2] };
	const args = firstArgs(buildGhArgs("pr_push", next, repoCtx));
	const data = await ghJson<GhPr>(args, cwd, signal);
	if (!data.headRefName || !data.headRepository?.nameWithOwner) {
		throw new ToolError("gh did not return the pull request push target");
	}
	const remoteUrl = data.headRepository.sshUrl ?? `https://github.com/${data.headRepository.nameWithOwner}.git`;
	const gitArgs = ["push"];
	if (params.forceWithLease) gitArgs.push("--force-with-lease");
	gitArgs.push(remoteUrl, `HEAD:refs/heads/${data.headRefName}`);
	await git(gitArgs, cwd, signal);
	return textResult(`Pushed HEAD to ${data.headRepository.nameWithOwner}:${data.headRefName}.`, {
		op: "pr_push",
		repo,
		branch,
		remoteBranch: data.headRefName,
		url: data.url,
	});
}

async function watch(params: GithubParams, repoCtx: GithubRepoContext, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	let watchCtx = repoCtx;
	if (params.branch && params.branch !== repoCtx.branch) {
		const slug = params.repo ?? repoCtx.repo;
		if (!slug) throw new ToolError("repo must not be empty");
		const branch = await ghJson<{ commit?: { sha?: string } }>(
			["api", "--method", "GET", `/repos/${slug}/branches/${encodeURIComponent(params.branch)}`],
			cwd,
			signal,
		);
		if (!branch.commit?.sha) throw new ToolError(`gh did not return the head of branch ${params.branch}`);
		watchCtx = { ...repoCtx, repo: slug, branch: params.branch, headSha: branch.commit.sha };
	}
	const first = firstArgs(buildGhArgs("run_watch", params, watchCtx));
	const repoIndex = first.indexOf("--repo");
	const repo = first.at(repoIndex + 1);
	if (!repo) throw new ToolError("repo must not be empty");
	if (params.tail !== undefined && (!Number.isFinite(params.tail) || params.tail <= 0)) {
		throw new ToolError("tail must be a positive number");
	}
	const tail = Math.min(Math.floor(params.tail ?? 40), 200);
	if (first[0] === "run" && first[1] === "view") {
		const runId = first[2];
		if (!runId) throw new ToolError("run must not be empty");
		return watchOne(runId, repo, tail, cwd, signal);
	}

	let completeIds = "";
	while (true) {
		const listed = await ghJson<GhRun[]>(first, cwd, signal);
		const runs: GhRun[] = [];
		for (const item of listed) {
			if (item.databaseId) runs.push(await ghJson<GhRun>(["run", "view", String(item.databaseId), "--repo", repo, "--json", RUN_FIELDS], cwd, signal));
		}
		const failedRun = runs.find(run => failed(run) || (run.jobs ?? []).some(failed));
		if (failedRun) return finishFailedRun(failedRun, repo, tail, cwd, signal);
		if (runs.length > 0 && runs.every(run => run.status === "completed")) {
			const ids = runs.map(run => run.databaseId).sort((a, b) => (a ?? 0) - (b ?? 0)).join(",");
			if (ids === completeIds) {
				const text = runs.map(run => formatRunWatch(run)).join("\n\n---\n\n");
				return textResult(text, { op: "run_watch", repo, state: "completed", runs });
			}
			completeIds = ids;
		} else {
			completeIds = "";
		}
		await scheduler.wait(POLL_MS, { signal });
	}
}

async function watchOne(runId: string, repo: string, tail: number, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	while (true) {
		const run = await ghJson<GhRun>(["run", "view", runId, "--repo", repo, "--json", RUN_FIELDS], cwd, signal);
		if (failed(run) || (run.jobs ?? []).some(failed)) return finishFailedRun(run, repo, tail, cwd, signal);
		if (run.status === "completed") return textResult(formatRunWatch(run), { op: "run_watch", repo, ...runDetails(run, "completed") });
		await scheduler.wait(POLL_MS, { signal });
	}
}

async function finishFailedRun(run: GhRun, repo: string, tail: number, cwd: string, signal?: AbortSignal): Promise<ToolResult> {
	const runId = String(run.databaseId ?? "");
	const output = await gh(["run", "view", runId, "--repo", repo, "--log-failed"], cwd, signal);
	const rows = output.stdout.replaceAll("\r\n", "\n").trimEnd().split("\n");
	const log = rows.slice(-tail).join("\n");
	return textResult(formatRunWatch(run, log), { op: "run_watch", repo, ...runDetails(run, "completed", log) });
}

function queryFromParams(params: GithubParams): string {
	const field = params.op === "search_commits" ? "committer-date" : params.op === "search_repos" && params.dateField === "updated" ? "pushed" : params.dateField ?? "created";
	return [params.query?.trim(), buildSearchDateQualifier(field, params.since, params.until)].filter(Boolean).join(" ");
}

function searchScope(params: GithubParams, repoCtx: GithubRepoContext, query: string): string | undefined {
	if (params.repo) return params.repo;
	if (/(?:^|\s)-?(?:repo|org|user|owner):\S/i.test(query)) return undefined;
	return repoCtx.repo;
}

async function getRepoContext(cwd: string, signal?: AbortSignal): Promise<GithubRepoContext> {
	const [remote, branch, head] = await Promise.all([
		gitStatus(["remote", "get-url", "origin"], cwd, signal),
		gitStatus(["branch", "--show-current"], cwd, signal),
		gitStatus(["rev-parse", "HEAD"], cwd, signal),
	]);
	return {
		repo: remote.code === 0 ? parseGithubRepo(remote.stdout) : undefined,
		branch: branch.code === 0 ? branch.stdout.trim() || undefined : undefined,
		headSha: head.code === 0 ? head.stdout.trim() || undefined : undefined,
	};
}

async function ghJson<T>(args: string[], cwd: string, signal?: AbortSignal): Promise<T> {
	const output = await gh(args, cwd, signal);
	try {
		const data: unknown = JSON.parse(output.stdout);
		// gh --json owns this command-specific boundary.
		return data as T;
	} catch {
		throw new ToolError("gh returned invalid JSON");
	}
}

async function gh(args: string[], cwd: string, signal?: AbortSignal): Promise<RunOutput> {
	try {
		return await run("gh", args, cwd, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			throw new ToolError("GitHub CLI is not installed. Install it from https://cli.github.com/.");
		}
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
		const first = stderr.trim().split("\n")[0] || (error instanceof Error ? error.message : "unknown error");
		throw new ToolError(first);
	}
}

async function git(args: string[], cwd: string, signal?: AbortSignal): Promise<RunOutput> {
	try {
		return await run("git", args, cwd, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
		throw new ToolError(stderr.trim().split("\n")[0] || (error instanceof Error ? error.message : "git failed"));
	}
}

async function gitStatus(args: string[], cwd: string, signal?: AbortSignal): Promise<RunOutput & { code: number }> {
	try {
		const output = await run("git", args, cwd, signal);
		return { ...output, code: 0 };
	} catch (error) {
		if (signal?.aborted) throw error;
		const stdout = error instanceof Error && "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
		const stderr = error instanceof Error && "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
		const code = error instanceof Error && "code" in error && typeof error.code === "number" ? error.code : 1;
		return { stdout, stderr, code };
	}
}

async function run(file: string, args: string[], cwd: string, signal?: AbortSignal): Promise<RunOutput> {
	const output = await exec(file, args, { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, signal });
	return { stdout: output.stdout, stderr: output.stderr };
}

function firstArgs(plan: string[][]): string[] {
	const args = plan[0];
	if (!args) throw new ToolError("GitHub operation did not produce a command");
	return args;
}

async function stat(file: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(file);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
