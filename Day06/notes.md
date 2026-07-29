# Lecture: The Website Builder Agent (Shell Command Execution)

**Stack:** Node.js, `@google/genai`, `gemini-2.5-flash`, `child_process`, `os`, `util`

---

## 1. What actually changed from last lecture

| | Lecture 1 (weather/crypto) | Lecture 2 (website builder) |
| --- | --- | --- |
| Tools | 2, narrow | 1, universal |
| Effect | read-only | **writes to my disk** |
| Tool logic | one API per tool | one `exec()` for everything |
| Where the "program" lives | in the JS functions | in the **system instruction** |
| Failure cost | wrong answer | wrong files, deleted files |

The loop, the history handling, the schema pattern — all identical. **Nothing about
the agent architecture changed.** Only the tool changed, and that changed everything
about what the agent can do.

This is the real lesson: agent capability is defined almost entirely by its tools.

---

## 2. The "universal tool" idea

Instead of writing a `createFolder` tool, a `writeFile` tool, a `deleteFile` tool...
give the model **one tool that runs any shell command**.

```js
async function executeCommand({ command }) {
	try {
		const { stdout, stderr } = await execute(command);
		if (stderr) return `Error: ${stderr}`;
		return `Success: ${stdout}`;
	} catch (err) {
		return `Error: ${err}`;
	}
}
```

The entire filesystem API (`mkdir`, `touch`, `cat`, `rm`, `echo`, `mv`) comes for free,
because the shell already implements it. The model already knows shell syntax from
training, so no teaching required.

**Trade-off:** one tool that can do anything is also one tool that can destroy anything.
There's no way to grant "create files" without also granting "delete files".

---

## 3. New Node.js pieces

```js
import { exec } from "child_process";
import util from "util";
import os from "os";

const execute = util.promisify(exec);
const platform = os.platform();
```

- `exec` is callback-based by default. `util.promisify` converts it so I can `await` it.
- `os.platform()` returns `'win32'`, `'darwin'` (Mac), or `'linux'`.
- That platform string is injected into the system prompt so the model writes
  the right *dialect* of commands.

---

## 4. The system instruction IS the program

This is the biggest shift in thinking. In lecture 1 the system prompt was a nicety.
Here it contains the entire build procedure:

```
1: create the folder            ex: mkdir calculator
2: create html file             ex: touch calculator/index.html
3: create CSS file
4: create Javascript file
5: write on html file
6: write on css file
7: write on javascript file
8: fix errors if present
```

I wrote **zero lines of JavaScript** describing how to build a website. The
"algorithm" is English in a string. Change the string, change the program.

Also inside it: `My Current user Operating system is: ${platform}` — runtime data
interpolated into the prompt. The prompt is dynamic, not a constant.

---

## 5. The cross-platform problem (why the commented block exists)

Creating an empty file is easy. Writing **multi-line content** into a file from a
single shell command is where OSes diverge:

**Mac/Linux — heredoc:**
```
cat > calculator/index.html << 'EOF'
<!DOCTYPE html>
<html>...</html>
EOF
```

**Windows cmd — echo with escaped angle brackets:**
```
echo ^<!DOCTYPE html^> > calculator\index.html
echo ^<html^> >> calculator\index.html
```
(`^` escapes `<` and `>`, because those mean redirection in cmd. `>` overwrites,
`>>` appends.)

If the model guesses the wrong dialect, it produces garbage files that "succeed"
silently. Hence pinning the platform in the prompt.

---

## 6. ⚠ Gotcha: the shell is stateless between calls

**Every `execute()` call spawns a brand-new shell process that dies immediately after.**

That means:
```
call 1:  cd calculator          <- new shell, cd's, then exits
call 2:  touch index.html       <- NEW shell, back at original directory!
```

The file lands in the wrong place. `cd` never persists. Same for environment
variables, activated venvs, anything shell-session-based.

**Workarounds:**
- Always use paths relative to the project root: `calculator/index.html` (what
  the system prompt does)
- Or chain in one command: `cd calculator && touch index.html`
- Or pass a working directory: `exec(command, { cwd: projectDir })`

---

## 7. stdout vs stderr

- `stdout` = normal output
- `stderr` = error output... **and also warnings, progress bars, npm/git chatter**

The current code treats *any* stderr content as failure. That's a false positive
generator — a successful command that printed a warning gets reported to the model
as an error, and the model may "fix" something that wasn't broken.

More reliable signal: the **exit code** (0 = success). `exec` throws on a non-zero
exit code, which the `catch` already handles.

---

## 8. Bugs / rough edges spotted in this version

1. **Dead code after `break`:**
   ```js
   } else {
       break;                     // runs first
       console.log(result.text);  // unreachable
       History.push({...});       // unreachable
   }
   ```
   The final text answer is never printed and never saved to history.
   Fix = move `break` to the end of the block.

2. `functionCalls[0]` only — same as lecture 1. Less harmful here since file
   operations are naturally sequential.

3. No `maxBuffer` setting on `exec` (default ~1MB). Reading a big file could throw.

4. No confirmation before destructive commands. The model could emit `rm -rf`.

5. History grows unbounded across questions.

---

## 9. Safety notes (important for this lecture specifically)

This agent has **the same permissions I do**. Whatever I can delete, it can delete.

Habits to build:
- Run it from a dedicated scratch/sandbox folder, never from home or a real project
- Keep the project under git so mistakes are recoverable
- Real tools (Claude Code, Cursor) prompt before destructive operations — that
  confirmation step is a feature, not friction
- Eventually: a whitelist/blacklist of allowed command prefixes before executing

---

## 10. Mental model

> Lecture 1 taught the agent to **look things up**.
> Lecture 2 taught it to **take actions**.
> The difference between a chatbot and an agent is precisely this: side effects.

The loop never changed. Only the blast radius did.

---

## Questions to test myself

1. Why does `cd` in one command not affect the next command?
2. What's actually printed to the terminal when the build finishes, and why?
3. Why does the platform get injected into the system prompt instead of hardcoded?
4. If I wanted to add "run npm install" capability, how much code would I write?
5. Why is "any stderr output = error" a bad rule?
6. What single change would make this agent safe to run in my home directory?
