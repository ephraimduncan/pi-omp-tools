export interface GhUser {
	login?: string;
	name?: string;
}

export interface GhLabel {
	name?: string;
}

export interface GhFile {
	path?: string;
	additions?: number;
	deletions?: number;
	changeType?: string;
}

export interface GhComment {
	author?: GhUser;
	body?: string;
	createdAt?: string;
	url?: string;
}

export interface GhRepo {
	nameWithOwner?: string;
	description?: string;
	url?: string;
	defaultBranchRef?: { name?: string };
	homepageUrl?: string;
	forkCount?: number;
	isArchived?: boolean;
	isFork?: boolean;
	primaryLanguage?: { name?: string };
	repositoryTopics?: Array<{ name?: string; topic?: { name?: string } }>;
	stargazerCount?: number;
	updatedAt?: string;
	viewerPermission?: string;
	visibility?: string;
}

export interface GhIssue {
	author?: GhUser;
	body?: string;
	comments?: GhComment[];
	createdAt?: string;
	labels?: GhLabel[];
	number?: number;
	state?: string;
	stateReason?: string;
	title?: string;
	updatedAt?: string;
	url?: string;
}

export interface GhPr extends GhIssue {
	baseRefName?: string;
	files?: GhFile[];
	headRefName?: string;
	headRefOid?: string;
	headRepository?: { nameWithOwner?: string; sshUrl?: string; url?: string };
	isCrossRepository?: boolean;
	isDraft?: boolean;
	maintainerCanModify?: boolean;
	mergeStateStatus?: string;
	reviewDecision?: string;
	reviews?: Array<{ author?: GhUser; body?: string; state?: string; submittedAt?: string; url?: string }>;
}

export interface GhSearchItem {
	number?: number;
	title?: string;
	state?: string;
	html_url?: string;
	url?: string;
	repository_url?: string;
	repository?: { nameWithOwner?: string };
	user?: GhUser;
	author?: GhUser;
	labels?: GhLabel[];
	created_at?: string;
	updated_at?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface GhJob {
	conclusion?: string;
	databaseId?: number;
	name?: string;
	startedAt?: string;
	completedAt?: string;
	status?: string;
	url?: string;
}

export interface GhRun {
	conclusion?: string;
	databaseId?: number;
	displayTitle?: string;
	headBranch?: string;
	headSha?: string;
	jobs?: GhJob[];
	status?: string;
	url?: string;
	workflowName?: string;
}

export function formatRepoView(data: GhRepo): string {
	const lines = [`# ${data.nameWithOwner ?? "GitHub repository"}`, "", text(data.description) || "No description provided."];
	line(lines, "URL", data.url);
	line(lines, "Default branch", data.defaultBranchRef?.name);
	line(lines, "Visibility", data.visibility);
	line(lines, "Permission", data.viewerPermission);
	line(lines, "Language", data.primaryLanguage?.name);
	line(lines, "Stars", data.stargazerCount);
	line(lines, "Forks", data.forkCount);
	line(lines, "Archived", data.isArchived);
	line(lines, "Updated", data.updatedAt);
	line(lines, "Homepage", data.homepageUrl);
	const topics = data.repositoryTopics?.map(item => item.name ?? item.topic?.name).filter(Boolean).join(", ");
	line(lines, "Topics", topics);
	return lines.join("\n");
}

export function formatIssueView(data: GhIssue): string {
	const lines = [`# Issue #${data.number ?? "?"}: ${data.title ?? "Untitled"}`, ""];
	line(lines, "State", data.state);
	line(lines, "State reason", data.stateReason);
	line(lines, "Author", user(data.author));
	line(lines, "Labels", labels(data.labels));
	line(lines, "Created", data.createdAt);
	line(lines, "Updated", data.updatedAt);
	line(lines, "URL", data.url);
	lines.push("", "## Body", "", text(data.body) || "No description provided.");
	comments(lines, data.comments);
	return lines.join("\n").trim();
}

export function formatPrView(data: GhPr): string {
	const lines = [`# Pull request #${data.number ?? "?"}: ${data.title ?? "Untitled"}`, ""];
	line(lines, "State", data.state);
	line(lines, "Draft", data.isDraft);
	line(lines, "Author", user(data.author));
	line(lines, "Base", data.baseRefName);
	line(lines, "Head", data.headRefName);
	line(lines, "Review", data.reviewDecision);
	line(lines, "Merge state", data.mergeStateStatus);
	line(lines, "Labels", labels(data.labels));
	line(lines, "Created", data.createdAt);
	line(lines, "Updated", data.updatedAt);
	line(lines, "URL", data.url);
	lines.push("", "## Body", "", text(data.body) || "No description provided.");
	files(lines, data.files);
	if (data.reviews && data.reviews.length > 0) {
		lines.push("", `## Reviews (${data.reviews.length})`);
		for (const review of data.reviews) {
			lines.push("", `- ${user(review.author) ?? "Unknown"} [${review.state ?? "UNKNOWN"}]`);
			if (review.body) lines.push(indent(text(review.body)));
		}
	}
	comments(lines, data.comments);
	return lines.join("\n").trim();
}

export function formatPrDiffFiles(data: { files?: GhFile[]; url?: string }): string {
	const count = data.files?.length ?? 0;
	const lines = [`# Pull request files (${count})`];
	files(lines, data.files, false);
	line(lines, "URL", data.url);
	return lines.join("\n").trim();
}

export function formatSearchPrs(data: { items?: GhSearchItem[] }, query: string, repo?: string): string {
	const items = data.items ?? [];
	const lines = ["# GitHub pull request search", "", `Query: ${query}`];
	line(lines, "Repository", repo);
	line(lines, "Results", items.length);
	for (const item of items) {
		lines.push("", `- #${item.number ?? "?"} ${item.title ?? "Untitled"}`);
		line(lines, "  Repo", item.repository?.nameWithOwner ?? repoFromUrl(item.repository_url));
		line(lines, "  State", item.state);
		line(lines, "  Author", user(item.author ?? item.user));
		line(lines, "  Labels", labels(item.labels));
		line(lines, "  Created", item.createdAt ?? item.created_at);
		line(lines, "  Updated", item.updatedAt ?? item.updated_at);
		line(lines, "  URL", item.html_url ?? item.url);
	}
	if (items.length === 0) lines.push("", "No pull requests found.");
	return lines.join("\n").trim();
}

export function formatSearch(data: { items?: Array<Record<string, unknown>> }, kind: string, query: string): string {
	const items = data.items ?? [];
	const lines = [`# GitHub ${kind} search`, "", `Query: ${query}`, `Results: ${items.length}`];
	for (const item of items) {
		const title = string(item, "title") ?? string(item, "name") ?? string(item, "full_name") ?? string(item, "path") ?? "Untitled";
		const itemNumber = readNumber(item, "number");
		lines.push("", `- ${itemNumber === undefined ? "" : `#${itemNumber} `}${title}`);
		line(lines, "  State", string(item, "state"));
		line(lines, "  URL", string(item, "html_url") ?? string(item, "url"));
	}
	if (items.length === 0) lines.push("", "No results found.");
	return lines.join("\n").trim();
}

export function formatRunWatch(run: GhRun, failedLog?: string): string {
	const state = run.conclusion || run.status || "unknown";
	const lines = [`# ${run.workflowName ?? "GitHub Actions"}: ${state}`, ""];
	line(lines, "Run", run.databaseId);
	line(lines, "Title", run.displayTitle);
	line(lines, "Branch", run.headBranch);
	line(lines, "Commit", run.headSha?.slice(0, 12));
	line(lines, "URL", run.url);
	const jobs = run.jobs ?? [];
	if (jobs.length > 0) {
		lines.push("", `## Jobs (${jobs.length})`);
		for (const job of jobs) lines.push(`- ${job.name ?? `Job ${job.databaseId ?? "?"}`}: ${job.conclusion || job.status || "unknown"}`);
	}
	if (failedLog) lines.push("", "## Failed log", "", "```text", failedLog.trimEnd(), "```");
	return lines.join("\n").trim();
}

export function runDetails(run: GhRun, state: "watching" | "completed", failedLog?: string): Record<string, unknown> {
	return {
		state,
		runId: run.databaseId,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		headBranch: run.headBranch,
		headSha: run.headSha,
		status: run.status,
		conclusion: run.conclusion,
		url: run.url,
		jobs: run.jobs ?? [],
		failedJobs: (run.jobs ?? []).filter(job => failed(job)).map(job => job.name ?? String(job.databaseId ?? "unknown")),
		failedLog,
	};
}

export function failed(job: GhJob): boolean {
	return job.conclusion === "failure" || job.conclusion === "timed_out" || job.conclusion === "cancelled" || job.conclusion === "action_required";
}

function files(lines: string[], items: GhFile[] | undefined, heading: boolean = true): void {
	if (!items || items.length === 0) return;
	if (heading) lines.push("", `## Files (${items.length})`);
	for (const file of items) {
		lines.push(`- ${file.path ?? "(unknown file)"} [${file.changeType ?? "CHANGED"}] (+${file.additions ?? 0} -${file.deletions ?? 0})`);
	}
}

function comments(lines: string[], items: GhComment[] | undefined): void {
	if (!items || items.length === 0) return;
	lines.push("", `## Comments (${items.length})`);
	for (const item of items) {
		lines.push("", `### ${user(item.author) ?? "Unknown"}${item.createdAt ? ` · ${item.createdAt}` : ""}`, "", text(item.body) || "(No text)");
	}
}

function line(lines: string[], name: string, value: string | number | boolean | undefined): void {
	if (value !== undefined && value !== "") lines.push(`${name}: ${value}`);
}

function user(value: GhUser | undefined): string | undefined {
	if (value?.login) return `@${value.login}`;
	return value?.name;
}

function labels(value: GhLabel[] | undefined): string | undefined {
	const names = value?.map(item => item.name).filter((name): name is string => Boolean(name)) ?? [];
	return names.length > 0 ? names.join(", ") : undefined;
}

function repoFromUrl(value: string | undefined): string | undefined {
	const prefix = "https://api.github.com/repos/";
	return value?.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function text(value: string | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

function indent(value: string): string {
	return value.split("\n").map(row => `  ${row}`).join("\n");
}

function string(value: Record<string, unknown>, key: string): string | undefined {
	const found = value[key];
	return typeof found === "string" ? found : undefined;
}
function readNumber(value: Record<string, unknown>, key: string): number | undefined {
	const found = value[key];
	return typeof found === "number" ? found : undefined;
}
