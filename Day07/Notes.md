# Lecture: The Code Reviewer Agent (Multi-Tool + Autonomous)

**Stack:** Node.js, `@google/genai`, `gemini-2.5-flash`, `fs`, `path`

---

## 1. The three agents so far

| | L1: Weather/Crypto | L2: Website Builder | L3: Code Reviewer |
| --- | --- | --- | --- |
| Tools | 2 (unrelated) | 1 (universal) | **3 (composed)** |
| Effect | read-only | writes new files | **rewrites MY files** |
| Human in loop | every question | every question | **only at kickoff** |
| Input | typed question | typed question | CLI argument |
| Tool interface | HTTP fetch | shell | Node `fs` API |
| Recoverable? | yes | mostly | **only via git** |

The loop is *still* the same loop. Third time. That's the point — I've now written
it three times and the architecture hasn't moved.

---

## 2. New idea #1: tools that compose into a pipeline

Previous agents had tools that were independent (weather OR crypto) or universal
(one shell tool). Here the three tools form a **chain**:

```
list_files(dir)  ->  gives paths
       |
       v
read_file(path)  ->  gives content       (repeated per file)
       |
       v
  [model analyses]
       |
       v
write_file(path, content)                (repeated per file)
```

The output of one tool becomes the input of the next. **I never wrote that
sequencing in JavaScript.** The model figures out the order from the tool
descriptions plus the system prompt. That's the agentic part.

Naming convention also changed to snake_case (`list_files`) — matches how most
function-calling APIs and docs write tool names. Cosmetic but standard.

---

## 3. New idea #2: autonomy (no REPL)

L1 and L2 ended with:
```js
while (true) {
  const question = readlineSync.question(...);   // human every turn
  ...
}
```

L3 has:
```js
const directory = process.argv[2] || '.';
await runAgent(directory);
```

One instruction in, then the agent runs until it decides it's finished. I cannot
steer it mid-run, correct a bad fix, or stop it before it writes.

**Trade-off:** less babysitting, less control. This is the same trade-off every
real coding agent makes, which is why they add confirmation prompts back in.

Also note `export async function runAgent` — it's now importable as a module, not
just a script. Small step toward being a reusable tool.

---

## 4. New idea #3: filesystem traversal

```js
function scan(dir) {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (fullPath.includes('node_modules') ||
        fullPath.includes('dist') ||
        fullPath.includes('build')) continue;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) scan(fullPath);        // recursion
    else if (extensions.includes(path.extname(item))) files.push(fullPath);
  }
}
```

Things to remember:
- **Recursive**, so nested folders are covered.
- `path.join` instead of string concat — handles `/` vs `\` across OSes.
  (Compare L2, where OS differences had to be handled *in the prompt*.
  Using `fs` instead of shell makes the cross-platform problem disappear.)
- The skip list is **essential**. Without it, `node_modules` means tens of
  thousands of files and the agent dies (or costs a fortune).
- `Sync` versions used throughout — fine for a CLI tool, would block a server.

---

## 5. ⚠ The dangerous bit: whole-file rewrite

```js
async function writeFile({ file_path, content }) {
  fs.writeFileSync(file_path, content, 'utf-8');   // overwrites entirely
}
```

The model must reproduce the **whole file** to change one line. Consequences:

1. **Truncation risk.** If the file is long, the model's response can hit the
   output token limit. The half-written file gets saved anyway. Silent data loss.
2. **No diff, no preview, no undo.** It's already saved before I see anything.
3. **Drift.** The model may "improve" formatting or rename things I never asked about.

Real tools avoid this by doing **patches / search-and-replace** instead of full
rewrites — smaller output, less truncation risk, reviewable as a diff.

**Rule for myself: never run this on anything not committed to git.**
`git diff` after the run is the actual review step.

---

## 6. How the parallel-call fix works here

L1/L2 used `functionCalls[0]` and dropped the rest. Now:

```js
for (const functionCall of result.functionCalls) {
  const toolResponse = await tools[name](args);
  History.push({ role: "model", parts: [{ functionCall }] });
  History.push({ role: "user",  parts: [{ functionResponse: {...} }] });
}
```

Every call gets executed — the real fix. But note it writes **one model turn +
one user turn per call**, so two simultaneous calls are recorded as if they
happened one after the other. Gemini accepts it (alternation is preserved), it
just isn't a truthful transcript.

More faithful version:
```js
History.push({ role: "model", parts: calls.map(fc => ({ functionCall: fc })) });
History.push({ role: "user",  parts: allResponses });   // all in ONE turn
```

---

## 7. The system prompt got much bigger

It now contains:
- a numbered workflow (list -> read -> analyse -> write -> report)
- a **taxonomy** of what to look for, split by HTML / CSS / JavaScript
- an **output template** for the final report (emoji sections, file:line format)
- a behavioural nudge: *"Actually FIX the code, don't just report."*

Lesson: as agents get more autonomous, the prompt has to carry more. There's no
human to correct course, so every expectation must be stated up front.

The output template is a cheap trick that works — showing the exact desired shape
gets far more consistent formatting than describing it.

---

## 8. Bugs / rough edges in this version

1. **No try/catch in any tool.** L2's `executeCommand` had one; these don't.
   A missing file, a permission error, or a binary file throws and kills the run —
   possibly after some files were rewritten and others weren't. Half-fixed repo.
2. **Unknown tool name crashes:** `tools[name]` is `undefined` -> TypeError.
3. **`process.argv[2] || '.'`** — no argument means "review the current directory",
   which is where `agent.js` lives. The agent will rewrite its own source.
4. **Context explosion.** Every file's full content stays in `History` forever.
   20 files x 200 lines = the whole codebase re-sent on every single API call.
   Cost grows quadratically-ish over a run.
5. **No max-iteration guard.** Nothing stops a read/write/read loop.
6. **Substring skip check:** `fullPath.includes('node_modules')` also skips a
   legit folder named e.g. `node_modules_backup`.
7. **No file size check** — a huge minified file blows the context in one read.
8. Symlinks could cause infinite recursion in `scan`.

---

## 9. Ideas to try myself (turning the gaps into practice)

- Wrap each tool in try/catch that returns `{ error: "..." }` instead of throwing
  — the model can then recover, same as any other tool result.
- Add a `MAX_STEPS` counter around the while loop.
- Add a dry-run mode: log the proposed content instead of writing.
- Back up to `file.bak` before overwriting.
- Replace `write_file` with `replace_in_file(path, old, new)` and see how much
  smaller and safer the outputs become.
- Refuse to run if `git status` isn't clean.

---

## 10. Mental model

> L1: the agent could **look things up**.
> L2: the agent could **create things**.
> L3: the agent can **modify things that already exist** — unsupervised.

Modifying existing work is a different risk class from creating new work. Creating
a bad file wastes time; rewriting a good file loses work.

The loop is unchanged for the third lecture running. Everything that matters now
lives in the **tools** and the **prompt**.

---

## Questions to test myself

1. Why does using `fs` instead of shell commands remove the cross-platform problem
   from L2?
2. What happens if the model's rewritten file exceeds the output token limit?
3. Why must `node_modules` be excluded — what are the two separate reasons?
4. Where does the sequencing (list -> read -> write) actually live in this program?
5. What single git command turns this agent from risky into safe to experiment with?

