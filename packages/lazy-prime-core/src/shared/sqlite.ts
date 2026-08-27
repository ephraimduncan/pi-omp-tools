/**
 * SQLite adapter: prefers `node:sqlite` (Node >= 22.5), falls back to
 * `bun:sqlite` (Bun), then the `sqlite3` CLI.
 */
import { hasBinary, run } from "./util.ts";

export type Row = Record<string, unknown>;

export interface SqliteDriver {
	name: string;
	query(dbPath: string, sql: string, params?: unknown[]): Promise<Row[]>;
	exec(dbPath: string, sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

async function loadNodeSqlite(): Promise<SqliteDriver | null> {
	try {
		const mod = (await import("node:sqlite")) as unknown as {
			DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
				prepare(sql: string): {
					all(...params: unknown[]): Row[];
					run(...params: unknown[]): { changes: number | bigint };
				};
				close(): void;
			};
		};
		return {
			name: "node:sqlite",
			async query(dbPath, sql, params = []) {
				const db = new mod.DatabaseSync(dbPath, { readOnly: true });
				try {
					return db.prepare(sql).all(...params);
				} finally {
					db.close();
				}
			},
			async exec(dbPath, sql, params = []) {
				const db = new mod.DatabaseSync(dbPath);
				try {
					const info = db.prepare(sql).run(...params);
					return { changes: Number(info.changes) };
				} finally {
					db.close();
				}
			},
		};
	} catch {
		return null;
	}
}

async function loadBunSqlite(): Promise<SqliteDriver | null> {
	try {
		const mod = (await import("bun:sqlite" as string)) as unknown as {
			Database: new (path: string, opts?: { readonly?: boolean }) => {
				query(sql: string): { all(...params: unknown[]): Row[] };
				prepare(sql: string): { run(...params: unknown[]): void };
				close(): void;
			};
		};
		return {
			name: "bun:sqlite",
			async query(dbPath, sql, params = []) {
				const db = new mod.Database(dbPath, { readonly: true });
				try {
					return db.query(sql).all(...params);
				} finally {
					db.close();
				}
			},
			async exec(dbPath, sql, params = []) {
				const db = new mod.Database(dbPath);
				try {
					db.prepare(sql).run(...params);
					return { changes: 1 };
				} finally {
					db.close();
				}
			},
		};
	} catch {
		return null;
	}
}

function sqlQuoteLiteral(value: unknown): string {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	if (typeof value === "boolean") return value ? "1" : "0";
	return `'${String(value).replace(/'/g, "''")}'`;
}

/** Inline params for the CLI driver (used only when no native driver exists). */
function inlineParams(sql: string, params: unknown[]): string {
	let index = 0;
	return sql.replace(/\?/g, () => sqlQuoteLiteral(params[index++]));
}

async function loadCliSqlite(): Promise<SqliteDriver | null> {
	if (!(await hasBinary("sqlite3"))) return null;
	return {
		name: "sqlite3-cli",
		async query(dbPath, sql, params = []) {
			const result = await run("sqlite3", ["-json", "-readonly", dbPath, inlineParams(sql, params)]);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `sqlite3 exited ${result.code}`);
			const trimmed = result.stdout.trim();
			if (!trimmed) return [];
			return JSON.parse(trimmed) as Row[];
		},
		async exec(dbPath, sql, params = []) {
			const result = await run("sqlite3", [dbPath, inlineParams(sql, params)]);
			if (result.code !== 0) throw new Error(result.stderr.trim() || `sqlite3 exited ${result.code}`);
			return { changes: 1 };
		},
	};
}

let driverPromise: Promise<SqliteDriver | null> | undefined;

export function sqliteDriver(): Promise<SqliteDriver | null> {
	driverPromise ??= (async () => (await loadNodeSqlite()) ?? (await loadBunSqlite()) ?? (await loadCliSqlite()))();
	return driverPromise;
}

export function assertSafeIdentifier(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
		throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
	}
	return name;
}

export function assertReadonlySql(sql: string): string {
	const head = sql.trim().slice(0, 12).toUpperCase();
	if (!head.startsWith("SELECT") && !head.startsWith("WITH") && !head.startsWith("PRAGMA") && !head.startsWith("EXPLAIN")) {
		throw new Error("Only SELECT/WITH/PRAGMA/EXPLAIN queries are allowed via ?q=");
	}
	return sql;
}
