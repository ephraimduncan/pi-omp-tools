import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildExaRequest,
	buildParallelRequest,
	executeWebSearch,
	parseExaResponse,
	parseParallelResponse,
	selectSearchProvider,
	ToolError,
} from "../packages/omp-tools-core/index.ts";

const now = new Date("2026-08-10T12:00:00.000Z");

test("web_search: builds the Exa request with recency and result count", () => {
	const request = buildExaRequest(
		{ query: "test query", recency: "week", limit: 3, num_search_results: 5 },
		"exa-test-key",
		now,
	);

	assert.equal(request.url, "https://api.exa.ai/search");
	assert.deepEqual(request.headers, {
		"Content-Type": "application/json",
		"x-api-key": "exa-test-key",
	});
	assert.deepEqual(request.body, {
		query: "test query",
		numResults: 5,
		type: "auto",
		contents: { summary: { query: "test query" } },
		startPublishedDate: "2026-08-03",
	});
});

test("web_search: builds the Parallel request with its beta headers and recency policy", () => {
	const request = buildParallelRequest(
		{ query: "parallel query", recency: "month", limit: 4 },
		"parallel-test-key",
		now,
	);

	assert.equal(request.url, "https://api.parallel.ai/v1beta/search");
	assert.deepEqual(request.headers, {
		Accept: "application/json",
		"Content-Type": "application/json",
		"x-api-key": "parallel-test-key",
		"parallel-beta": "search-extract-2025-10-10",
	});
	assert.deepEqual(request.body, {
		objective: "parallel query",
		search_queries: ["parallel query"],
		mode: "fast",
		excerpts: { max_chars_per_result: 10_000 },
		source_policy: { after_date: "2026-07-10" },
	});
});

test("web_search: explicit after directive takes precedence over recency", () => {
	const exa = buildExaRequest(
		{ query: "release notes after:2025-06-01", recency: "day" },
		"key",
		now,
	);
	assert.equal(exa.body.query, "release notes");
	assert.equal(exa.body.startPublishedDate, "2025-06-01");

	const parallel = buildParallelRequest(
		{ query: "release notes after:2025-06-01", recency: "day" },
		"key",
		now,
	);
	assert.equal(parallel.body.objective, "release notes");
	assert.deepEqual(parallel.body.source_policy, { after_date: "2025-06-01" });
});

test("web_search: maps site and date directives to provider fields", () => {
	const exa = buildExaRequest(
		{ query: '"web api" site:docs.example.com -site:reddit.com/r/api before:2026-01-31' },
		"key",
		now,
	);
	assert.equal(exa.body.query, '"web api"');
	assert.deepEqual(exa.body.includeDomains, ["docs.example.com"]);
	assert.deepEqual(exa.body.excludeDomains, ["reddit.com"]);
	assert.equal(exa.body.endPublishedDate, "2026-01-31");

	const parallel = buildParallelRequest(
		{ query: '"web api" site:docs.example.com -site:reddit.com/r/api' },
		"key",
		now,
	);
	assert.equal(parallel.body.objective, '"web api"');
	assert.deepEqual(parallel.body.source_policy, { include_domains: ["docs.example.com"] });
});

test("web_search: parses Exa summaries and citations", () => {
	const parsed = parseExaResponse({
		requestId: "req-123",
		resolvedSearchType: "auto",
		results: [
			{
				title: "Page Alpha",
				url: "https://alpha.com",
				author: "Author A",
				publishedDate: "2024-06-01",
				text: "Full text of alpha",
				highlights: ["highlight alpha"],
				summary: "Alpha is about X.",
			},
			{
				title: "Page Beta",
				url: "https://beta.com",
				author: null,
				publishedDate: null,
				text: null,
				highlights: null,
				summary: "Beta covers Y.",
			},
		],
	});

	assert.equal(parsed.answer, "**Page Alpha**: Alpha is about X.\n\n**Page Beta**: Beta covers Y.");
	assert.deepEqual(parsed.citations, [
		{ title: "Page Alpha", url: "https://alpha.com", snippet: "Alpha is about X." },
		{ title: "Page Beta", url: "https://beta.com", snippet: "Beta covers Y." },
	]);
});

test("web_search: parses Parallel excerpts into a summary and citations", () => {
	const parsed = parseParallelResponse({
		search_id: "search-parallel-1",
		results: [
			{
				title: "Parallel result",
				url: "https://example.com/article",
				publish_date: "2025-01-01",
				excerpts: ["First excerpt", "Second excerpt"],
			},
		],
		warnings: null,
		usage: [{ name: "sku_search", count: 1 }],
	});

	assert.equal(parsed.answer, "**Parallel result**: First excerpt\n\nSecond excerpt");
	assert.deepEqual(parsed.citations, [
		{
			title: "Parallel result",
			url: "https://example.com/article",
			snippet: "First excerpt\n\nSecond excerpt",
		},
	]);
});

test("web_search: provider selection honors force and Exa-first fallback", () => {
	assert.deepEqual(
		selectSearchProvider({ EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key" }),
		{ provider: "exa", apiKey: "exa-key" },
	);
	assert.deepEqual(selectSearchProvider({ PARALLEL_API_KEY: "parallel-key" }), {
		provider: "parallel",
		apiKey: "parallel-key",
	});
	assert.deepEqual(
		selectSearchProvider({ OMP_TOOLS_SEARCH_PROVIDER: "parallel", PARALLEL_API_KEY: "parallel-key" }),
		{ provider: "parallel", apiKey: "parallel-key" },
	);
});

test("web_search: provider selection reports missing keys", () => {
	assert.throws(
		() => selectSearchProvider({}),
		(error: unknown) =>
			error instanceof ToolError && /EXA_API_KEY/.test(error.message) && /PARALLEL_API_KEY/.test(error.message),
	);
	assert.throws(
		() => selectSearchProvider({ OMP_TOOLS_SEARCH_PROVIDER: "exa", PARALLEL_API_KEY: "parallel-key" }),
		(error: unknown) => error instanceof ToolError && /EXA_API_KEY/.test(error.message),
	);
});

test("web_search: executes the selected provider and formats the tool result", async () => {
	const savedFetch = globalThis.fetch;
	const savedExaKey = process.env.EXA_API_KEY;
	const savedParallelKey = process.env.PARALLEL_API_KEY;
	const savedProvider = process.env.OMP_TOOLS_SEARCH_PROVIDER;
	process.env.EXA_API_KEY = "exa-test-key";
	delete process.env.PARALLEL_API_KEY;
	delete process.env.OMP_TOOLS_SEARCH_PROVIDER;
	globalThis.fetch = async () =>
		new Response(
			JSON.stringify({
				requestId: "req-live-path",
				results: [{ title: "Alpha", url: "https://alpha.example", summary: "Alpha summary." }],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);

	try {
		const result = await executeWebSearch({ query: "alpha" });
		assert.equal(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			"**Alpha**: Alpha summary.\n\nSources:\n- Alpha — https://alpha.example",
		);
		assert.deepEqual(result.details, {
			provider: "exa",
			query: "alpha",
			citations: [{ title: "Alpha", url: "https://alpha.example", snippet: "Alpha summary." }],
		});
	} finally {
		globalThis.fetch = savedFetch;
		if (savedExaKey === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = savedExaKey;
		if (savedParallelKey === undefined) delete process.env.PARALLEL_API_KEY;
		else process.env.PARALLEL_API_KEY = savedParallelKey;
		if (savedProvider === undefined) delete process.env.OMP_TOOLS_SEARCH_PROVIDER;
		else process.env.OMP_TOOLS_SEARCH_PROVIDER = savedProvider;
	}
});
