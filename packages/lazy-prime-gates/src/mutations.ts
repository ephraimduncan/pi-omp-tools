import { isRecord } from "./host.ts";

/** One file affected by a mutation tool call. */
export interface MutationChange {
	readonly path: string;
	readonly added: string;
	readonly role: "target" | "move";
}

const HASHLINE_HEADER = /^\[(.+)#([0-9A-Fa-f]{4})\]\s*$/gm;
const HASHLINE_MOVE = /^MV\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/gm;

/** Parse write, hashline edit, Prime edit, and ast_edit inputs into per-file changes. */
export function parseMutations(toolName: string, input: Record<string, unknown>): MutationChange[] {
	if (toolName === "write") return parseWrite(input);
	if (toolName === "edit") return parseEdit(input);
	if (toolName === "ast_edit") return parseAstEdit(input);
	return [];
}

function parseWrite(input: Record<string, unknown>): MutationChange[] {
	if (typeof input.path !== "string" || input.path.length === 0) return [];
	return [{ path: input.path, added: typeof input.content === "string" ? input.content : "", role: "target" }];
}

function parseEdit(input: Record<string, unknown>): MutationChange[] {
	if (typeof input.path === "string" && Array.isArray(input.edits)) {
		const added = input.edits
			.filter(isRecord)
			.map(edit => (typeof edit.newText === "string" ? edit.newText : ""))
			.join("\n");
		return input.path.length > 0 ? [{ path: input.path, added, role: "target" }] : [];
	}
	if (typeof input.input === "string") return parseHashline(input.input);
	return [];
}

function parseHashline(patch: string): MutationChange[] {
	const headers = [...patch.matchAll(HASHLINE_HEADER)];
	const changes: MutationChange[] = [];
	for (let index = 0; index < headers.length; index++) {
		const header = headers[index];
		const shownPath = header?.[1];
		const tag = header?.[2];
		if (!header || !shownPath || !tag) continue;
		const snapshot = uniqueSnapshot(tag);
		const targetPath = snapshot?.path ?? shownPath;
		const bodyStart = (header.index ?? 0) + header[0].length;
		const bodyEnd = headers[index + 1]?.index ?? patch.length;
		const body = patch.slice(bodyStart, bodyEnd);
		const added = body
			.split(/\r?\n/)
			.filter(line => line.startsWith("+"))
			.map(line => line.slice(1))
			.join("\n");
		changes.push({ path: targetPath, added, role: "target" });
		for (const move of body.matchAll(HASHLINE_MOVE)) {
			const destination = move[1] ?? move[2] ?? move[3];
			const moved = [snapshot?.text ?? "", added].filter(Boolean).join("\n");
			if (destination) changes.push({ path: destination, added: moved, role: "move" });
		}
	}
	return changes;
}

interface SnapshotRecord {
	readonly path: string;
	readonly text: string;
}

interface SnapshotLookup {
	findByHash(hash: string): SnapshotRecord[];
}

function uniqueSnapshot(tag: string): SnapshotRecord | undefined {
	const registry = globalThis as Record<PropertyKey, unknown>;
	const value = registry[Symbol.for("lazy-prime.snapshots.v1")] as Partial<SnapshotLookup> | undefined;
	if (typeof value?.findByHash !== "function") return undefined;
	const matches = value.findByHash(tag.toUpperCase());
	return matches.length === 1 ? matches[0] : undefined;
}

function parseAstEdit(input: Record<string, unknown>): MutationChange[] {
	if (input.apply !== true) return [];
	if (!Array.isArray(input.paths)) return [];
	const outputs = Array.isArray(input.ops)
		? input.ops
				.filter(isRecord)
				.map(operation => (typeof operation.out === "string" ? operation.out : ""))
				.join("\n")
		: "";
	return input.paths
		.filter((path): path is string => typeof path === "string" && path.length > 0)
		.map((path): MutationChange => ({ path, added: outputs, role: "target" }));
}
