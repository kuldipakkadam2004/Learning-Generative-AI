# Lecture: Simple RAG (PDF → Pinecone → Grounded Answers) + Homework

**Stack:** LangChain, `@langchain/google-genai`, Pinecone, `text-embedding-004`, `gemini-2.5-flash`

---

## 1. This lecture is NOT an agent

Important reset. Lectures 1–3 were all the same architecture. This one isn't.

| | Agents (L1–L3) | RAG (L4) |
| --- | --- | --- |
| Control flow | **loop** — model decides next step | **pipeline** — fixed steps, fixed order |
| Model's role | router / decision maker | text generator at the last step only |
| `History` | central, grows every turn | **absent** — no memory at all |
| Tools | yes | none |
| Runs | until model stops calling tools | exactly once per question |

Same steps every single time:

```
question → embed → search → stuff into prompt → generate → print
```

No branching. No decisions. RAG solves a *knowledge* problem, agents solve an
*action* problem.

> ⚠ Note for later: **the homework breaks this table.** Once an intent model is
> added, a decision point appears and the pipeline starts becoming agentic again.
> See §9.

---

## 2. The problem RAG solves

The model doesn't know my Node.pdf. Three options:

1. **Fine-tune** — expensive, slow, needs re-doing when the doc changes
2. **Paste the whole PDF into the prompt** — too big, expensive per call, and
   accuracy degrades in long contexts
3. **RAG** — fetch only the ~10 relevant chunks and paste those ✅

Core insight: **don't make the model know more, make the prompt contain more of
the right thing.**

---

## 3. Two separate programs (key structural idea)

### `indexing.js` — runs ONCE, offline, slow
```
PDF → load → split into chunks → embed each chunk → store vectors in Pinecone
```

### `query.js` — runs per question, online, fast
```
question → embed → similarity search → build context → prompt → answer
```

Why split? Embedding 266 chunks takes time and money. Doing it per question would
be absurd. **Pay once at index time, reuse forever at query time.**

The only things connecting them: the Pinecone index, and the fact that both files
must use the **exact same embedding model**.

---

## 4. Indexing, step by step

```js
const pdfLoader = new PDFLoader(PDF_PATH);
const rawDocs = await pdfLoader.load();      // one Document per PAGE
```

```js
const textSplitter = new RecursiveCharacterTextSplitter({
  chunkSize: 1000,
  chunkOverlap: 200,
});
const chunkedDocs = await textSplitter.splitDocuments(rawDocs);   // 266 chunks
```

**Why chunk at all?**
- A whole page is too coarse — retrieving it brings a lot of irrelevant text
- Embeddings represent one "meaning" each; a big mixed blob has a blurry meaning
- Context window is finite

**Why "Recursive"?** It tries separators in order of preference:
`\n\n` (paragraph) → `\n` (line) → ` ` (word) → character.
Splits at natural boundaries first, butchers mid-word only as a last resort.

**Why `chunkOverlap: 200`?** (20% of chunk size)
A sentence straddling a chunk boundary would be cut in half and retrievable from
neither chunk. Overlap puts boundary content in *both* neighbours. Costs ~20% more
storage. Worth it.

```js
await PineconeStore.fromDocuments(chunkedDocs, embeddings, {
  pineconeIndex,
  maxConcurrency: 5,
});
```
One call = embed all chunks + upload all vectors. `maxConcurrency: 5` = 5 parallel
requests, to stay under rate limits.

---

## 5. Querying, step by step

```js
const queryVector = await embeddings.embedQuery(question);
```
The question becomes a vector in the **same space** as the chunks. Similar meaning
→ nearby vectors, regardless of shared words. That's the whole trick.

```js
const searchResults = await pineconeIndex.query({
  topK: 10, vector: queryVector, includeMetadata: true,
});
```
`includeMetadata: true` is **mandatory** — without it I get IDs and scores but no
text, and there's nothing to put in the prompt.

```js
const context = searchResults.matches
  .map(match => match.metadata.text)
  .join('\n\n---\n\n');
```
The `---` separator tells the model these are *distinct, unordered* excerpts, not
one continuous passage.

**Size check:** 10 chunks × 1000 chars ≈ 10,000 chars ≈ 2,500 tokens per question.

---

## 6. ⚠ The `metadata.text` coupling (subtle, will bite me)

`PineconeStore.fromDocuments` stores each chunk's page content inside metadata
under the key `text` — LangChain's default `textKey`.

`query.js` then reads `match.metadata.text`.

**The two files agree by convention, not by any enforced contract.** Change the
`textKey` in one place and the other returns `undefined` for every match. Context
becomes the literal string `"undefined"`, and the model politely says it doesn't
have enough information. **No error is thrown anywhere.**

Coupling-free alternative:
```js
const store = await PineconeStore.fromExistingIndex(embeddings, { pineconeIndex });
const docs = await store.similaritySearch(question, 10);
const context = docs.map(d => d.pageContent).join('\n\n---\n\n');
```

---

## 7. The prompt: grounding instructions

```
- Answer using ONLY the information from the context above
- If the answer is not in the context, say "I don't have enough information..."
```

The anti-hallucination clamp. Without it the model fills gaps from general
training and I can't tell retrieved facts from invented ones.

`temperature: 0.3` — low on purpose. Factual grounding task; creativity is a bug
here, not a feature.

### LCEL chain
```js
const chain = RunnableSequence.from([promptTemplate, model, new StringOutputParser()]);
const answer = await chain.invoke({ context, question });
```
Function composition: fill template → call model → extract plain string.
`StringOutputParser` unwraps the `AIMessage` so I get text, not `.content`.

---

## 8. Gotchas in the original version

1. **Re-running `indexing.js` duplicates everything.** No IDs or namespace, so
   Pinecone assigns random IDs each run. Two runs = 532 vectors, duplicates
   competing for the same `topK: 10` slots.
2. **Dimension lock-in.** `text-embedding-004` = **768 dims**. Pinecone index must
   match. Switching embedding models later = re-index from scratch.
3. **Both files MUST use the same embedding model.** Different models = different
   vector spaces = meaningless similarity scores.
4. **No conversation memory.** Every question standalone. → fixed by homework.
5. **`main()` recurses with no exit condition.** Ctrl+C only. → fixed.
6. **Page numbers thrown away.** `metadata.loc.pageNumber` exists but is unused.
   → fixed, enables citations.
7. **No score threshold.** Always returns 10 chunks even for unrelated questions,
   so garbage gets stuffed into the prompt. → fixed.
8. **No error handling** — missing PDF, bad key, Pinecone timeout all crash.
9. **Inconsistent config style** — key passed explicitly to embeddings, but
   `new Pinecone()` reads `PINECONE_API_KEY` implicitly.

---

# 9. HOMEWORK — "introduce intent model" ✅ DONE

## 9.1 What problem it actually solves

Two separate problems, one solution.

### Problem A: wasted work on non-questions
"hi", "thanks", "who are you" → the original code embeds them, searches Pinecone,
retrieves 10 irrelevant chunks, and stuffs them into the prompt. Pointless cost,
weird answers.

### Problem B: follow-up questions retrieve nothing (the important one)
```
User: "what is middleware?"
Bot:  [explains middleware]
User: "give me an example"        ← retrieval FAILS here
```

**Why it fails:** "give me an example" contains no topical content. Its embedding
is a vector for the *concept of requesting an example* — it points nowhere near
the middleware chunks. The failure happens at **retrieval**, before generation
ever runs. The model isn't confused; it genuinely receives the wrong context.

**Fix:** rewrite the follow-up into a standalone question *before* embedding.
```
"give me an example"  →  "give me an example of middleware in Node.js"
```
Now the vector lands in the right neighbourhood.

## 9.2 The new architecture

The pipeline is no longer straight — it **branches**:

```
question
   │
   ▼
[intent model]  ── CHITCHAT ──────► friendly reply, NO retrieval
   │            ── OUT_OF_SCOPE ──► decline, NO retrieval
   │
   └─ RETRIEVE ─► embed REWRITTEN question
                     ▼
                  Pinecone search (topK 10)
                     ▼
                  filter by score >= MIN_SCORE
                     ▼
                  build context (with page numbers)
                     ▼
                  answer model
```

## 9.3 Design decisions (and why)

### One LLM call, not two
Classification and rewriting are done in the **same** request, returning JSON:
```json
{ "intent": "RETRIEVE", "standalone_question": "...", "reason": "..." }
```
Both jobs need the same input (history + question). Splitting them pays the
latency twice for no gain.

### `temperature: 0` for the intent model
Separate model instance from the answering one. Classification should be
deterministic — same input, same route. The answering model stays at `0.3`.

**Two model instances with different temperatures for different jobs** is a
pattern worth remembering.

### Fail OPEN, not closed
```js
const fallback = {
  intent: 'RETRIEVE',
  standalone_question: question,
  reason: 'intent step failed, defaulting to retrieval',
};
```
If the JSON is malformed or the API errors, default to retrieving with the
original question — i.e. **exactly the old behaviour**. A broken router degrades
to the previous lecture's code instead of breaking the app.

### Strip markdown fences before parsing
```js
const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
```
Models wrap JSON in ` ```json ` fences despite being told not to. Often enough
that unguarded `JSON.parse` will throw in real use.

### Store the ORIGINAL question in history, never the rewritten one
```js
history.push({ role: 'user', text: question });   // original
```
If rewrites are stored, they **compound**: "give me an example" becomes "an
example of middleware", and the next follow-up rewrites against *that* instead of
what I actually typed. Drift builds over a few turns.

### Validate the returned intent
```js
if (!['RETRIEVE','CHITCHAT','OUT_OF_SCOPE'].includes(parsed.intent)) return fallback;
```
Valid JSON can still contain an invented intent string. Parsing successfully ≠
getting a usable value.

## 9.4 Prompt techniques used in the intent prompt

- **Enumerated output type:** `"intent": "RETRIEVE" | "CHITCHAT" | "OUT_OF_SCOPE"`
- **Worked examples of rewriting** — showing two before→after pairs works far
  better than describing the rule
- **Explicit negative constraint:** *"Do not add topics that were never
  mentioned"* — stops the model inventing context
- **Escaped braces** `{{ }}` in `PromptTemplate` — single braces are variable
  slots, so literal JSON braces must be doubled or LangChain throws
- **A `reason` field** — makes the routing debuggable in the terminal

## 9.5 Bonus fixes shipped alongside

**Score threshold**
```js
const kept = matches.filter(m => m.score >= MIN_SCORE);
```
`topK` always returns 10, however bad. Without a floor, an unrelated question
still fills the prompt with the 10 *least dissimilar* chunks. If nothing survives
the filter, say so instead of guessing.

**Tuning method:** the scores are logged every query. Ask 3 questions known to be
in the PDF and 1 clearly outside it, look at where the two clusters sit, put the
threshold between them. With `text-embedding-004`, genuinely relevant chunks
usually land ~0.7+, so 0.5 may be too permissive.

**Page citations**
```js
const page = m.metadata?.loc?.pageNumber;
`[Excerpt ${i+1} (page ${page})]`
```
`PDFLoader` already provides this — it was just being discarded. Labelling each
excerpt lets the model cite "(page 42)". Biggest credibility upgrade per line of
code in the whole file.

**Proper CLI loop** — `while (true)` with an `exit` check, replacing the
self-recursion. Plus try/catch so one bad question doesn't kill the session.

## 9.6 How to verify it works

```
Ask me anything--> what is middleware?
Ask me anything--> give me an example
```
Watch the `rewritten:` line on the second question. If it doesn't expand to
mention middleware, the rewriting prompt needs work — **that failure is the whole
point of the homework.**

Also test:
- `hi` → should route CHITCHAT, zero Pinecone calls
- `what is the recipe for biryani` → should route OUT_OF_SCOPE
- a question about a topic definitely not in the PDF → should hit the score
  filter and return the "nothing relevant" message

---

## 10. Mental model

> Embeddings turn *meaning* into *coordinates*.
> Once meaning is coordinates, "find relevant text" becomes "find nearby points" —
> just maths, which is fast and cheap.

RAG = search engine + prompt stuffing. Nothing mystical. The hard parts are all in
the details: chunk size, overlap, topK, score threshold, and **whether the query I
embedded was the right query in the first place** (which is what the homework is
really about).

> **Retrieval quality caps answer quality.** No prompt can rescue a bad retrieval.
> That's why the intent model sits at the *front* of the pipeline.

---

## 11. Where this connects onward

- The intent model is a **router** — the same role the model plays in L1–L3 agents.
  RAG and agents are converging.
- Next natural step: make retrieval a **tool** the agent can choose to call,
  instead of a fixed pipeline stage. Then it decides *whether* to search, and can
  search more than once.
- Pinecone maps directly onto **pgvector**: index → a table with a `vector(768)`
  column; `topK: 10` → `ORDER BY embedding <=> $1 LIMIT 10`. Same maths, and
  relational data stays in the same database.

---

## Questions to test myself

1. Why can't `indexing.js` and `query.js` use different embedding models?
2. What exactly breaks — and what's the symptom — if `includeMetadata` is `false`?
3. Why is `chunkOverlap` needed? What's the cost of setting it too high?
4. What does "Recursive" refer to in `RecursiveCharacterTextSplitter`?
5. If I run `indexing.js` twice, what happens to answer quality, and why?
6. Why does "give me an example" fail — and at which *stage* does it fail?
7. Why is the original question stored in history rather than the rewritten one?
8. Why does the intent model use `temperature: 0` when the answer model uses `0.3`?
9. What does "fail open" mean here, and what would "fail closed" have looked like?
10. Why must `{{` and `}}` be doubled inside a `PromptTemplate`?
11. Why is a score threshold needed when `topK` already limits the results?
