# Lecture: Building My First AI Agent (Gemini + Function Calling)

**Stack:** Node.js, `@google/genai`, `gemini-2.5-flash`, `readline-sync`, `dotenv`

---

## 1. The core idea

An LLM by itself can only produce text. It cannot check today's Bitcoin price or
London's temperature, because that data did not exist when it was trained.

An **agent** = LLM + tools + a loop.

The critical insight: **the model never calls the tool itself.** It only *asks*
for a tool to be called. My code does the actual `fetch()` and hands the result
back. The model is the decision-maker; my code is the hands.

```
User question
   |
   v
Model decides: do I need a tool?
   |                        |
   NO                      YES
   |                        |
 answer                 returns functionCall { name, args }
                            |
                        MY CODE runs the real function
                            |
                        push result into history
                            |
                        loop back to the model
```

---

## 2. Three things a tool needs

### (a) The actual JavaScript function

```js
async function weatherInformation({ city }) {
	const response = await fetch(
		`http://api.weatherapi.com/v1/current.json?key=...&q=${city}&aqi=no`
	);
	return await response.json();
}
```

Note it destructures `{ city }` — the model sends args as an object.

### (b) The metadata / schema (this is what the model reads)

```js
const weatherInfo = {
	name: 'weatherInformation',
	description: 'You can get the current weather information of any city',
	parameters: {
		type: Type.OBJECT,
		properties: {
			city: {
				type: Type.STRING,
				description: 'Name of the city like london, goa etc',
			},
		},
		required: ['city'],
	},
};
```

**Key point:** the `description` fields are prompt engineering, not documentation.
They are the *only* thing the model uses to decide which tool to pick and what to
put in the arguments. Vague description = wrong tool choice.

`Type` is imported from `@google/genai` — it's their enum for JSON Schema types.

### (c) A name → function lookup table

```js
const toolFunctions = {
	cryptoCurrency: cryptoCurrency,
	weatherInformation: weatherInformation,
};
```

Needed because the model returns the tool name as a **string**. This maps that
string back to a callable function: `toolFunctions[name](args)`.

---

## 3. History — the thing that makes it an agent

The model is **stateless**. It remembers nothing between API calls. The entire
conversation must be re-sent every single time.

`History` is an array of turns. Each turn has a `role` and `parts`.

| role    | parts contain        | meaning                          |
| ------- | -------------------- | -------------------------------- |
| `user`  | `text`               | what I typed                     |
| `model` | `text`               | model's final answer             |
| `model` | `functionCall`       | model requesting a tool          |
| `user`  | `functionResponse`   | my code returning the tool result |

Counter-intuitive bit: the **tool result is pushed with `role: 'user'`**, not
'model' or 'tool'. From the model's perspective, the outside world (me) is
feeding it information, and that channel is `user`.

Turns must alternate correctly — a `model` turn containing a `functionCall` must
be followed by a `user` turn containing the matching `functionResponse`.

---

## 4. The two loops

### Inner loop — `runAgent()`

Runs until the model stops asking for tools.

```js
while (true) {
	const result = await ai.models.generateContent({
		model: 'gemini-2.5-flash',
		contents: History,
		config: { tools },
	});

	if (result.functionCalls && result.functionCalls.length > 0) {
		// run tool, push functionCall + functionResponse, loop again
	} else {
		// plain text answer -> log it and break
	}
}
```

Why a loop and not a single if? Because one question can need several tools
("weather in London AND price of Bitcoin"). Each pass gives the model one more
piece of information until it has everything and produces text.

The exit condition is always the same: **no function calls returned → final answer.**

### Outer loop — the CLI

```js
while (true) {
	const question = readlineSync.question('Ask me anything: ');
	if (question === 'exit') break;
	History.push({ role: 'user', parts: [{ text: question }] });
	await runAgent();
}
```

`readline-sync` is blocking, which is what we want here — no callbacks, code
reads top to bottom.

Because `History` lives outside both loops, the agent has memory across
questions. I can ask "and what about Mumbai?" and it knows we were discussing
weather.

---

## 5. Setup details

```js
import 'dotenv/config';
const ai = new GoogleGenAI({});
```

The empty `{}` is not a mistake — the SDK automatically reads `GEMINI_API_KEY`
from the environment, which `dotenv/config` loaded. That import must come before
the client is created.

`"type": "module"` must be in `package.json` for the `import` syntax to work.

---

## 6. Mental model to remember

> The model is a **router**, not an executor.

Everything else is plumbing: keep an array, append to it correctly, re-send it
every time, and stop looping when text comes back instead of a function call.

Adding a third tool = write the function, write the schema, add one line to
`toolFunctions`. Nothing else changes. That's the pattern worth memorising.

---

## 7. Things I noticed / to revisit later

- Only `functionCalls[0]` is handled. If the model returns two calls at once, the
  second is dropped — but the loop re-runs, the model notices the missing info
  and asks again. Works, costs an extra round trip.
- No error handling on the fetches. A wrong coin id returns `[]` from CoinGecko
  and the model may invent a number instead of saying "not found".
- History grows forever — every question re-sends the whole transcript. Fine for
  a demo, matters for cost later. → leads into memory / trimming / RAG.


---

## Questions to test myself

1. Why is the tool result pushed with `role: 'user'`?
2. What exactly makes the inner `while` loop terminate?
3. If I delete the `description` of a tool, what breaks and why?
4. Where does the model get the API key for weatherapi.com from? (Trick question.)
5. What happens if I remove `History` from outside the loops?
