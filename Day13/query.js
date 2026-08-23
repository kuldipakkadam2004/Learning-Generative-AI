import readlineSync from 'readline-sync';
import {
	GoogleGenerativeAIEmbeddings,
	ChatGoogleGenerativeAI,
} from '@langchain/google-genai';
import { Pinecone } from '@pinecone-database/pinecone';
import * as dotenv from 'dotenv';
import { PromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { RunnableSequence } from '@langchain/core/runnables';

dotenv.config();

// config

const TOP_K = 10;
const MIN_SCORE = 0.5; // drop weak matches; tune after watching real scores
const HISTORY_TURNS = 3; // how many past exchanges the rewriter can see

const embeddings = new GoogleGenerativeAIEmbeddings({
	apiKey: process.env.GEMINI_API_KEY,
	model: 'text-embedding-004',
});

// Answering model: low temperature, this is a factual task
const model = new ChatGoogleGenerativeAI({
	apiKey: process.env.GEMINI_API_KEY,
	model: 'gemini-2.5-flash',
	temperature: 0.3,
});

// Intent model: temperature 0, we want deterministic classification
const intentModel = new ChatGoogleGenerativeAI({
	apiKey: process.env.GEMINI_API_KEY,
	model: 'gemini-2.5-flash',
	temperature: 0,
});

const pinecone = new Pinecone();
const pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);

// Short rolling memory — needed so follow-up questions can be rewritten
const history = [];

function historyAsText() {
	if (history.length === 0) return '(no previous conversation)';
	return history
		.slice(-HISTORY_TURNS * 2)
		.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
		.join('\n');
}

// ------------------------------------------------- STEP 1: the intent model

const intentPrompt = PromptTemplate.fromTemplate(`
You are the routing layer of a documentation assistant for a Node.js PDF.
Classify the user's latest message and rewrite it for vector search.

Conversation so far:
{history}

Latest user message: {question}

Return ONLY a JSON object, no markdown fences, no explanation:
{{
  "intent": "RETRIEVE" | "CHITCHAT" | "OUT_OF_SCOPE",
  "standalone_question": "...",
  "reason": "one short sentence"
}}

Intent rules:
- "RETRIEVE": a real question about Node.js or the documentation, including
  vague follow-ups like "give me an example" or "why?".
- "CHITCHAT": greetings, thanks, goodbyes, questions about you.
- "OUT_OF_SCOPE": a genuine request that this Node.js documentation cannot
  answer (cooking, sports, unrelated languages, personal advice).

Rewriting rules for "standalone_question":
- It must make full sense with NO conversation history attached.
- Resolve every pronoun and reference using the conversation above.
  "give me an example" after discussing middleware
    -> "give me an example of middleware in Node.js"
  "what about the async version?" after discussing fs.readFileSync
    -> "what is the async version of fs.readFileSync in Node.js"
- Keep the user's technical terms exactly as written. Do not add topics
  that were never mentioned.
- For CHITCHAT or OUT_OF_SCOPE, copy the original message unchanged.
`);

async function classifyIntent(question) {
	// If anything goes wrong, fail OPEN: assume it's a real question.
	const fallback = {
		intent: 'RETRIEVE',
		standalone_question: question,
		reason: 'intent step failed, defaulting to retrieval',
	};

	try {
		const chain = RunnableSequence.from([
			intentPrompt,
			intentModel,
			new StringOutputParser(),
		]);

		const raw = await chain.invoke({
			history: historyAsText(),
			question,
		});

		// The model sometimes wraps JSON in ```json fences despite instructions
		const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
		const parsed = JSON.parse(cleaned);

		if (!['RETRIEVE', 'CHITCHAT', 'OUT_OF_SCOPE'].includes(parsed.intent)) {
			return fallback;
		}

		return {
			intent: parsed.intent,
			standalone_question: parsed.standalone_question?.trim() || question,
			reason: parsed.reason ?? '',
		};
	} catch (err) {
		console.log(`  (intent step failed: ${err.message})`);
		return fallback;
	}
}

// --------------------------------------------------- STEP 2: retrieval

async function retrieve(standaloneQuestion) {
	const queryVector = await embeddings.embedQuery(standaloneQuestion);

	const searchResults = await pineconeIndex.query({
		topK: TOP_K,
		vector: queryVector,
		includeMetadata: true,
	});

	const matches = searchResults.matches ?? [];
	const kept = matches.filter((m) => m.score >= MIN_SCORE);

	const scores = matches.map((m) => m.score.toFixed(2)).join(', ');
	console.log(`  scores: [${scores}]`);
	console.log(`  kept ${kept.length}/${matches.length} above ${MIN_SCORE}`);

	return kept;
}

function buildContext(matches) {
	return matches
		.map((m, i) => {
			// PDFLoader stores the source page here — gives us citations
			const page = m.metadata?.loc?.pageNumber;
			const label = page ? `Excerpt ${i + 1} (page ${page})` : `Excerpt ${i + 1}`;
			return `[${label}]\n${m.metadata?.text ?? ''}`;
		})
		.join('\n\n---\n\n');
}

// --------------------------------------------------- STEP 3: answering

const answerPrompt = PromptTemplate.fromTemplate(`
You are a helpful assistant answering questions based on the provided documentation.

Context from the documentation:
{context}

Question: {question}

Instructions:
- Answer the question using ONLY the information from the context above
- If the answer is not in the context, say "I don't have enough information to answer that question."
- Cite the page number when you use an excerpt, like (page 42)
- Be concise and clear
- Use code examples from the context if relevant

Answer:
`);

const chitchatPrompt = PromptTemplate.fromTemplate(`
You are a friendly assistant that answers questions about a Node.js PDF.

Conversation so far:
{history}

User: {question}

Reply in one or two short sentences. Be warm but brief, and steer the user
back toward asking something about the Node.js documentation.
`);

async function answerFromContext(question, context) {
	const chain = RunnableSequence.from([
		answerPrompt,
		model,
		new StringOutputParser(),
	]);
	return chain.invoke({ context, question });
}

async function answerChitchat(question) {
	const chain = RunnableSequence.from([
		chitchatPrompt,
		model,
		new StringOutputParser(),
	]);
	return chain.invoke({ history: historyAsText(), question });
}

// ------------------------------------------------------- the pipeline

async function chatting(question) {
	const { intent, standalone_question, reason } = await classifyIntent(question);

	console.log(`\n  intent: ${intent} — ${reason}`);
	if (standalone_question !== question) {
		console.log(`  rewritten: "${standalone_question}"`);
	}

	let answer;

	if (intent === 'CHITCHAT') {
		answer = await answerChitchat(question);
	} else if (intent === 'OUT_OF_SCOPE') {
		answer =
			"That's outside what this Node.js documentation covers, so I can't answer it from the source. Ask me something about Node.js and I'll dig into the PDF.";
	} else {
		const matches = await retrieve(standalone_question);

		if (matches.length === 0) {
			answer =
				"I don't have enough information to answer that question — nothing in the documentation came back as relevant.";
		} else {
			answer = await answerFromContext(standalone_question, buildContext(matches));
		}
	}

	console.log(`\n${answer}\n`);

	// Store the ORIGINAL question, so the rewriter sees what the user really typed
	history.push({ role: 'user', text: question });
	history.push({ role: 'assistant', text: answer });
}

// ------------------------------------------------------------- the CLI

async function main() {
	console.log('Ask about the Node.js docs. Type "exit" to quit.\n');

	while (true) {
		const userProblem = readlineSync.question('Ask me anything--> ');

		if (userProblem.trim().toLowerCase() === 'exit') break;
		if (!userProblem.trim()) continue;

		try {
			await chatting(userProblem);
		} catch (err) {
			console.error(`\nSomething went wrong: ${err.message}\n`);
		}
	}
}

main();