/**
 * Shared ast-grep language plumbing: extension -> language mapping, builtin
 * napi languages, and lazy registration of optional `@ast-grep/lang-*`
 * dynamic grammars.
 */
import * as path from "node:path";

// biome-ignore lint/suspicious/noExplicitAny: napi module is loaded dynamically
type NapiModule = any;

let napiPromise: Promise<NapiModule | null> | undefined;

export function loadNapi(): Promise<NapiModule | null> {
	napiPromise ??= import("@ast-grep/napi").then(
		mod => mod,
		() => null,
	);
	return napiPromise;
}

/** Optional dynamic grammars; registered lazily on first use. */
const DYNAMIC_LANGS: Record<string, string> = {
	python: "@ast-grep/lang-python",
	rust: "@ast-grep/lang-rust",
	go: "@ast-grep/lang-go",
	java: "@ast-grep/lang-java",
	c: "@ast-grep/lang-c",
	cpp: "@ast-grep/lang-cpp",
	json: "@ast-grep/lang-json",
	yaml: "@ast-grep/lang-yaml",
};

const EXT_TO_LANG: Record<string, string> = {
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".css": "css",
	".html": "html",
	".htm": "html",
	".py": "python",
	".pyi": "python",
	".rs": "rust",
	".go": "go",
	".java": "java",
	".c": "c",
	".h": "c",
	".cc": "cpp",
	".cpp": "cpp",
	".cxx": "cpp",
	".hpp": "cpp",
	".hh": "cpp",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
};

export function langForFile(filePath: string): string | undefined {
	return EXT_TO_LANG[path.extname(filePath).toLowerCase()];
}

const registered = new Map<string, Promise<boolean>>();

/**
 * Resolve `lang` to something nap`parse()` accepts: a builtin Lang value or a
 * registered dynamic language name. Returns null when unavailable.
 */
export async function resolveLang(lang: string): Promise<unknown | null> {
	const napi = await loadNapi();
	if (!napi) return null;
	const builtin: Record<string, unknown> = {
		javascript: napi.Lang.JavaScript,
		typescript: napi.Lang.TypeScript,
		tsx: napi.Lang.Tsx,
		css: napi.Lang.Css,
		html: napi.Lang.Html,
	};
	if (builtin[lang] !== undefined) return builtin[lang];
	const pkg = DYNAMIC_LANGS[lang];
	if (!pkg) return null;
	let pending = registered.get(lang);
	if (!pending) {
		pending = (async () => {
			try {
				const mod = (await import(pkg)) as { default?: unknown };
				const grammar = mod.default ?? mod;
				napi.registerDynamicLanguage({ [lang]: grammar });
				return true;
			} catch {
				return false;
			}
		})();
		registered.set(lang, pending);
	}
	return (await pending) ? lang : null;
}

export function knownLangNames(): string[] {
	return ["javascript", "typescript", "tsx", "css", "html", ...Object.keys(DYNAMIC_LANGS)];
}
