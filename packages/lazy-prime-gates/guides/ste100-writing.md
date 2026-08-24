---
name: ste-writing
description: Write prose that complies with ASD-STE100 Simplified Technical English (Issue 9). Use when writing or rewriting commit messages, PR descriptions, PR reviews, issue text, release notes, code comments, README files, or any technical documentation, and when the user mentions STE, STE-100, ASD-STE100, Simplified Technical English, or "the writing standard".
---

# STE-100 Writing Standard (compact core)

All prose this environment produces complies with ASD-STE100 Issue 9, adapted for software and hardware work. This applies to commit messages, PR titles and bodies, reviews, issue text, release notes, code comments, and documentation. Objective: the reader understands each sentence on the first read.

Lookups:

- The gate pause shows the absolute installed path of `ste100-wordlist.md`. Use `search` with the pattern `^word (` on that file to check word approval. Uppercase entries are approved. Lowercase entries give the approved alternative.
- The gate pause also shows the absolute installed path of this compact rule file.

## Scope mappings for software and hardware

1. Instructions to a reader (setup, migration, "run this") = procedural writing: imperative, max 20 words per sentence. All other prose (commit bodies, PR bodies, reviews, descriptions) = descriptive writing: max 25 words, no imperative.
2. Commit subject lines keep the Conventional Commits contract (`type(scope): description`, imperative, lowercase, under 72 chars, articles may drop). STE governs word choice there; full STE governs the body.
3. Identifiers are exempt and count as one word each: `feat`/`fix` tokens, paths, symbols, flags, error strings, versions, code spans, quoted UI text. Never rewrite an identifier to satisfy the dictionary.
4. Domain terms are approved technical nouns/verbs: commit, branch, merge, rebase, push, deploy, build, compile, refactor, rename, update, migrate, cache, token, endpoint, API, schema, callback, crash, boot, flash, solder, breadboard, firmware, GPIO, click, scroll. Substitute only the general English sense: "update the schema" is fine; "keep the team updated" becomes "tell the team".
5. No slang or jargon as terms: brick, nuke, footgun, sanity check, happy path. Name the precise behavior.
6. Templates and changelog formats decide structure. STE decides how each sentence is written.

## Words

- Use only: approved dictionary words, technical nouns, technical verbs. One meaning, one part of speech per word — "test" is a noun ("do a test of"), "check" is a noun ("do a check of"), "damage" is a noun ("cause damage to"), "help" is a verb (the noun is "aid").
- A not-approved word is usable only inside a technical noun: "main" is not approved, but "main branch" stays "main branch".
- One name per item, everywhere. Not "config"/"settings"/"options" for one file (rules 1.11, 9.4, 6.2).
- Multi-word nouns: max three words. Break longer chains with of/on/in/for: "calibration of the resistance of the runway light connection". Longer technical nouns: write in full once, then define a short form, or hyphenate the words that act as one unit.
- American English spelling. Never change spelling inside quoted text or identifiers.

## Verbs

- Only these forms: infinitive, imperative, simple present, simple past, simple future, past participle as adjective ("the merged branch").
- Banned: progressive (is running → runs), perfect (has fixed → corrected), auxiliary chains ("can be adjusted" → "you can adjust"), "-ing" verb forms (permitted only inside technical nouns: caching layer, routing table), phrasal verbs (put out → extinguish, give off → release).
- Active voice. Passive only in description when the agent is unknown. Repairs: name the agent as subject; use the imperative in procedures; with no agent, use "you" (reader) or "we" (this project).
- Describe an action with a verb, not a noun: "before you remove the unit", not "before the removal of the unit"; "shows 450 ohms", not "gives an indication of 450 ohms".

## Sentences

- Max 20 words (instructions) / 25 words (description). Identifiers, numbers with units, quoted text, headings, proper nouns, parenthetical text, and hyphenated words count as one word each.
- One instruction per sentence, unless simultaneous ("Remove and discard the seal").
- Condition first, comma, then command: "If the build fails, examine the log." Never the reverse order.
- Do not omit words or contract: keep subjects, verbs, articles; "do not", never "don't". Not "If installed, remove the shims" but "If shims are installed, remove them".
- Use the/a/an/this/these before nouns, except general statements ("Solvents can cause damage to paint") and nouns with identifiers ("on branch main", "tag circuit breaker 36L7").
- Connect related sentences with: and, but, then, thus, as a result, at the same time.
- Keep "that": "Make sure that the valve is open." Replace ambiguous pronouns with the noun. Re-read every "with" for ambiguity.

## Lists, paragraphs, structure

- Markdown lists are vertical lists: colon after the lead-in, one item style, items start uppercase, period only on full-sentence items and the last item, no trailing commas or semicolons, no mixed instruction+description, no nesting.
- Paragraphs: start with a topic sentence, one topic each, max six sentences. Repeat key words; never vary a term for elegance.
- Warnings and cautions ("**Warning:**", "**Breaking change:**"): risk word, then command or condition, then the risk or result. "Warning: Do not run this migration on a live database. The migration locks the table and in-flight writes fail." Warning-class = data loss, security exposure, outage; caution-class = broken build, corrupted local state.
- Notes give information only — never instructions, requirements, or limits. If removing the note breaks the procedure, it is a step.

## Punctuation

- No semicolons — write two sentences. No dashes as idea separators. No Latin abbreviations: "for example", not "e.g."; "that is", not "i.e."; name the rest or drop "etc."
- Hyphenate directly related words: compound modifiers (low-latency path, quick-release fastener), letter/number + noun (L-shaped, 3-prong), noun-first verbs (short-circuit), vowel prefix + vowel root (pre-engage, de-icing).
- Parentheses are fine for references, identifiers, abbreviations, "part(s)", short explanations, alternatives.

## When substitution fails, restructure

Word-for-word replacement is not always sufficient (rule 9.1). Ask: what does the word mean here, and what must the reader do or know? "The oil level must be visible during the test" → "During the test, make sure that you can see the oil level." Limits are "more than"/"less than", never "above"/"below". "see" is with your eyes only — "make sure that", not "see if". Gender-neutral: use "you", "we", or the role name.

## Substitute on sight (recurring errors)

| Do not write | Write |
| --- | --- |
| ensure / verify / validate (general) | make sure that |
| perform / implement / carry out | do |
| allow / enable / permit (v) | let, or "you can" |
| may / might / should | can (ability), must (requirement) |
| however / therefore | but / thus, as a result |
| prior to / in order to | before / to |
| utilize / leverage / employ | use |
| additional / further | more |
| enough / adequate | sufficient |
| required / need (v) | necessary, must |
| currently / now | at this time |
| fix (general v) | repair, correct (`fix:` token exempt) |
| resolve (a problem) | correct, repair |
| improve | make better, or state the measured result |
| create / modify | make, cause / change |
| insert / fit | put / install |
| check (v) / test (v) | do a check of, examine / do a test of |
| avoid | prevent, or "do not" |
| follow (instructions) | obey ("follow" = come after only) |
| since (causal) / once (conj) | because / when, after |
| while (contrast) | but ("while" = at the same time only) |
| via / about (= roughly) | through, with / approximately, around |
| any / both | a different construction / the two |
| fail | "if X is not successful", or FAILURE as a domain noun |
| support (v, general) | hold, or "X can operate with Y" |
| people / old | persons, personnel / used, expired, remaining |
| repeat | do ... again |
| acceptable / main | permitted / primary |

## Approved verbs (complete list — everything else is a domain verb or needs an alternative)

ABSORB, ACCEPT, ACTIVATE, ADAPT, ADD, ADJUST, AGREE, ALIGN, APPLY, ARM, ASSEMBLE, ATTACH, BALANCE, BE, BECOME, BEND, BLEED, BLOW, BOND, BREAK, BREATHE, BURN, BYPASS, CALCULATE, CALIBRATE, CAN, CANCEL, CANNOT, CATCH, CAUSE, CHANGE, CHARGE, CLEAN, CLOSE, COLLECT, COME, COME ON, COMPARE, COMPLETE, COMPRESS, CONNECT, CONTACT, CONTAIN, CONTINUE, CONTROL, CORRECT, COUNT, CUT, DEACTIVATE, DECREASE, DE-ENERGIZE, DEFLATE, DEFUEL, DEPLOY, DISARM, DISASSEMBLE, DISCARD, DISCONNECT, DISENGAGE, DIVIDE, DO, DRAIN, DRINK, DRY, EAT, EJECT, ENERGIZE, ENGAGE, ERASE, EXAMINE, EXPAND, EXTEND, EXTINGUISH, FALL, FEATHER, FEEL, FILL, FIND, FIRE, FLASH, FLOW, FLUSH, FOLD, FOLLOW, FREEZE, GET, GIVE, GO, GO OFF, GROUND, HANG, HAVE, HEAR, HELP, HIT, HOLD, IDENTIFY, IGNORE, ILLUMINATE, INCLUDE, INCREASE, INFLATE, INSTALL, INTERCHANGE, ISOLATE, KEEP, KILL, KNOW, LATCH, LET, LIFT, LISTEN, LOCK, LOOK, LOOSEN, LOWER, LUBRICATE, MAKE, MAKE SURE, MEASURE, MELT, MIX, MONITOR, MOOR, MOVE, MULTIPLY, MUST, OBEY, OCCUR, OPEN, OPERATE, OVERRIDE, PAINT, PARK, POINT, POLISH, PREPARE, PRESSURIZE, PREVENT, PROTRUDE, PULL, PUSH, PUT, PUT ON, READ, RECEIVE, RECOMMEND, RECORD, RECYCLE, REFER, REFUEL, REJECT, RELEASE, REMOVE, REPAIR, REPLACE, RETRACT, RUB, SAFETY, SCHEDULE, SEAL, SEE, SELECT, SEND, SENSE, SET, SHAKE, SHOW, SIMULATE, SMELL, SMOKE, SOAK, SPEAK, SPILL, SPRAY, START, STAY, STOP, STOW, SUBTRACT, SUPPLY, SWALLOW, TAG, TAP, TELL, THINK, TIGHTEN, TILT, TORQUE, TOUCH, TOW, TRANSMIT, TRY, TUNE, TURN, TWIST, UNFOLD, UNLOCK, UNWIND, USE, WAIT, WALK, WANT, WEAR, WEIGH, WILL, WIND, WRITE

## Self-check

1. Every word: approved, domain term, or identifier.
2. Sentence length: 20 (instructions) / 25 (description); identifiers and quoted text count as one word.
3. No progressive, perfect, passive-with-known-agent, "-ing" verbs, or phrasal verbs.
4. One instruction per sentence; condition before command; one topic per paragraph, max six sentences.
5. No semicolons, dashes as separators, contractions, Latin abbreviations, or dropped articles.
6. One term per concept, everywhere.
