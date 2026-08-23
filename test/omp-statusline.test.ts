import * as assert from "node:assert/strict";
import { test } from "node:test";
import { routeOmpEditorInput } from "../packages/pi-omp-statusline/input.ts";

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
