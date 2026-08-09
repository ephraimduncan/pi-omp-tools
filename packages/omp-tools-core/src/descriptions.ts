/**
 * LLM-facing tool descriptions (adapted from oh-my-pi's tool prompts).
 */
export const READ_DESCRIPTION = `Read files, directories, archives, SQLite databases, PDFs, notebooks, images, and web URLs via one \`path\`.

Selectors — append \`:<sel>\` to path (e.g. \`src/foo.ts:50-200\`, \`db.sqlite:users:42\`):
- \`:50\` / \`:50-\` — from line 50 | \`:50-200\` — inclusive range | \`:50+150\` — 150 lines from 50 | \`:5-16,960-973\` — multiple ranges
- \`:raw\` — verbatim content, no line numbers or snapshot header

Source kinds:
- Text file → \`[path#TAG]\` snapshot header + \`N:text\` numbered lines. Copy \`[FILENAME#TAG]\` verbatim for anchored \`edit\` patches; NEVER fabricate the tag.
- Directory → entry listing with sizes.
- SQLite (\`.sqlite\`/\`.db\`/...): \`file.db\` (tables), \`file.db:table\` (schema+rows), \`file.db:table:key\` (row by PK), \`?limit=\`/\`?where=\`/\`?q=SELECT…\`.
- Archives (\`.zip\`/\`.jar\`/\`.tar\`/\`.tar.gz\`/...): bare path lists members; \`archive.ext:path/inside\` reads a member.
- PDFs → extracted text (pdftotext). Notebooks (.ipynb) → rendered cells (edit via :raw JSON). Images → inline image block.
- http(s) URLs → reader-mode text; \`:raw\` → untouched body.

Truncated output names the exact continuation selector — re-issue ONLY that range. Parallelize independent reads.`;

export const WRITE_DESCRIPTION = `Create or overwrite a file at \`path\` with \`content\`.

- Response includes the new \`[path#TAG]\` snapshot header, so a follow-up \`edit\` can anchor immediately.
- Archive entries: \`archive.zip:path/inside\` writes/replaces a member (.tar appends).
- SQLite rows: \`db.sqlite:table\` inserts (content = JSON object or array), \`db.sqlite:table:key\` updates by primary key (JSON content) or deletes (empty content).
- Prefer \`edit\` for modifying existing files; use write for new files or full rewrites.
- Content starting with \`#!\` is made executable.`;

export const EDIT_DESCRIPTION = `Line-anchored patch language (hashline): name original lines/gaps to replace, insert, cut, or paste, then list new content.

Every file section starts \`[PATH#TAG]\` — TAG is the 4-hex snapshot tag from your latest read/search of that file. REQUIRED; never fabricate it. Create new files with \`write\`; edit only edits existing files.

Ops (one per line, inside a section):
- \`PUT N.=M:\` — replace original lines N through M (INCLUSIVE) with the +body rows below it.
- \`PUT N*:\` — replace the syntactic block BEGINNING on line N (function, class, md-section; closing line resolved for you).
- \`PUT <N:\` / \`PUT >N:\` — insert body rows before / after line N (\`PUT <1:\` = file head, \`PUT >$:\` = file tail).
- \`PUT >N*:\` — insert after the END of the block beginning at N.
- \`CUT N.=M\` / \`CUT N*\` — delete lines/block and capture them (anonymous register, or \`@name\`).
- \`PUT <N\` / \`PUT >N\` / \`PUT N.=M @name\` / \`PUT N* @name\` — paste a captured register (no \`:\`, no body rows).
- \`REM\` — delete the section file. \`MV DEST\` — move/rename the section file.
- Body rows: every row is \`+TEXT\` verbatim (leading whitespace kept); \`+\` alone = blank line. NEVER \`-old\` or bare context rows — the range deletes, the body is only the final content.

Rules:
- Line numbers name ORIGINAL lines from your latest read/search (\`N:text\` rows); the range covers ONLY changed lines. Keep a line by leaving it out of every range.
- Pure additions use \`PUT <N:\` / \`PUT >N:\` — never a widened replace.
- Applied edits renumber the file and change the #TAG — take the next edit's numbers from the edit response or a fresh read. Stale tags are auto-recovered when safe, otherwise rejected.
- Move code with CUT+PUT: \`CUT 5.=9 @fn\` then \`PUT >40 @fn\`. Named registers persist across edit calls; sections may span multiple files in one patch.
- Single line: \`PUT N.=N:\` / \`CUT N.=N\`. To delete lines use CUT, never an empty PUT.

Example — replace lines 1-3, then append after line 2:
[greet.py#A1B2]
PUT 1.=3:
+def greet(name):
+    print(f"Hi, {name}")
PUT >2:
+greet("world")`;

export const AST_GREP_DESCRIPTION = `Structural code search via ast-grep. Use when syntax shape matters more than text (calls, declarations, constructs).

- \`pat\` is ONE AST pattern; it must parse as a single AST node in the target language. Non-standalone snippets → wrap (e.g. \`class $_ { $$$BODY }\`).
- \`$NAME\` captures one node; \`$_\` matches without binding; \`$$$NAME\` zero-or-more (NEVER \`$$NAME\`). Names UPPERCASE, whole node — \`prefix$VAR\` fails.
- Same metavariable twice MUST match identical code (\`$A == $A\` matches \`x == x\`, not \`x == y\`).
- Declaration forms are distinct — \`function foo\`, method \`foo()\`, \`export const foo = () =>\` — search the right form before concluding absence.
- Languages: js/ts/tsx/css/html built in; python/rust/go/java/c/cpp/json/yaml when optional grammars are installed. Parse issues = query failure, not absence.
- Narrow \`path\` before repo-root scans. Loosest existence check: \`pat: "someName"\` with a narrow path.`;

export const AST_EDIT_DESCRIPTION = `Structural AST-aware rewrites via ast-grep. Use for codemods where text replace is unsafe.

- Each op is {pat, out}: metavariables captured in \`pat\` (\`$A\`, \`$$$ARGS\`) substitute into \`out\`. Delete by rewriting to "".
- Patterns match AST structure, not text; both pat and out must parse as single AST nodes.
- DRY-RUN BY DEFAULT: matches render as diffs but nothing is written. Verify the preview, then re-issue the SAME call with "apply": true.
- 1:1 substitution — no splitting/merging captures. For one-off text edits prefer the edit tool.`;

export const SEARCH_DESCRIPTION = `Regex search over files, directories, and globs (ripgrep-powered).

- \`path\`: file, directory, or glob; semicolon-separate several roots ("src; tests; *.md"). Omitted → workspace root.
- Single-file line scope: \`src/foo.ts:50-100\`.
- Smart-case by default; \`case: true\` forces case-sensitive. \`literal: true\` for fixed strings. A literal \`\\n\` in the pattern enables multiline matching.
- Output groups matches under \`[path#TAG]\` snapshot headers with \`N:text\` rows — line numbers + tag are valid \`edit\` anchors.
- Paginate more files with \`skip\`. Prefer this over shell grep/rg.`;

export const FIND_DESCRIPTION = `Glob-based path lookup (newest-first; directories end in \`/\`).

- \`path\`: glob, file, or directory; semicolon-separate several ("src/**/*.ts; test/**/*.ts"). Omitted → workspace root.
- \`gitignore\` defaults true — set false for ignored files like \`.env*\`, logs, or build output. \`hidden\` defaults true.
- Use search when you need content matches; find only matches paths.`;
