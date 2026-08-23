export interface OmpInputEditor {
	getText(): string;
	setText(text: string): void;
}

export interface OmpInputKeybindings {
	matches(data: string, action: string): boolean;
}

/**
 * Clear a non-empty OMP prompt before Prime handles Ctrl+C. The same keypress
 * must still reach Prime so its built-in second-press exit state is armed.
 */
export function routeOmpEditorInput(
	data: string,
	editor: OmpInputEditor,
	keybindings: OmpInputKeybindings,
	delegate: (data: string) => void,
): void {
	if (keybindings.matches(data, "app.clear") && editor.getText().length > 0) {
		editor.setText("");
	}
	delegate(data);
}
