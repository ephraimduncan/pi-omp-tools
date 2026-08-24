export interface LazyPrimeStopAwareEditor {
	setLazyPrimeStopHidden(hidden: boolean): void;
}

export interface LazyPrimeTuiLifecycle {
	start(...args: unknown[]): unknown;
	stop(...args: unknown[]): unknown;
	doRender?: () => void;
}

interface LifecycleState {
	editor?: LazyPrimeStopAwareEditor;
	originalStart: LazyPrimeTuiLifecycle["start"];
	originalStop: LazyPrimeTuiLifecycle["stop"];
}

const lifecycleStates = new WeakMap<object, LifecycleState>();

function preservesAlternateScreen(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as { preserveAltScreen?: boolean }).preserveAltScreen === true;
}

/**
 * Prime's TUI preserves its last frame when it stops. Hide and synchronously
 * repaint the Lazy Prime editor first so the three-line input box does not
 * remain in terminal scrollback. Temporary stops restore the editor on the
 * next start.
 */
export function registerLazyPrimeEditorLifecycle(
	tui: LazyPrimeTuiLifecycle,
	editor: LazyPrimeStopAwareEditor,
): () => void {
	let state = lifecycleStates.get(tui);
	if (!state) {
		state = {
			originalStart: tui.start,
			originalStop: tui.stop,
		};
		lifecycleStates.set(tui, state);
		const lifecycle = state;

		tui.start = function (this: LazyPrimeTuiLifecycle, ...args: unknown[]): unknown {
			lifecycle.editor?.setLazyPrimeStopHidden(false);
			return lifecycle.originalStart.apply(this, args);
		};
		tui.stop = function (this: LazyPrimeTuiLifecycle, ...args: unknown[]): unknown {
			if (!preservesAlternateScreen(args[0]) && lifecycle.editor) {
				lifecycle.editor.setLazyPrimeStopHidden(true);
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
