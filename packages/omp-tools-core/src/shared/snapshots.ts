/**
 * Session snapshot store binding hashline section tags to the exact file
 * content that minted them (lean port of omp's SnapshotStore).
 *
 * A tag is a 4-hex content hash of the whole normalized file text. Any read of
 * byte-identical content mints the same tag; an edit anchored at any line
 * validates while the live file still hashes to it. On mismatch, the recorded
 * snapshot for the stale tag drives line-remap recovery.
 */

const TAG_LEN = 4;
const MAX_PATHS = 50;
const MAX_VERSIONS_PER_PATH = 6;

export interface Snapshot {
	path: string;
	text: string;
	hash: string;
	recordedAt: number;
}

/** Trim trailing [ \t\r] from every line so CRLF/display trims don't shift tags. */
function normalizeForHash(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}

/** FNV-1a 32-bit, folded to 16 bits, rendered as 4 uppercase hex chars. */
export function computeFileTag(text: string): string {
	const normalized = normalizeForHash(text);
	let hash = 0x811c9dc5;
	for (let i = 0; i < normalized.length; i++) {
		hash ^= normalized.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	hash = hash >>> 0;
	const low16 = (hash ^ (hash >>> 16)) & 0xffff;
	return low16.toString(16).padStart(TAG_LEN, "0").toUpperCase();
}

export class SnapshotStore {
	#versions = new Map<string, Snapshot[]>();

	head(path: string): Snapshot | null {
		return this.#versions.get(path)?.[0] ?? null;
	}

	byHash(path: string, hash: string): Snapshot | null {
		return this.#versions.get(path)?.find(v => v.hash === hash) ?? null;
	}

	/** Any retained snapshot with this tag across paths (path-typo recovery). */
	findByHash(hash: string): Snapshot[] {
		const out: Snapshot[] = [];
		for (const history of this.#versions.values()) {
			for (const v of history) if (v.hash === hash) out.push(v);
		}
		return out;
	}

	record(path: string, text: string): string {
		const hash = computeFileTag(text);
		const history = this.#versions.get(path) ?? [];
		const existing = history.find(v => v.hash === hash && v.text === text);
		if (existing) {
			existing.recordedAt = Date.now();
			if (history[0] !== existing) {
				this.#versions.set(path, [existing, ...history.filter(v => v !== existing)]);
			}
			this.#touch(path);
			return hash;
		}
		const snapshot: Snapshot = { path, text, hash, recordedAt: Date.now() };
		this.#versions.set(path, [snapshot, ...history].slice(0, MAX_VERSIONS_PER_PATH));
		this.#touch(path);
		return hash;
	}

	invalidate(path: string): void {
		this.#versions.delete(path);
	}

	relocate(from: string, to: string): void {
		const history = this.#versions.get(from);
		if (!history || history.length === 0) return;
		const moved = history.map(v => ({ ...v, path: to }));
		const dest = this.#versions.get(to) ?? [];
		const seen = new Set<string>();
		const merged: Snapshot[] = [];
		for (const v of [...moved, ...dest]) {
			if (seen.has(v.hash)) continue;
			seen.add(v.hash);
			merged.push(v);
		}
		this.#versions.set(to, merged.slice(0, MAX_VERSIONS_PER_PATH));
		this.#versions.delete(from);
	}

	/** Simple LRU: re-insert at the back of Map iteration order; evict oldest. */
	#touch(path: string): void {
		const history = this.#versions.get(path);
		if (history) {
			this.#versions.delete(path);
			this.#versions.set(path, history);
		}
		while (this.#versions.size > MAX_PATHS) {
			const oldest = this.#versions.keys().next().value;
			if (oldest === undefined) break;
			this.#versions.delete(oldest);
		}
	}
}

/**
 * One store per agent process. Anchored on `globalThis` so the read/search/
 * write/edit tools share tags even when installed as separate pi packages
 * (hosts load packages with separate module roots, but one JS process).
 */
const SNAPSHOT_KEY = Symbol.for("omp-tools.snapshots.v1");
const globalRegistry = globalThis as Record<PropertyKey, unknown>;
globalRegistry[SNAPSHOT_KEY] ??= new SnapshotStore();
export const snapshots = globalRegistry[SNAPSHOT_KEY] as SnapshotStore;
