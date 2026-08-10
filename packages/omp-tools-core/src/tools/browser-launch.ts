import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "../host.ts";
import { deferred } from "./browser-cdp.ts";

export interface BrowserProcess {
	child: ChildProcess;
	profileDir?: string;
	close(kill?: boolean): Promise<void>;
}

export interface LaunchOptions {
	path?: string;
	args?: string[];
	viewport?: { width: number; height: number };
	timeoutMs?: number;
	signal?: AbortSignal;
}

const MAC_APPS = [
	"Google Chrome.app/Contents/MacOS/Google Chrome",
	"Chromium.app/Contents/MacOS/Chromium",
	"Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"Brave Browser.app/Contents/MacOS/Brave Browser",
	"Arc.app/Contents/MacOS/Arc",
];

const LINUX_NAMES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge", "brave-browser"];

export async function discoverBrowserExecutable(): Promise<string | undefined> {
	for (const key of ["OMP_TOOLS_BROWSER", "CHROME_PATH"]) {
		const file = process.env[key]?.trim();
		if (file && isExecutable(file)) return file;
	}
	for (const file of browserCandidates()) {
		if (isExecutable(file)) return file;
	}
	return undefined;
}

/** Finds the Obscura executable. */
export async function discoverObscuraExecutable(): Promise<string | undefined> {
	const forced = process.env.OBSCURA_PATH?.trim();
	if (forced && isExecutable(forced)) return forced;
	const name = process.platform === "win32" ? "obscura.exe" : "obscura";
	const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
	const found = probe.status === 0 ? probe.stdout.trim().split("\n")[0]?.trim() : "";
	if (found && isExecutable(found)) return found;
	for (const dir of [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin"]) {
		const file = path.join(dir, name);
		if (isExecutable(file)) return file;
	}
	return undefined;
}

export async function launchBrowser(options: LaunchOptions = {}): Promise<{ process: BrowserProcess; wsUrl: string }> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const engine = process.env.OMP_TOOLS_BROWSER_ENGINE?.trim().toLowerCase();
	const file = options.path ? path.resolve(options.path) : undefined;
	if (file && !isExecutable(file)) throw new ToolError(`Browser executable not found: ${file}`);
	if (file && isObscura(file)) {
		return launchObscura(file, options.args, timeoutMs, options.signal);
	}
	if (!file && engine !== "chrome") {
		const obscura = await discoverObscuraExecutable();
		if (obscura) return launchObscura(obscura, options.args, timeoutMs, options.signal);
		if (engine === "obscura") {
			throw new ToolError("Obscura executable not found. Install Obscura or set OBSCURA_PATH.");
		}
	}
	const exe = file ?? await discoverBrowserExecutable();
	if (!exe || !isExecutable(exe)) {
		throw new ToolError(
			"No browser engine found. Install obscura (OBSCURA_PATH) or Chromium (OMP_TOOLS_BROWSER / CHROME_PATH), or pass app.path.",
		);
	}
	const profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-browser-"));
	const viewport = options.viewport ?? { width: 1365, height: 768 };
	const args = [
		"--remote-debugging-port=0",
		"--no-first-run",
		"--no-default-browser-check",
		`--user-data-dir=${profileDir}`,
		`--window-size=${viewport.width},${viewport.height}`,
		...(file ? [] : ["--headless=new"]),
		...(options.args ?? []),
		"about:blank",
	];
	const child = spawn(exe, args, {
		stdio: ["ignore", "ignore", "pipe"],
		detached: process.platform !== "win32",
	});
	const processHandle = makeProcess(child, profileDir);
	try {
		const wsUrl = await readDevToolsUrl(child, timeoutMs, options.signal);
		return { process: processHandle, wsUrl };
	} catch (error) {
		await processHandle.close(true);
		throw error;
	}
}

async function launchObscura(
	exe: string,
	args: string[] | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<{ process: BrowserProcess; wsUrl: string }> {
	const port = await freePort();
	// These flags give Obscura the same local access as Chromium.
	const child = spawn(
		exe,
		[
			"serve",
			"--port",
			String(port),
			"--allow-private-network",
			"--allow-file-access",
			...(args ?? []),
		],
		{
			stdio: "ignore",
			detached: process.platform !== "win32",
		},
	);
	const processHandle = makeProcess(child);
	try {
		const wsUrl = await waitForCdp(`http://127.0.0.1:${port}`, child, timeoutMs, signal);
		return { process: processHandle, wsUrl };
	} catch (error) {
		await processHandle.close(true);
		throw error;
	}
}

function isObscura(file: string): boolean {
	const name = path.basename(file).toLowerCase();
	return name === "obscura" || name === "obscura.exe";
}

function freePort(): Promise<number> {
	const { promise, resolve, reject } = deferred<number>();
	const server = net.createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		server.close(() => {
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("no port assigned"));
		});
	});
	return promise;
}

async function waitForCdp(origin: string, child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Browser launch aborted");
		if (child.exitCode !== null || child.signalCode !== null) {
			throw new ToolError(`Obscura exited before CDP opened (code ${child.exitCode ?? child.signalCode})`);
		}
		try {
			return await resolveCdpUrl(origin, Math.min(2_000, end - Date.now()), signal);
		} catch {
			await delayMs(150);
		}
	}
	throw new ToolError(`Obscura launch timed out after ${timeoutMs}ms`);
}

function delayMs(ms: number): Promise<void> {
	const { promise, resolve } = deferred<void>();
	setTimeout(resolve, ms);
	return promise;
}

export async function resolveCdpUrl(url: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<string> {
	const clean = url.replace(/\/+$/, "");
	if (clean.startsWith("ws://") || clean.startsWith("wss://")) return clean;
	if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
		throw new ToolError(`Unsupported CDP URL: ${url}`);
	}
	const timeout = AbortSignal.timeout(timeoutMs);
	const response = await fetch(`${clean}/json/version`, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
	if (!response.ok) throw new ToolError(`CDP endpoint returned HTTP ${response.status}: ${clean}`);
	const data: unknown = await response.json();
	if (
		typeof data !== "object" ||
		data === null ||
		!("webSocketDebuggerUrl" in data) ||
		typeof data.webSocketDebuggerUrl !== "string"
	) {
		throw new ToolError(`CDP endpoint did not return webSocketDebuggerUrl: ${clean}`);
	}
	return data.webSocketDebuggerUrl;
}

function browserCandidates(): string[] {
	if (process.platform === "darwin") {
		const roots = ["/Applications", path.join(os.homedir(), "Applications")];
		return roots.flatMap(root => MAC_APPS.map(app => path.join(root, app)));
	}
	if (process.platform === "linux") {
		const found = LINUX_NAMES.flatMap(name => {
			const result = spawnSync("which", [name], { encoding: "utf8" });
			return result.status === 0 && result.stdout.trim() ? [result.stdout.trim()] : [];
		});
		return [
			...found,
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/snap/bin/chromium",
		];
	}
	if (process.platform === "win32") {
		const home = os.homedir();
		const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
		const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
		return [
			path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
			path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
			path.join(local, "Google\\Chrome\\Application\\chrome.exe"),
			path.join(programFiles, "Chromium\\Application\\chrome.exe"),
			path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
			path.join(programFiles, "BraveSoftware\\Brave-Browser\\Application\\brave.exe"),
		];
	}
	return [];
}

function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function readDevToolsUrl(child: ChildProcess, timeoutMs: number, signal?: AbortSignal): Promise<string> {
	const { promise, resolve, reject } = deferred<string>();
	let text = "";
	const done = (): void => {
		clearTimeout(timer);
		child.stderr?.off("data", onData);
		child.off("exit", onExit);
		signal?.removeEventListener("abort", onAbort);
	};
	const onData = (chunk: Buffer): void => {
		text += chunk.toString("utf8");
		const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
		if (!match) return;
		done();
		resolve(match[1] as string);
	};
	const onExit = (code: number | null): void => {
		done();
		reject(new ToolError(`Browser exited before CDP opened (code ${code ?? "unknown"})`));
	};
	const onAbort = (): void => {
		done();
		reject(signal?.reason instanceof Error ? signal.reason : new Error("Browser launch aborted"));
	};
	const timer = setTimeout(() => {
		done();
		reject(new ToolError(`Browser launch timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	child.stderr?.on("data", onData);
	child.once("exit", onExit);
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

function makeProcess(child: ChildProcess, profileDir?: string): BrowserProcess {
	return {
		child,
		...(profileDir ? { profileDir } : {}),
		async close(kill = false): Promise<void> {
			if (child.exitCode === null && child.signalCode === null) {
				sendSignal(child, kill ? "SIGKILL" : "SIGTERM");
				if (!(await waitForExit(child, kill ? 1_000 : 2_000))) sendSignal(child, "SIGKILL");
			}
			if (profileDir) await fsp.rm(profileDir, { recursive: true, force: true });
		},
	};
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	const { promise, resolve } = deferred<boolean>();
	const timer = setTimeout(() => resolve(false), timeoutMs);
	child.once("exit", () => {
		clearTimeout(timer);
		resolve(true);
	});
	return promise;
}
