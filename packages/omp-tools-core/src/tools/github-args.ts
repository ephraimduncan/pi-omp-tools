import { ToolError } from "../host.ts";

export type GithubOp =
	| "repo_view"
	| "file_read"
	| "issue_view"
	| "pr_view"
	| "pr_diff"
	| "pr_create"
	| "pr_checkout"
	| "pr_push"
	| "search_issues"
	| "search_prs"
	| "search_code"
	| "search_commits"
	| "search_repos"
	| "run_watch";

export interface GithubParams {
	op: GithubOp;
	repo?: string;
	path?: string;
	branch?: string;
	pr?: string | string[];
	run?: string;
	query?: string;
	since?: string;
	until?: string;
	dateField?: "created" | "updated";
	limit?: number;
	title?: string;
	body?: string;
	base?: string;
	head?: string;
	draft?: boolean;
	fill?: boolean;
	label?: string[];
	assignee?: string[];
	reviewer?: string[];
	force?: boolean;
	forceWithLease?: boolean;
	tail?: number;
}

export interface GithubRepoContext {
	repo?: string;
	branch?: string;
	headSha?: string;
}

export const REPO_FIELDS = [
	"nameWithOwner",
	"description",
	"url",
	"defaultBranchRef",
	"homepageUrl",
	"forkCount",
	"isArchived",
	"isFork",
	"primaryLanguage",
	"stargazerCount",
	"repositoryTopics",
	"updatedAt",
	"viewerPermission",
	"visibility",
].join(",");

export const ISSUE_FIELDS = [
	"author",
	"body",
	"comments",
	"createdAt",
	"labels",
	"number",
	"state",
	"stateReason",
	"title",
	"updatedAt",
	"url",
].join(",");

export const PR_FIELDS = [
	"author",
	"baseRefName",
	"body",
	"comments",
	"createdAt",
	"files",
	"headRefName",
	"headRepository",
	"isCrossRepository",
	"isDraft",
	"labels",
	"mergeStateStatus",
	"number",
	"reviews",
	"reviewDecision",
	"state",
	"title",
	"updatedAt",
	"url",
].join(",");

export const PR_CHECKOUT_FIELDS = [
	"baseRefName",
	"headRefName",
	"headRefOid",
	"headRepository",
	"headRepositoryOwner",
	"isCrossRepository",
	"maintainerCanModify",
	"number",
	"title",
	"url",
].join(",");

export const RUN_FIELDS = [
	"conclusion",
	"databaseId",
	"displayTitle",
	"headBranch",
	"headSha",
	"jobs",
	"status",
	"url",
	"workflowName",
].join(",");

const RUN_LIST_FIELDS = [
	"conclusion",
	"databaseId",
	"displayTitle",
	"headBranch",
	"headSha",
	"status",
	"url",
	"workflowName",
].join(",");

const RELATIVE_DATE = /^(\d+)\s*(m|h|d|w|mo|y)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_SCOPE = /(?:^|\s)-?(?:repo|org|user|owner):\S/i;
const RUN_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;

const FIXED_MS: Record<string, number> = {
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
	w: 7 * 86_400_000,
};

export function buildGhArgs(
	op: GithubOp,
	params: GithubParams,
	repoCtx: GithubRepoContext = {},
	now: Date = new Date(),
): string[][] {
	const explicitRepo = clean(params.repo);
	const repo = explicitRepo ?? repoCtx.repo;

	switch (op) {
		case "repo_view": {
			const args = ["repo", "view"];
			if (explicitRepo) args.push(explicitRepo);
			if (params.branch) args.push("--branch", params.branch);
			args.push("--json", REPO_FIELDS);
			return [args];
		}
		case "file_read": {
			const slug = need(repo, "repo");
			const file = need(params.path, "path");
			if (file.startsWith("/")) throw new ToolError("path must be repository-relative");
			const encoded = file.split("/").map(encodeURIComponent).join("/");
			const args = [
				"api",
				`/repos/${slug}/contents/${encoded}`,
				"--method",
				"GET",
				"-H",
				"Accept: application/vnd.github.raw+json",
			];
			if (params.branch) args.push("-f", `ref=${params.branch}`);
			return [args];
		}
		case "issue_view": {
			const refs = refsOf(params.pr);
			const issue = refs.at(0);
			if (!issue || refs.length !== 1) throw new ToolError("issue number or URL is required");
			const args = ["issue", "view", issue];
			appendRepo(args, repo, issue);
			args.push("--json", ISSUE_FIELDS);
			return [args];
		}
		case "pr_view": {
			const pull = optionalRef(params.pr);
			const args = ["pr", "view"];
			if (pull) args.push(pull);
			appendRepo(args, repo, pull);
			args.push("--json", PR_FIELDS);
			return [args];
		}
		case "pr_diff": {
			const pull = optionalRef(params.pr);
			const args = params.path === "all" ? ["pr", "diff"] : ["pr", "view"];
			if (pull) args.push(pull);
			appendRepo(args, repo, pull);
			if (params.path !== "all") args.push("--json", "files,url");
			return [args];
		}
		case "pr_create":
			return [buildPrCreateArgs(params, repoCtx)];
		case "pr_checkout": {
			const refs = refsOf(params.pr);
			const pulls = refs.length > 0 ? refs : [undefined];
			return pulls.map(pull => {
				const args = ["pr", "view"];
				if (pull) args.push(pull);
				appendRepo(args, repo, pull);
				args.push("--json", PR_CHECKOUT_FIELDS);
				return args;
			});
		}
		case "pr_push": {
			const pull = optionalRef(params.pr);
			const args = ["pr", "view"];
			if (pull) args.push(pull);
			appendRepo(args, repo, pull);
			args.push("--json", PR_CHECKOUT_FIELDS);
			return [args];
		}
		case "search_issues":
			return [buildSearchArgs("issues", params, repoCtx, now, "is:issue")];
		case "search_prs":
			return [buildSearchArgs("issues", params, repoCtx, now, "is:pr")];
		case "search_code": {
			if (clean(params.since) || clean(params.until)) {
				throw new ToolError("search_code does not support since/until");
			}
			const query = need(params.query, "query");
			const scope = searchRepo(params, repoCtx, query);
			const fullQuery = joinQuery(query, scope ? `repo:${scope}` : undefined);
			return [[
				"api",
				"-X",
				"GET",
				"/search/code",
				"-f",
				`q=${fullQuery}`,
				"-F",
				`per_page=${limitOf(params.limit)}`,
				"-H",
				"Accept: application/vnd.github.text-match+json",
			]];
		}
		case "search_commits":
			return [buildSearchArgs("commits", params, repoCtx, now)];
		case "search_repos":
			return [buildSearchArgs("repositories", params, {}, now)];
		case "run_watch": {
			const run = parseRun(params.run);
			const slug = need(explicitRepo ?? run.repo ?? repoCtx.repo, "repo");
			if (explicitRepo && run.repo && explicitRepo.toLowerCase() !== run.repo.toLowerCase()) {
				throw new ToolError("run URL repository does not match the provided repo");
			}
			if (run.id) return [["run", "view", run.id, "--repo", slug, "--json", RUN_FIELDS]];
			const headSha = need(repoCtx.headSha, "current git HEAD");
			return [[
				"run",
				"list",
				"--commit",
				headSha,
				"--repo",
				slug,
				"--limit",
				"100",
				"--json",
				RUN_LIST_FIELDS,
			]];
		}
	}
}

export function parseSearchDateBound(raw: string, now: Date = new Date()): string {
	const value = raw.trim();
	if (!value) throw new ToolError("date bound must not be empty");
	const relative = RELATIVE_DATE.exec(value);
	if (relative) {
		const count = Number(relative[1]);
		const unit = (relative[2] ?? "").toLowerCase();
		const fixed = FIXED_MS[unit];
		if (fixed !== undefined) return new Date(now.getTime() - count * fixed).toISOString().slice(0, 10);
		const date = new Date(now);
		if (unit === "mo") date.setUTCMonth(date.getUTCMonth() - count);
		else date.setUTCFullYear(date.getUTCFullYear() - count);
		return date.toISOString().slice(0, 10);
	}
	if (ISO_DATE.test(value)) {
		const parsed = new Date(`${value}T00:00:00Z`);
		if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value) return value;
		throw new ToolError(`invalid date bound: ${raw}`);
	}
	const parsed = Date.parse(value);
	if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().replace(/\.\d{3}Z$/, "Z");
	throw new ToolError(`invalid date bound: ${raw}`);
}

export function buildSearchDateQualifier(
	field: string,
	since: string | undefined,
	until: string | undefined,
	now: Date = new Date(),
): string | undefined {
	const start = clean(since);
	const end = clean(until);
	const from = start ? parseSearchDateBound(start, now) : undefined;
	const to = end ? parseSearchDateBound(end, now) : undefined;
	if (from && to) return `${field}:${from}..${to}`;
	if (from) return `${field}:>=${from}`;
	if (to) return `${field}:<=${to}`;
	return undefined;
}

function buildPrCreateArgs(params: GithubParams, repoCtx: GithubRepoContext): string[] {
	const title = clean(params.title);
	const fill = params.fill === true;
	if (!fill && !title) throw new ToolError("title is required unless fill is true");
	if (fill && (title || params.body !== undefined)) {
		throw new ToolError("fill is mutually exclusive with title and body");
	}
	const args = ["pr", "create"];
	appendRepo(args, clean(params.repo) ?? repoCtx.repo);
	if (fill) args.push("--fill");
	else args.push("--title", need(title, "title"), "--body", params.body ?? "");
	if (params.base) args.push("--base", params.base);
	const head = clean(params.head) ?? repoCtx.branch;
	if (head) args.push("--head", head);
	if (params.draft) args.push("--draft");
	for (const reviewer of params.reviewer ?? []) args.push("--reviewer", reviewer);
	for (const assignee of params.assignee ?? []) args.push("--assignee", assignee);
	for (const label of params.label ?? []) args.push("--label", label);
	return args;
}

function buildSearchArgs(
	endpoint: "issues" | "commits" | "repositories",
	params: GithubParams,
	repoCtx: GithubRepoContext,
	now: Date,
	typeFilter?: string,
): string[] {
	const command = endpoint === "repositories" ? "repos" : endpoint;
	const requested = params.dateField ?? "created";
	const field = endpoint === "commits" ? "committer-date" : command === "repos" && requested === "updated" ? "pushed" : requested;
	const dates = buildSearchDateQualifier(field, params.since, params.until, now);
	const query = joinQuery(params.query, dates);
	if (!query) throw new ToolError("query is required (or pass since/until to filter by date)");
	const scope = endpoint === "repositories" ? undefined : searchRepo(params, repoCtx, query);
	const fullQuery = joinQuery(query, scope ? `repo:${scope}` : undefined, typeFilter);
	return ["api", "-X", "GET", `/search/${endpoint}`, "-f", `q=${fullQuery}`, "-F", `per_page=${limitOf(params.limit)}`];
}

function searchRepo(params: GithubParams, repoCtx: GithubRepoContext, query: string): string | undefined {
	const explicit = clean(params.repo);
	if (explicit) return explicit;
	if (SEARCH_SCOPE.test(query)) return undefined;
	return repoCtx.repo;
}

function parseRun(value: string | undefined): { id?: string; repo?: string } {
	const run = clean(value);
	if (!run) return {};
	const url = RUN_URL.exec(run);
	if (url) return { repo: url[1], id: url[2] };
	if (!/^\d+$/.test(run) || Number(run) <= 0) throw new ToolError("run must be a positive run ID or GitHub Actions run URL");
	return { id: run };
}

function limitOf(value: number | undefined): number {
	if (value === undefined) return 10;
	if (!Number.isFinite(value) || value <= 0) throw new ToolError("limit must be a positive number");
	return Math.min(Math.floor(value), 50);
}

function refsOf(value: string | string[] | undefined): string[] {
	const values = value === undefined ? [] : typeof value === "string" ? [value] : value;
	return values.map(clean).filter((item): item is string => item !== undefined);
}

function optionalRef(value: string | string[] | undefined): string | undefined {
	const refs = refsOf(value);
	if (refs.length > 1) throw new ToolError("pr accepts one value for this operation");
	return refs[0];
}

function appendRepo(args: string[], repo: string | undefined, identifier?: string): void {
	if (repo && !identifier?.startsWith("https://github.com/")) args.push("--repo", repo);
}

function joinQuery(...parts: Array<string | undefined>): string {
	return parts.map(clean).filter((part): part is string => part !== undefined).join(" ");
}

function need(value: string | undefined, label: string): string {
	const found = clean(value);
	if (!found) throw new ToolError(`${label} must not be empty`);
	return found;
}

function clean(value: string | undefined): string | undefined {
	const found = value?.trim();
	return found || undefined;
}
