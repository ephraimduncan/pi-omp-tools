export interface LazyPrimeInputEditor {
	getText(): string;
	setText(text: string): void;
}

export interface LazyPrimeInputKeybindings {
	matches(data: string, action: string): boolean;
}

/**
 * Clear a non-empty Lazy Prime prompt before Prime handles Ctrl+C. The same
 * keypress must still reach Prime so its built-in second-press exit state is
 * armed.
 */
export function routeLazyPrimeEditorInput(
	data: string,
	editor: LazyPrimeInputEditor,
	keybindings: LazyPrimeInputKeybindings,
	delegate: (data: string) => void,
): void {
	if (keybindings.matches(data, "app.clear") && editor.getText().length > 0) {
		editor.setText("");
	}
	delegate(data);
}
