import { Type } from "typebox";
import { ToolError, textResult, type PiApi, type ToolCtx, type ToolResult } from "../host.ts";
import { ensurePromptContract, registeredTools } from "../registry.ts";
import { loadRenderSupport, webSearchRenderers } from "../render.ts";

export const WEB_SEARCH_DESCRIPTION = `Searches the web for up-to-date information beyond knowledge cutoff.

<instruction>
- You SHOULD prefer primary sources (papers, official docs) and corroborate key claims with multiple sources
- You MUST include links for cited sources in the final response
- NEVER use for content whose URL you already know — read the URL directly instead
- \`query\` supports Google-style directives: \`site:\`/\`-site:\`, \`after:\`/\`before:\` (\`YYYY-MM-DD\`), \`inurl:\`, \`intitle:\`, \`filetype:\`, \`"exact phrase"\`, \`-term\`, \`OR\`.
</instruction>`;

export interface WebSearchParams {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	max_tokens?: number;
	temperature?: number;
	num_search_results?: number;
}

export interface SearchCitation {
	title: string;
	url: string;
	snippet?: string;
}

export interface SearchData {
	answer?: string;
	citations: SearchCitation[];
}

export interface SearchRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

export type WebSearchProvider = "exa" | "parallel";

export interface SelectedSearchProvider {
	provider: WebSearchProvider;
	apiKey: string;
}

const EXA_URL = "https://api.exa.ai/search";
const PARALLEL_URL = "https://api.parallel.ai/v1beta/search";
const PARALLEL_BETA = "search-extract-2025-10-10";
const TIMEOUT_MS = 60_000;
const PROVIDER_KEYS: Record<WebSearchProvider, string> = {
	exa: "EXA_API_KEY",
	parallel: "PARALLEL_API_KEY",
};

export async function executeWebSearch(
	params: WebSearchParams,
	_ctx?: ToolCtx,
	signal?: AbortSignal,
): Promise<ToolResult> {
	if (!params.query.trim()) throw new ToolError("Web search query must not be empty.");
	const selected = selectSearchProvider();
	const request =
		selected.provider === "exa"
			? buildExaRequest(params, selected.apiKey)
			: buildParallelRequest(params, selected.apiKey);
	const payload = await send(request, selected.provider, signal);
	const parsed = selected.provider === "exa" ? parseExaResponse(payload) : parseParallelResponse(payload);
	const limit = resultLimit(params);
	const citations = limit === undefined ? parsed.citations : parsed.citations.slice(0, limit);
	const output: string[] = [];
	if (parsed.answer) output.push(parsed.answer);
	if (citations.length > 0) {
		output.push(["Sources:", ...citations.map(citation => `- ${citation.title} — ${citation.url}`)].join("\n"));
	}
	if (output.length === 0) output.push("No web search results found.");
	return textResult(output.join("\n\n"), {
		provider: selected.provider,
		query: params.query,
		citations,
	});
}

export function selectSearchProvider(
	env: Readonly<Record<string, string | undefined>> = process.env,
): SelectedSearchProvider {
	const forced = env.OMP_TOOLS_SEARCH_PROVIDER?.trim().toLowerCase();
	if (forced) {
		if (!isProvider(forced)) {
			throw new ToolError("OMP_TOOLS_SEARCH_PROVIDER must be exa or parallel.");
		}
		const apiKey = readKey(env, PROVIDER_KEYS[forced]);
		if (!apiKey) throw new ToolError(`${providerLabel(forced)} web search requires ${PROVIDER_KEYS[forced]}.`);
		return { provider: forced, apiKey };
	}

	for (const provider of ["exa", "parallel"] as const) {
		const apiKey = readKey(env, PROVIDER_KEYS[provider]);
		if (apiKey) return { provider, apiKey };
	}
	throw new ToolError("Web search requires EXA_API_KEY or PARALLEL_API_KEY.");
}

export function buildExaRequest(params: WebSearchParams, apiKey: string, now = new Date()): SearchRequest {
	const query = parseQuery(params.query);
	const body: Record<string, unknown> = {
		query: query.text,
		numResults: resultLimit(params) ?? 10,
		type: "auto",
		contents: { summary: { query: query.text } },
	};
	if (query.include.length > 0) body.includeDomains = query.include;
	if (query.exclude.length > 0) body.excludeDomains = query.exclude;
	const after = query.after ?? (params.recency ? recencyDate(params.recency, now) : undefined);
	if (after) body.startPublishedDate = after;
	if (query.before) body.endPublishedDate = query.before;
	return {
		url: EXA_URL,
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body,
	};
}

export function buildParallelRequest(params: WebSearchParams, apiKey: string, now = new Date()): SearchRequest {
	const query = parseQuery(params.query);
	const policy: Record<string, unknown> = {};
	if (query.include.length > 0) policy.include_domains = query.include;
	else if (query.exclude.length > 0) policy.exclude_domains = query.exclude;
	const after = query.after ?? (params.recency ? recencyDate(params.recency, now) : undefined);
	if (after) policy.after_date = after;
	const body: Record<string, unknown> = {
		objective: query.text,
		search_queries: [query.text],
		mode: "fast",
		excerpts: { max_chars_per_result: 10_000 },
	};
	if (Object.keys(policy).length > 0) body.source_policy = policy;
	return {
		url: PARALLEL_URL,
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"parallel-beta": PARALLEL_BETA,
		},
		body,
	};
}

export function parseExaResponse(payload: unknown): SearchData {
	const root = asRecord(payload);
	if (!root) throw new ToolError("Exa returned an invalid response payload.");
	const results = objectList(root.results);
	const citations: SearchCitation[] = [];
	const summaries: string[] = [];
	for (const item of results) {
		const url = ownString(item, "url");
		if (!url) continue;
		const title = ownString(item, "title")?.trim() || url;
		const summary = ownString(item, "summary")?.trim();
		const text = ownString(item, "text")?.trim();
		const highlights = stringList(item.highlights);
		const snippet = summary || text || (highlights.length > 0 ? highlights.join(" ") : undefined);
		citations.push(snippet ? { title, url, snippet } : { title, url });
		if (summary && summaries.length < 3) summaries.push(`**${title}**: ${summary}`);
	}
	return {
		answer: summaries.length > 0 ? summaries.join("\n\n") : undefined,
		citations,
	};
}

export function parseParallelResponse(payload: unknown): SearchData {
	const root = asRecord(payload);
	if (!root) throw new ToolError("Parallel returned an invalid response payload.");
	const citations: SearchCitation[] = [];
	const summaries: string[] = [];
	for (const item of objectList(root.results)) {
		const url = ownString(item, "url");
		if (!url) continue;
		const title = ownString(item, "title")?.trim() || url;
		const excerpts = stringList(item.excerpts);
		const snippet = excerpts.length > 0 ? excerpts.join("\n\n") : undefined;
		citations.push(snippet ? { title, url, snippet } : { title, url });
		if (snippet && summaries.length < 3) summaries.push(`**${title}**: ${snippet}`);
	}
	return {
		answer: summaries.length > 0 ? summaries.join("\n\n") : undefined,
		citations,
	};
}

export async function registerWebSearch(pi: PiApi): Promise<void> {
	registeredTools.add("web_search");
	ensurePromptContract(pi);
	const support = await loadRenderSupport();
	pi.registerTool({
		...(support ? { renderShell: "self", ...webSearchRenderers(support) } : {}),
		name: "web_search",
		label: "Web Search",
		description: WEB_SEARCH_DESCRIPTION,
		promptSnippet: "Search the web for up-to-date information",
		promptGuidelines: ["Use web_search for post-cutoff information; read known URLs directly instead."],
		parameters: Type.Object({
			query: Type.String({ description: "search query; supports Google-style directives" }),
			recency: Type.Optional(
				Type.Union(
					[Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")],
					{ description: "only return results from this time window" },
				),
			),
			limit: Type.Optional(Type.Number({ description: "maximum number of sources to return" })),
			max_tokens: Type.Optional(Type.Number({ description: "maximum answer tokens for providers that support it" })),
			temperature: Type.Optional(Type.Number({ description: "answer sampling temperature for providers that support it" })),
			num_search_results: Type.Optional(Type.Number({ description: "number of search results to retrieve" })),
		}),
		async execute(
			_id: string,
			params: WebSearchParams,
			signal?: AbortSignal,
			_onUpdate?: unknown,
			ctx?: ToolCtx,
		) {
			return executeWebSearch(params, ctx, signal);
		},
	});
}

interface QueryParts {
	text: string;
	include: string[];
	exclude: string[];
	after?: string;
	before?: string;
}

function parseQuery(raw: string): QueryParts {
	const include = new Set<string>();
	const exclude = new Set<string>();
	const terms: string[] = [];
	let after: string | undefined;
	let before: string | undefined;
	let changed = false;
	for (const token of raw.match(/"(?:\\.|[^"])*"|\S+/g) ?? []) {
		const site = /^site:(.+)$/i.exec(token);
		const blocked = /^-site:(.+)$/i.exec(token);
		const afterMatch = /^after:(\d{4}-\d{2}-\d{2})$/i.exec(token);
		const beforeMatch = /^before:(\d{4}-\d{2}-\d{2})$/i.exec(token);
		if (site) {
			const host = cleanHost(site[1] ?? "");
			if (host) include.add(host);
			changed = true;
		} else if (blocked) {
			const host = cleanHost(blocked[1] ?? "");
			if (host) exclude.add(host);
			changed = true;
		} else if (afterMatch) {
			after = afterMatch[1];
			changed = true;
		} else if (beforeMatch) {
			before = beforeMatch[1];
			changed = true;
		} else {
			terms.push(token);
		}
	}
	return {
		text: changed ? terms.join(" ") : raw,
		include: [...include],
		exclude: [...exclude],
		after,
		before,
	};
}

function recencyDate(recency: NonNullable<WebSearchParams["recency"]>, now: Date): string {
	const date = new Date(now);
	switch (recency) {
		case "day":
			date.setUTCDate(date.getUTCDate() - 1);
			break;
		case "week":
			date.setUTCDate(date.getUTCDate() - 7);
			break;
		case "month":
			date.setUTCMonth(date.getUTCMonth() - 1);
			break;
		case "year":
			date.setUTCFullYear(date.getUTCFullYear() - 1);
			break;
	}
	return date.toISOString().slice(0, 10);
}

async function send(request: SearchRequest, provider: WebSearchProvider, signal?: AbortSignal): Promise<unknown> {
	const timedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
	const response = await fetch(request.url, {
		method: "POST",
		headers: request.headers,
		body: JSON.stringify(request.body),
		signal: timedSignal,
	});
	if (!response.ok) {
		const body = await response.text();
		throw new ToolError(`${providerLabel(provider)} API error (${response.status}): ${body}`);
	}
	try {
		return await response.json();
	} catch {
		throw new ToolError(`${providerLabel(provider)} returned invalid JSON.`);
	}
}

function resultLimit(params: WebSearchParams): number | undefined {
	const value = params.num_search_results ?? params.limit;
	if (value === undefined) return undefined;
	return Math.max(1, Math.floor(value));
}

function readKey(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
	const value = env[name]?.trim();
	return value || undefined;
}

function isProvider(value: string): value is WebSearchProvider {
	return value === "exa" || value === "parallel";
}

function providerLabel(provider: WebSearchProvider): string {
	if (provider === "exa") return "Exa";
	return "Parallel";
}

function cleanHost(value: string): string {
	const noScheme = value.replace(/^https?:\/\//i, "");
	const host = noScheme.split("/", 1)[0] ?? "";
	return host.replace(/^\*\./, "").replace(/\.$/, "").toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function ownString(value: Record<string, unknown>, key: string): string | undefined {
	const item = value[key];
	return typeof item === "string" ? item : undefined;
}

function objectList(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const records: Record<string, unknown>[] = [];
	for (const item of value) {
		const record = asRecord(item);
		if (record) records.push(record);
	}
	return records;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}
