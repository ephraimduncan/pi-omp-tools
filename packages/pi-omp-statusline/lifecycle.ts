export interface OmpStopAwareEditor {
	setOmpStopHidden(hidden: boolean): void;
}

export interface OmpTuiLifecycle {
	start(...args: unknown[]): unknown;
	stop(...args: unknown[]): unknown;
	doRender?: () => void;
}

interface LifecycleState {
	editor?: OmpStopAwareEditor;
	originalStart: OmpTuiLifecycle["start"];
	originalStop: OmpTuiLifecycle["stop"];
}

const lifecycleStates = new WeakMap<object, LifecycleState>();

function preservesAlternateScreen(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as { preserveAltScreen?: boolean }).preserveAltScreen === true;
}

/**
 * Prime's TUI preserves its last frame when it stops. Hide and synchronously
 * repaint the omp editor first so the three-line input box does not remain in
 * terminal scrollback. Temporary stops restore the editor on the next start.
 */
export function registerOmpEditorLifecycle(tui: OmpTuiLifecycle, editor: OmpStopAwareEditor): () => void {
	let state = lifecycleStates.get(tui);
	if (!state) {
		state = {
			originalStart: tui.start,
			originalStop: tui.stop,
		};
		lifecycleStates.set(tui, state);
		const lifecycle = state;

		tui.start = function (this: OmpTuiLifecycle, ...args: unknown[]): unknown {
			lifecycle.editor?.setOmpStopHidden(false);
			return lifecycle.originalStart.apply(this, args);
		};
		tui.stop = function (this: OmpTuiLifecycle, ...args: unknown[]): unknown {
			if (!preservesAlternateScreen(args[0]) && lifecycle.editor) {
				lifecycle.editor.setOmpStopHidden(true);
				try {
					this.doRender?.();
				} catch {
					// Cleanup is cosmetic; never prevent the host from stopping.
				}
			}
			return lifecycle.originalStop.apply(this, args);
		};
	}

	state.editor = editor;
	return () => {
		if (state?.editor === editor) state.editor = undefined;
	};
}

/** Force custom editor rows onto the terminal's default background. */
export function onDefaultTerminalBackground(line: string): string {
	return `\x1b[49m${line}\x1b[49m`;
}
