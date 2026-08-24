import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { onDefaultTerminalBackground, registerOmpEditorLifecycle } from "../packages/pi-omp-statusline/lifecycle.ts";
import { routeOmpEditorInput } from "../packages/pi-omp-statusline/input.ts";
import { frameUserMessage, installUserMessageCard } from "../packages/pi-omp-statusline/user-message.ts";

const CTRL_C = "\x03";

test("omp statusline: first Ctrl+C clears a draft and second exits", () => {
	let text = "unsent draft";
	let exitArmed = false;
	let exited = false;
	const editor = {
		getText: () => text,
		setText: (value: string) => {
			text = value;
		},
	};
	const keybindings = {
		matches: (data: string, action: string) => data === CTRL_C && action === "app.clear",
	};
	const primeHandler = (data: string) => {
		if (!keybindings.matches(data, "app.clear")) return;
		if (exitArmed) exited = true;
		else exitArmed = true;
	};

	routeOmpEditorInput(CTRL_C, editor, keybindings, primeHandler);
	assert.equal(text, "");
	assert.equal(exitArmed, true, "the clearing press must also arm Prime's second-press exit");
	assert.equal(exited, false);

	routeOmpEditorInput(CTRL_C, editor, keybindings, primeHandler);
	assert.equal(exited, true);
});

test("omp statusline: hides the boxed editor before TUI shutdown", () => {
	const events: string[] = [];
	let hidden = false;
	const tui = {
		start() {
			events.push(`start:${hidden}`);
		},
		stop() {
			events.push(`stop:${hidden}`);
		},
		doRender() {
			events.push(`render:${hidden}`);
		},
	};
	const editor = {
		setOmpStopHidden(value: boolean) {
			hidden = value;
		},
	};

	registerOmpEditorLifecycle(tui, editor);
	tui.stop();
	assert.deepEqual(events, ["render:true", "stop:true"]);

	tui.start();
	assert.equal(hidden, false, "temporary stops must restore the editor when the TUI restarts");
	assert.equal(events.at(-1), "start:false");
});

test("omp statusline: keeps the editor during alternate-screen handoff", () => {
	const events: string[] = [];
	let hidden = false;
	const tui = {
		start() {},
		stop(_options?: { preserveAltScreen?: boolean }) {
			events.push(`stop:${hidden}`);
		},
		doRender() {
			events.push("render");
		},
	};

	registerOmpEditorLifecycle(tui, {
		setOmpStopHidden(value: boolean) {
			hidden = value;
		},
	});
	tui.stop({ preserveAltScreen: true });

	assert.deepEqual(events, ["stop:false"]);
});

test("omp statusline: resets the background on every editor row", () => {
	const line = onDefaultTerminalBackground("\x1b[31mstatus\x1b[39m");
	assert.equal(line.startsWith("\x1b[49m"), true);
	assert.equal(line.endsWith("\x1b[49m"), true);
});

test("prime omp: submitted user messages render as full cards", () => {
	const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");
	const visibleWidth = (value: string): number => stripAnsi(value).length;
	const width = 30;
	const lines = frameUserMessage(["  hello", "", "  second line"], width, {
		border: (text: string) => `\x1b[90m${text}\x1b[39m`,
		accent: (text: string) => `\x1b[33m${text}\x1b[39m`,
		visibleWidth,
		truncateToWidth: (text: string, maxWidth: number) => text.slice(0, maxWidth),
	});

	assert.equal(stripAnsi(lines[0] ?? "").startsWith("╭─ α "), true);
	assert.equal(stripAnsi(lines.at(-1) ?? ""), `╰${"─".repeat(width - 2)}╯`);
	assert.equal(lines.length, 5);
	assert.equal(stripAnsi(lines[1] ?? "").startsWith("│  hello"), true);
	for (const line of lines) assert.equal(visibleWidth(line), width, "every card row must fit the terminal width");
});

test("omp statusline: installs user-message cards through the host UI component", () => {
	class HostUserMessage {
		render(width: number): string[] {
			return ["  hello".padEnd(width)];
		}
	}
	const original = HostUserMessage.prototype.render;
	const uninstall = installUserMessageCard(HostUserMessage, {
		visibleWidth: value => value.replace(/\x1b\[[0-9;]*m/g, "").length,
		truncateToWidth: (value, width) => value.slice(0, width),
	});
	const rendered = new HostUserMessage().render(30);

	assert.equal(rendered.length, 3);
	assert.equal(rendered[0]?.includes(" α "), true);
	assert.equal(rendered.every(line => line.startsWith("\x1b[49m") && line.endsWith("\x1b[49m")), true);
	uninstall();
	assert.equal(HostUserMessage.prototype.render, original, "disabling omp must restore the host renderer");
});

test("omp dark themes keep passive surfaces on the terminal background", () => {
	const passiveSurfaces = [
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"toolPanelBg",
		"toolDiffAddedBg",
		"toolDiffRemovedBg",
	];
	for (const name of ["omp-dark.pi.json", "omp-dark.prime.json"]) {
		const theme = JSON.parse(readFileSync(new URL(`../themes/${name}`, import.meta.url), "utf8"));
		for (const surface of passiveSurfaces) {
			assert.equal(theme.colors[surface] ?? "", "", `${name} ${surface} must not paint a tinted band`);
		}
		assert.notEqual(theme.colors.selectedBg, "", `${name} must retain a visible selection state`);
	}
});
