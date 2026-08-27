import type { TaskWorkerActivity } from "./tools/task-activity.ts";

export interface TaskViewStyle {
	fg(color: string, text: string): string;
	bold(text: string): string;
	visibleWidth(text: string): number;
	fit(text: string, width: number): string;
}

export interface TaskCardOptions {
	selected?: boolean;
	focused?: boolean;
	bodyLines: number;
	scrollOffset?: number;
}

export interface TaskCardRender {
	lines: string[];
	totalActivityLines: number;
	startActivityLine: number;
	endActivityLine: number;
	maxScrollOffset: number;
	following: boolean;
}

const OSC_RE = new RegExp(String.raw`\u001b\][\s\S]*?(?:\u0007|\u001b\\)`, "g");
const STRING_ESCAPE_RE = new RegExp(String.raw`\u001b[P^_X][\s\S]*?\u001b\\`, "g");
const CSI_RE = new RegExp(String.raw`(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]`, "g");
const ESC_RE = new RegExp(String.raw`\u001b[ -/]*[@-~]`, "g");
const CONTROL_RE = new RegExp(String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`, "g");

export function sanitizeTaskText(text: string): string {
	return text
		.replace(OSC_RE, "")
		.replace(STRING_ESCAPE_RE, "")
		.replace(CSI_RE, "")
		.replace(ESC_RE, "")
		.replace(CONTROL_RE, "")
		.replace(/\t/g, "  ");
}

const cleanText = sanitizeTaskText;

function clockLabel(at: number): string {
	const date = new Date(at);
	return [date.getHours(), date.getMinutes(), date.getSeconds()].map(value => String(value).padStart(2, "0")).join(":");
}

function toolLabel(name: string): string {
	return name
		.split(/[-_]/g)
		.filter(Boolean)
		.map(part => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join(" ");
}

function statusGlyph(style: TaskViewStyle, worker: TaskWorkerActivity): string {
	if (worker.status === "completed") return style.fg("success", "✔");
	if (worker.status === "failed" || worker.status === "aborted") return style.fg("error", "✘");
	if (worker.status === "queued") return style.fg("dim", "◌");
	return style.fg("accent", "●");
}

function workerStatusLabel(worker: TaskWorkerActivity): string {
	if (worker.status === "starting") return "starting";
	return worker.status;
}

function activityLines(style: TaskViewStyle, worker: TaskWorkerActivity, focused: boolean): string[] {
	const rows: string[] = [];
	for (const entry of worker.activity) {
		const time = style.fg("dim", clockLabel(entry.at));
		if (entry.kind === "assistant") {
			const textRows = cleanText(entry.text).split("\n").filter(row => row.trim().length > 0);
			for (const [index, row] of textRows.entries()) {
				rows.push(`${index === 0 ? `${time}  ` : "          "}${style.fg("toolOutput", row)}`);
			}
			continue;
		}
		const failed = entry.status === "failed" || entry.status === "interrupted";
		const icon = failed ? style.fg("error", "✘") : entry.status === "running" ? style.fg("accent", "▣") : style.fg("muted", "▣");
		const name = style.fg(failed ? "error" : "accent", `${toolLabel(cleanText(entry.toolName))}:`);
		const summary = entry.summary ? ` ${style.fg("muted", cleanText(entry.summary))}` : "";
		rows.push(`${time}  ${icon} ${name}${summary}`);
		if (entry.output) {
			const outputRows = cleanText(entry.output).split("\n").filter(row => row.trim().length > 0);
			const shown = focused ? outputRows : outputRows.slice(-2);
			for (const row of shown) rows.push(`          ${style.fg(failed ? "error" : "muted", row)}`);
		}
	}
	return rows;
}

function placeholder(style: TaskViewStyle, worker: TaskWorkerActivity): string {
	if (worker.status === "queued") return style.fg("muted", "Waiting for an available worker slot.");
	if (worker.status === "starting") return style.fg("muted", "Preparing the child agent.");
	if (worker.status === "running") return style.fg("muted", "Waiting for streamed output.");
	if (worker.status === "completed") return style.fg("success", "Completed with no streamed output.");
	if (worker.status === "aborted") return style.fg("error", "Agent was aborted.");
	return style.fg("error", "Agent failed before producing output.");
}

function topBorder(
	style: TaskViewStyle,
	worker: TaskWorkerActivity,
	width: number,
	selected: boolean,
	rangeLabel: string | undefined,
): string {
	const borderColor = selected ? "accent" : "borderMuted";
	const border = (text: string): string => style.fg(borderColor, text);
	const marker = selected ? `${style.fg("accent", "›")} ` : "";
	const badge = worker.agent !== "task" ? ` ${style.fg("dim", `⟨${worker.agent}⟩`)}` : "";
	const isolation = worker.isolated ? style.fg("dim", " [isolated]") : "";
	const title = `${marker}${statusGlyph(style, worker)} ${style.bold(worker.name)}${badge} ${style.fg("muted", `· ${workerStatusLabel(worker)}`)}${isolation}`;
	const stats: string[] = [];
	if (worker.turns > 0) stats.push(`${worker.turns} turn${worker.turns === 1 ? "" : "s"}`);
	if (worker.tools > 0) stats.push(`${worker.tools} tool${worker.tools === 1 ? "" : "s"}`);
	if (rangeLabel) stats.push(rangeLabel);
	let right = stats.length > 0 ? ` ${style.fg("muted", stats.join(" · "))} ${border("──╮")}` : border("──╮");
	let left = `${border("╭──")} ${title} `;
	if (style.visibleWidth(left) + style.visibleWidth(right) >= width) right = border("──╮");
	if (style.visibleWidth(left) + style.visibleWidth(right) >= width) {
		left = `${border("╭──")} ${style.fit(title, Math.max(1, width - style.visibleWidth(right) - 5))} `;
	}
	const fill = Math.max(1, width - style.visibleWidth(left) - style.visibleWidth(right));
	return style.fit(`${left}${border("─".repeat(fill))}${right}`, width);
}

export function renderTaskWorkerCard(
	style: TaskViewStyle,
	worker: TaskWorkerActivity,
	width: number,
	options: TaskCardOptions,
): TaskCardRender {
	const w = Math.max(24, width);
	const bodyLineCount = Math.max(0, options.bodyLines);
	const visualRows = activityLines(style, worker, options.focused === true);
	const total = visualRows.length;
	const maxOffset = bodyLineCount === 0 ? 0 : Math.max(0, total - bodyLineCount);
	const offset = Math.max(0, Math.min(options.scrollOffset ?? 0, maxOffset));
	const end = total - offset;
	const start = Math.max(0, end - bodyLineCount);
	const shown = bodyLineCount === 0 ? [] : total > 0 ? visualRows.slice(start, end) : [placeholder(style, worker)];
	while (shown.length < bodyLineCount) shown.push("");
	const following = offset === 0;
	const rangeLabel = bodyLineCount === 0 && total > 0
		? `${total} lines`
		: total > bodyLineCount || offset > 0
			? `${start + 1}–${Math.max(start + 1, end)}/${total}`
			: worker.status === "running" && following
				? "live"
				: undefined;
	const selected = options.selected === true || options.focused === true;
	const borderColor = selected ? "accent" : "borderMuted";
	const border = (text: string): string => style.fg(borderColor, text);
	const contentWidth = w - 4;
	const lines = [topBorder(style, worker, w, selected, rangeLabel)];
	for (const row of shown) {
		const fitted = style.fit(row, contentWidth);
		lines.push(`${border("│")} ${fitted}${" ".repeat(Math.max(0, contentWidth - style.visibleWidth(fitted)))} ${border("│")}`);
	}
	lines.push(border(`╰${"─".repeat(Math.max(1, w - 2))}╯`));
	return {
		lines,
		totalActivityLines: total,
		startActivityLine: start,
		endActivityLine: end,
		maxScrollOffset: maxOffset,
		following,
	};
}
