const GIT_ENV = "GIT_EDITOR=true GIT_SEQUENCE_EDITOR=true GIT_MERGE_AUTOEDIT=no";
const GIT_EXPORT = `export ${GIT_ENV}\n`;
const GIT_COMMAND = /\bgit\b/;
const IPYTHON_MAGIC = /^((?:[ \t]*\r?\n)*[ \t]*%%(?:bash|sh|zsh)\b[^\r\n]*(?:\r?\n|$))([\s\S]*)$/;
const IPYTHON_ESCAPE = /^([ \t]*(?:[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s*=\s*)?)(!{1,2})(?![=])(.*)$/gm;
const IPYTHON_LINE_MAGIC = /^([ \t]*)(%(?:sx|sc|system)\b[ \t]*)(.*)$/gm;
const IPYTHON_SYSTEM_CALL = /(get_ipython\(\)\.(?:system|getoutput)\(\s*)(["'])([\s\S]*?)\2(\s*\))/g;

/** Return the shell command regions visible in bash and Prime IPython calls. */
export function shellCommands(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "bash" && typeof input.command === "string") return [input.command];
	if (toolName !== "ipython" || typeof input.code !== "string") return [];

	const magic = IPYTHON_MAGIC.exec(input.code);
	if (magic) return [magic[2] ?? ""];

	return [
		...[...input.code.matchAll(IPYTHON_ESCAPE)].map(match => match[3]?.trimStart() ?? ""),
		...[...input.code.matchAll(IPYTHON_LINE_MAGIC)].map(match => match[3]?.trimStart() ?? ""),
		...[...input.code.matchAll(IPYTHON_SYSTEM_CALL)].map(match => match[3] ?? ""),
	].filter(command => command.length > 0);
}

/** Inject noninteractive Git editor variables into each matching shell region. */
export function injectGitEditors(toolName: string, input: Record<string, unknown>): void {
	if (toolName === "bash" && typeof input.command === "string") {
		if (hasGit(input.command) && !hasGitEnvironment(input.command)) input.command = GIT_EXPORT + input.command;
		return;
	}
	if (toolName !== "ipython" || typeof input.code !== "string") return;

	const magic = IPYTHON_MAGIC.exec(input.code);
	if (magic) {
		const header = magic[1] ?? "";
		const body = magic[2] ?? "";
		if (hasGit(body) && !hasGitEnvironment(body)) input.code = header + GIT_EXPORT + body;
		return;
	}

	input.code = input.code
		.replace(IPYTHON_ESCAPE, (line, prefix: string, bang: string, command: string) => {
			if (!hasGit(command) || hasGitEnvironment(command)) return line;
			return `${prefix}${bang}${GIT_EXPORT.trimEnd()}; ${command.trimStart()}`;
		})
		.replace(IPYTHON_LINE_MAGIC, (line, indent: string, magicName: string, command: string) => {
			if (!hasGit(command) || hasGitEnvironment(command)) return line;
			return `${indent}${magicName}${GIT_EXPORT.trimEnd()}; ${command.trimStart()}`;
		})
		.replace(IPYTHON_SYSTEM_CALL, (line, start: string, quote: string, command: string, end: string) => {
			if (!hasGit(command) || hasGitEnvironment(command)) return line;
			return `${start}${quote}${GIT_EXPORT.trimEnd()}; ${command.trimStart()}${quote}${end}`;
		});
}

function hasGit(command: string): boolean {
	return GIT_COMMAND.test(command);
}

function hasGitEnvironment(command: string): boolean {
	const firstGit = command.search(GIT_COMMAND);
	if (firstGit < 0) return false;
	const beforeGit = command.slice(0, firstGit);
	const exports = [...beforeGit.matchAll(/(?:^|[;\n])\s*export\s+([^;\n]*)/g)].map(match => match[1] ?? "").join(" ");
	if (hasAllGitAssignments(exports)) return true;

	const boundary = Math.max(beforeGit.lastIndexOf("\n"), beforeGit.lastIndexOf(";"), beforeGit.lastIndexOf("&&"), beforeGit.lastIndexOf("||"));
	const inline = beforeGit.slice(boundary + 1).trim();
	return /^(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)*$/.test(inline) && hasAllGitAssignments(inline);
}

function hasAllGitAssignments(text: string): boolean {
	return /(?:^|\s)GIT_EDITOR=true(?:\s|$)/.test(text)
		&& /(?:^|\s)GIT_SEQUENCE_EDITOR=true(?:\s|$)/.test(text)
		&& /(?:^|\s)GIT_MERGE_AUTOEDIT=no(?:\s|$)/.test(text);
}
