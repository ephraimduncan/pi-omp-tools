import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildGhArgs,
	formatRepoView,
	formatRunWatch,
	formatSearchPrs,
	parseGithubRepo,
	parseSearchDateBound,
	type GithubParams,
	type GithubRepoContext,
} from "../packages/omp-tools-core/index.ts";

const repoCtx: GithubRepoContext = {
	repo: "acme/widgets",
	branch: "feature/fast",
	headSha: "0123456789abcdef0123456789abcdef01234567",
};
const now = new Date("2026-08-10T12:00:00Z");

function args(params: GithubParams): string[][] {
	return buildGhArgs(params.op, params, repoCtx, now);
}

test("github: builds repo and file reads", () => {
	const repo = args({ op: "repo_view", repo: "octo/project", branch: "main" })[0] as string[];
	assert.deepEqual(repo.slice(0, 5), ["repo", "view", "octo/project", "--branch", "main"]);
	assert.equal(repo.at(-2), "--json");

	assert.deepEqual(args({ op: "file_read", path: "docs/a b.md", branch: "next" })[0], [
		"api",
		"/repos/acme/widgets/contents/docs/a%20b.md",
		"--method",
		"GET",
		"-H",
		"Accept: application/vnd.github.raw+json",
		"-f",
		"ref=next",
	]);
});

test("github: builds issue, pull request, and diff views", () => {
	const issue = args({ op: "issue_view", pr: "12" })[0] as string[];
	assert.deepEqual(issue.slice(0, 5), ["issue", "view", "12", "--repo", "acme/widgets"]);
	assert.equal(issue.at(-2), "--json");

	const pr = args({ op: "pr_view", pr: "feature" })[0] as string[];
	assert.deepEqual(pr.slice(0, 5), ["pr", "view", "feature", "--repo", "acme/widgets"]);

	assert.deepEqual(args({ op: "pr_diff", pr: "9" })[0], [
		"pr",
		"view",
		"9",
		"--repo",
		"acme/widgets",
		"--json",
		"files,url",
	]);
	assert.deepEqual(args({ op: "pr_diff", pr: "9", path: "all" })[0], ["pr", "diff", "9", "--repo", "acme/widgets"]);
});

test("github: builds pull request create, checkout, and push operations", () => {
	assert.deepEqual(args({ op: "pr_create", fill: true, draft: true, base: "main" })[0], [
		"pr",
		"create",
		"--repo",
		"acme/widgets",
		"--fill",
		"--base",
		"main",
		"--head",
		"feature/fast",
		"--draft",
	]);

	assert.deepEqual(args({ op: "pr_create", title: "Ship it", body: "Body", reviewer: ["octocat"], label: ["ready"] })[0], [
		"pr",
		"create",
		"--repo",
		"acme/widgets",
		"--title",
		"Ship it",
		"--body",
		"Body",
		"--head",
		"feature/fast",
		"--reviewer",
		"octocat",
		"--label",
		"ready",
	]);

	const checkout = args({ op: "pr_checkout", pr: ["12", "https://github.com/else/tool/pull/4"], force: true });
	assert.equal(checkout.length, 2);
	assert.deepEqual(checkout[0]?.slice(0, 5), ["pr", "view", "12", "--repo", "acme/widgets"]);
	assert.deepEqual(checkout[1]?.slice(0, 3), ["pr", "view", "https://github.com/else/tool/pull/4"]);

	const push = args({ op: "pr_push", pr: "12", forceWithLease: true })[0] as string[];
	assert.deepEqual(push.slice(0, 5), ["pr", "view", "12", "--repo", "acme/widgets"]);
});

test("github: builds all search operations with scopes and dates", () => {
	assert.deepEqual(args({ op: "search_issues", query: "bug", since: "3d" })[0], [
		"api",
		"-X",
		"GET",
		"/search/issues",
		"-f",
		"q=bug created:>=2026-08-07 repo:acme/widgets is:issue",
		"-F",
		"per_page=10",
	]);
	assert.equal(
		args({ op: "search_prs", query: "review", until: "2w", dateField: "updated", limit: 25 })[0]?.at(5),
		"q=review updated:<=2026-07-27 repo:acme/widgets is:pr",
	);
	assert.equal(args({ op: "search_prs", query: "org:other review" })[0]?.at(5), "q=org:other review is:pr");
	assert.equal(args({ op: "search_code", query: "needle" })[0]?.at(5), "q=needle repo:acme/widgets");
	assert.equal(args({ op: "search_commits", since: "6mo" })[0]?.at(5), "q=committer-date:>=2026-02-10 repo:acme/widgets");
	assert.equal(
		args({ op: "search_repos", query: "language:go", since: "1y", dateField: "updated", repo: "ignored/repo" })[0]?.at(5),
		"q=language:go pushed:>=2025-08-10",
	);
});

test("github: parses relative and ISO date bounds", () => {
	assert.equal(parseSearchDateBound("3d", now), "2026-08-07");
	assert.equal(parseSearchDateBound("2w", now), "2026-07-27");
	assert.equal(parseSearchDateBound("6mo", now), "2026-02-10");
	assert.equal(parseSearchDateBound("2026-08-01", now), "2026-08-01");
	assert.equal(parseSearchDateBound("2026-08-01T04:05:06.789Z", now), "2026-08-01T04:05:06Z");
	assert.throws(() => parseSearchDateBound("3fortnights", now), /invalid date bound/);
	assert.throws(() => parseSearchDateBound("2026-02-30", now), /invalid date bound/);
});

test("github: builds run watch for a run or current HEAD", () => {
	const explicit = args({ op: "run_watch", run: "https://github.com/acme/widgets/actions/runs/42" })[0] as string[];
	assert.deepEqual(explicit.slice(0, 6), ["run", "view", "42", "--repo", "acme/widgets", "--json"]);
	assert.deepEqual(args({ op: "run_watch" })[0]?.slice(0, 9), [
		"run",
		"list",
		"--commit",
		repoCtx.headSha,
		"--repo",
		"acme/widgets",
		"--limit",
		"100",
		"--json",
	]);
});

test("github: formats repository and pull request search JSON", () => {
	const repo = formatRepoView({
		nameWithOwner: "acme/widgets",
		description: "Small widgets",
		url: "https://github.com/acme/widgets",
		defaultBranchRef: { name: "main" },
		homepageUrl: "https://widgets.example",
		forkCount: 3,
		isArchived: false,
		isFork: false,
		primaryLanguage: { name: "TypeScript" },
		repositoryTopics: [{ name: "widgets" }],
		stargazerCount: 17,
		updatedAt: "2026-08-09T12:00:00Z",
		viewerPermission: "WRITE",
		visibility: "PUBLIC",
	});
	assert.match(repo, /^# acme\/widgets/m);
	assert.match(repo, /Default branch: main/);
	assert.match(repo, /Stars: 17/);

	const search = formatSearchPrs({
		items: [{
			number: 8,
			title: "Tighten parser",
			state: "open",
			html_url: "https://github.com/acme/widgets/pull/8",
			url: "https://api.github.com/repos/acme/widgets/issues/8",
			repository_url: "https://api.github.com/repos/acme/widgets",
			repository: { nameWithOwner: "acme/widgets" },
			user: { login: "octocat" },
			author: { login: "octocat" },
			labels: [{ name: "parser" }],
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
			createdAt: "2026-08-01T00:00:00Z",
			updatedAt: "2026-08-02T00:00:00Z",
		}],
	}, "parser", "acme/widgets");
	assert.match(search, /#8 Tighten parser/);
	assert.match(search, /Repo: acme\/widgets/);
	assert.match(search, /Author: @octocat/);
});

test("github: formats in-progress and failed Actions runs", () => {
	const pending = formatRunWatch({
		databaseId: 44,
		workflowName: "CI",
		displayTitle: "Test change",
		status: "in_progress",
		conclusion: "",
		headBranch: "feature/fast",
		headSha: "0123456789abcdef",
		url: "https://github.com/acme/widgets/actions/runs/44",
		jobs: [{
			databaseId: 1,
			name: "test",
			status: "in_progress",
			conclusion: "",
			startedAt: "2026-08-10T12:00:00Z",
			completedAt: "",
			url: "https://github.com/acme/widgets/actions/runs/44/job/1",
		}],
	});
	assert.match(pending, /^# CI: in_progress/m);
	assert.match(pending, /test: in_progress/);

	const failed = formatRunWatch({
		databaseId: 44,
		workflowName: "CI",
		displayTitle: "Test change",
		status: "completed",
		conclusion: "failure",
		headBranch: "feature/fast",
		headSha: "0123456789abcdef",
		url: "https://github.com/acme/widgets/actions/runs/44",
		jobs: [{
			databaseId: 1,
			name: "test",
			status: "completed",
			conclusion: "failure",
			startedAt: "2026-08-10T12:00:00Z",
			completedAt: "2026-08-10T12:01:00Z",
			url: "https://github.com/acme/widgets/actions/runs/44/job/1",
		}],
	}, "line one\nline two");
	assert.match(failed, /^# CI: failure/m);
	assert.match(failed, /test: failure/);
	assert.match(failed, /## Failed log[\s\S]*line two/);
});

test("github: parses GitHub remote URLs", () => {
	assert.equal(parseGithubRepo("git@github.com:acme/widgets.git"), "acme/widgets");
	assert.equal(parseGithubRepo("https://github.com/acme/widgets.git"), "acme/widgets");
	assert.equal(parseGithubRepo("https://gitlab.com/acme/widgets.git"), undefined);
});
