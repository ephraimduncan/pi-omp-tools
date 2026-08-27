import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Names of review guides bundled with the gate extension. */
export type GuideName =
	| "simplify"
	| "writing-better-tests"
	| "pr-description-writing"
	| "ste100-writing"
	| "ste100-wordlist"
	| "no-use-effect";

const GUIDE_FILES: Record<GuideName, string> = {
	"simplify": "simplify.md",
	"writing-better-tests": "writing-better-tests.md",
	"pr-description-writing": "pr-description-writing.md",
	"ste100-writing": "ste100-writing.md",
	"ste100-wordlist": "ste100-wordlist.md",
	"no-use-effect": "no-use-effect.md",
};

const GUIDE_TITLES: Record<GuideName, string> = {
	"simplify": "Simplify",
	"writing-better-tests": "Writing Better Tests",
	"pr-description-writing": "PR Description Writing",
	"ste100-writing": "STE-100 Writing Standard",
	"ste100-wordlist": "STE-100 Dictionary",
	"no-use-effect": "No Direct useEffect",
};

const cache = new Map<GuideName, string>();


/** Return the absolute installed path for one bundled guide. */
export function guidePath(name: GuideName): string {
	return fileURLToPath(new URL(`../guides/${GUIDE_FILES[name]}`, import.meta.url));
}
/** Load one guide from this installed package. */
export function guideText(name: GuideName): string {
	const cached = cache.get(name);
	if (cached !== undefined) return cached;
	const text = fs.readFileSync(guidePath(name), "utf8");
	cache.set(name, text);
	return text;
}

/** Return the heading used when a guide is injected into a review block. */
export function guideTitle(name: GuideName): string {
	return GUIDE_TITLES[name];
}
