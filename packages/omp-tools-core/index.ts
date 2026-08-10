/**
 * @ephraimduncan/omp-tools-core — shared implementation for the omp-tools
 * pi extension packages (read, write, edit, search, find, ast_grep, ast_edit).
 *
 * This package is a library, not a pi package: install one of the pi-*
 * wrappers (or the monorepo root) to get tools registered.
 */
export type { ContentPart, ImagePart, PiApi, TextPart, ToolCtx, ToolResult } from "./src/host.ts";
export { ToolError } from "./src/host.ts";
export {
	registerAll,
	registerAstEdit,
	registerAstGrep,
	registerEdit,
	registerFind,
	registerRead,
	registerSearch,
	registerWrite,
} from "./src/register.ts";
export { executeAstEdit } from "./src/tools/ast-edit.ts";
export { executeAstGrep } from "./src/tools/ast-grep.ts";
export { executeEdit } from "./src/tools/edit.ts";
export { executeFind } from "./src/tools/find.ts";
export { executeRead } from "./src/tools/read.ts";
export { executeSearch } from "./src/tools/search.ts";
export { executeWrite } from "./src/tools/write.ts";
export { computeFileTag, snapshots } from "./src/shared/snapshots.ts";
export {
	buildExaRequest,
	buildParallelRequest,
	executeWebSearch,
	parseExaResponse,
	parseParallelResponse,
	registerWebSearch,
	selectSearchProvider,
	WEB_SEARCH_DESCRIPTION,
	type SearchCitation,
	type SearchData,
	type SearchRequest,
	type SelectedSearchProvider,
	type WebSearchParams,
	type WebSearchProvider,
} from "./src/tools/web-search.ts";
export {
	buildAnthropicRequest,
	buildGeminiRequest,
	buildOpenAIRequest,
	executeInspectImage,
	extractAnthropicText,
	extractGeminiText,
	extractOpenAIText,
	fetchVision,
	INSPECT_IMAGE_DESCRIPTION,
	INSPECT_IMAGE_SYSTEM_PROMPT,
	MAX_IMAGE_INPUT_BYTES,
	registerInspectImage,
	sniffImageMimeType,
	type InspectImageParams,
	type VisionRequest,
} from "./src/tools/inspect-image.ts";
export {
	executeTodo,
	registerTodo,
	TODO_DESCRIPTION,
	type TodoOp,
	type TodoParams,
	type TodoPhase,
	type TodoStatus,
	type TodoTask,
} from "./src/tools/todo.ts";

export {
	buildGhArgs,
	buildSearchDateQualifier,
	executeGithub,
	formatRepoView,
	formatRunWatch,
	formatSearchPrs,
	GITHUB_DESCRIPTION,
	parseGithubRepo,
	parseSearchDateBound,
	registerGithub,
	type GithubOp,
	type GithubParams,
	type GithubRepoContext,
} from "./src/tools/github.ts";
export {
	BROWSER_DESCRIPTION,
	executeBrowser,
	registerBrowser,
	type BrowserParams,
} from "./src/tools/browser.ts";
export { runBrowserCode, type BrowserRunResult, type RunScope } from "./src/tools/browser-run.ts";
export { CdpClient, type CdpSocket, type CdpSocketFactory } from "./src/tools/browser-cdp.ts";
export { discoverBrowserExecutable, discoverObscuraExecutable } from "./src/tools/browser-launch.ts";
export {
	classifySelector,
	compactAxTree,
	formatAriaSnapshot,
	KEY_MAP,
	type AxNode,
	type Observation,
	type ObservationEntry,
} from "./src/tools/browser-tab.ts";