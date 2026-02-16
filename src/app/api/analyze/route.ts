import { NextRequest, NextResponse } from "next/server";

// FASE 1 FIX: Explicit Node runtime (required for fs, child_process, yt-dlp)
export const runtime = 'nodejs';
// FASE 1 FIX: Set max duration for Vercel (60s for Pro, 10s for Hobby)
export const maxDuration = 60;
import { getTranscript } from "@/lib/youtube";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";
import { z } from "zod";
import { tavily } from "@tavily/core";
import { DEMO_VIDEO_ID, DEMO_RESPONSE } from "@/lib/demo-cache";

// ============================================================
// Provider Setup
// ============================================================

const google = createGoogleGenerativeAI({
    apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || "",
});
const openai = createOpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
});
const groq = createOpenAI({
    baseURL: "https://api.groq.com/openai/v1",
    apiKey: process.env.GROQ_API_KEY || "",
});

// Auto-select: Google > Groq > OpenAI
const isGroq = !process.env.GOOGLE_GENERATIVE_AI_API_KEY && !!process.env.GROQ_API_KEY;

// Tiered model strategy for Groq free tier:
// - modelHeavy (70B): used ONLY for claim extraction & manipulation analysis (complex reasoning)
// - modelLight (8B):  used for individual claim verification & summary (simple, repetitive)
// This splits token usage across two separate Groq rate-limit pools (each model has its own TPD)
const modelHeavy =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
        ? google("gemini-1.5-flash")
        : process.env.GROQ_API_KEY
            ? groq("llama-3.3-70b-versatile")
            : openai("gpt-4o");

const modelLight =
    process.env.GOOGLE_GENERATIVE_AI_API_KEY
        ? google("gemini-1.5-flash")
        : process.env.GROQ_API_KEY
            ? groq("llama-3.1-8b-instant")
            : openai("gpt-4o");

const MAX_TRANSCRIPT_CHARS = isGroq ? 24000 : 15000;
const LIGHT_MODEL_TRANSCRIPT_CHARS = 16000;
const VERIFY_CONCURRENCY = isGroq ? 1 : 3;
const VERIFY_DELAY_MS = isGroq ? 2000 : 300;
const MAX_CLAIMS = isGroq ? 10 : 10;

let heavyModelBlockedUntil = 0;
let tavilyBlockedUntil = 0;

function parseRetryAfterMs(message: string): number | null {
    const hours = message.match(/(\d+)h/i);
    const minutes = message.match(/(\d+)m/i);
    const seconds = message.match(/(\d+(?:\.\d+)?)s/i);

    if (!hours && !minutes && !seconds) return null;

    const totalSeconds =
        (hours ? Number(hours[1]) * 3600 : 0) +
        (minutes ? Number(minutes[1]) * 60 : 0) +
        (seconds ? Number(seconds[1]) : 0);

    return Math.max(0, Math.round(totalSeconds * 1000));
}

function markHeavyModelBlocked(message: string): void {
    const retryMs = parseRetryAfterMs(message) ?? 10 * 60 * 1000;
    const nextUntil = Date.now() + retryMs;
    heavyModelBlockedUntil = Math.max(heavyModelBlockedUntil, nextUntil);
}

function isHeavyModelOnCooldown(): boolean {
    return isGroq && Date.now() < heavyModelBlockedUntil;
}

function isTavilyOnCooldown(): boolean {
    return Date.now() < tavilyBlockedUntil;
}

function isTavilyQuotaError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
        lower.includes("tavily") &&
        (
            lower.includes("usage limit") ||
            lower.includes("plan") ||
            lower.includes("quota") ||
            lower.includes("429")
        )
    );
}

function markTavilyBlocked(message: string): void {
    const retryMs = parseRetryAfterMs(message) ?? 15 * 60 * 1000;
    tavilyBlockedUntil = Math.max(tavilyBlockedUntil, Date.now() + retryMs);
}

// Tavily for web search verification
const tvly = process.env.TAVILY_API_KEY
    ? tavily({ apiKey: process.env.TAVILY_API_KEY })
    : null;

// ============================================================
// Types & Schemas
// ============================================================

interface ExtractedClaim {
    claim: string;
    timestamp: string;
    query: string;
}

interface VerifiedClaim {
    claim: string;
    timestamp: string;
    verdict: "True" | "False" | "Unverified";
    confidence: number;
    source: string;
    reasoning: string;
}

const VerificationSchema = z.object({
    verdict: z.enum(["True", "False", "Unverified"]),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
});

const LOW_TRUST_DOMAINS = [
    "brainly.",
    "quora.",
    "reddit.",
    "wikihow.",
    "fandom.",
    "answers.",
    "forum",
];

function domainScore(url: string): number {
    try {
        const host = new URL(url).hostname.toLowerCase();
        const isLowTrust = LOW_TRUST_DOMAINS.some((d) => host.includes(d));
        return isLowTrust ? -1 : 1;
    } catch {
        return 0;
    }
}

function normalizeVerdictByReasoning(
    verdict: "True" | "False" | "Unverified",
    reasoning: string,
): "True" | "False" | "Unverified" {
    const r = reasoning.toLowerCase();
    const looksLikeMissingEvidence =
        r.includes("no evidence") ||
        r.includes("no information") ||
        r.includes("insufficient") ||
        r.includes("cannot verify") ||
        r.includes("not directly") ||
        r.includes("not enough");

    if (looksLikeMissingEvidence) return "Unverified";
    return verdict;
}

// ============================================================
// Manipulation / Propaganda Tactics
// ============================================================

const TACTICS = [
    "Appeal to Emotion",
    "Appeal to Authority",
    "Cherry-Picking",
    "False Dichotomy",
    "Loaded Language",
    "Bandwagon",
    "Strawman",
    "Repetition",
] as const;

type TacticName = typeof TACTICS[number];

interface ManipulationTactic {
    tactic: TacticName;
    score: number;       // 0–100 intensity
    example: string;     // quote from transcript
    explanation: string; // why this is manipulative
}

interface ManipulationAnalysis {
    tactics: ManipulationTactic[];
    manipulationScore: number; // 0–100 overall
    summary: string;
}

// ============================================================
// Robust JSON Extraction (handles truncated Groq responses)
// ============================================================

function extractJSON(text: string): Record<string, unknown> | null {
    // Clean up markdown code fences if present
    let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    // Pre-process: fix common LLM JSON mistakes
    // 1. Fix missing commas between objects in arrays: `} {` → `},{`
    cleaned = cleaned.replace(/\}\s*\{/g, "},{");
    // 2. Fix missing commas between array items: `] [` → `],[`
    cleaned = cleaned.replace(/\]\s*\[/g, "],[");
    // 2b. Fix malformed claims lists like `[ {..} ], [ {..} ]` → `{..}, {..}`
    cleaned = cleaned.replace(/\]\s*,\s*\[\s*\{/g, ",{");
    // 3. Fix trailing commas before closing brackets: `,]` → `]` and `,}` → `}`
    cleaned = cleaned.replace(/,\s*\]/g, "]").replace(/,\s*\}/g, "}");

    // Strategy 1: balanced-brace extraction
    const startIdx = cleaned.indexOf("{");
    if (startIdx !== -1) {
        let depth = 0;
        for (let i = startIdx; i < cleaned.length; i++) {
            if (cleaned[i] === "{") depth++;
            else if (cleaned[i] === "}") depth--;
            if (depth === 0) {
                const candidate = cleaned.substring(startIdx, i + 1);
                try {
                    return JSON.parse(candidate);
                } catch {
                    // Try fixing unescaped quotes inside string values
                    try {
                        const fixed = fixUnescapedQuotes(candidate);
                        return JSON.parse(fixed);
                    } catch { break; }
                }
            }
        }
    }

    // Strategy 2: try to REPAIR truncated JSON
    if (startIdx !== -1) {
        let jsonStr = cleaned.substring(startIdx);

        // Remove the last incomplete entry (truncated claim)
        const lastCompleteComma = jsonStr.lastIndexOf("},");

        if (lastCompleteComma > 0) {
            jsonStr = jsonStr.substring(0, lastCompleteComma + 1) + "]}";
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed && (parsed.claims || parsed.topic)) {
                    console.log("[Veritas] Recovered truncated JSON successfully");
                    return parsed;
                }
            } catch { /* try next strategy */ }
        }

        // Try even more aggressive: truncate at last safe point, then close all open brackets
        let repaired = jsonStr;
        const lastSafe = Math.max(repaired.lastIndexOf(","), repaired.lastIndexOf("}"));
        if (lastSafe > 0) {
            repaired = repaired.substring(0, lastSafe + 1);
        }

        // Recount braces AFTER truncation so closing counts are accurate
        let openBraces = 0, openBrackets = 0;
        for (const ch of repaired) {
            if (ch === "{") openBraces++;
            else if (ch === "}") openBraces--;
            else if (ch === "[") openBrackets++;
            else if (ch === "]") openBrackets--;
        }

        for (let i = 0; i < openBrackets; i++) repaired += "]";
        for (let i = 0; i < openBraces; i++) repaired += "}";

        try {
            const parsed = JSON.parse(repaired);
            if (parsed) {
                console.log("[Veritas] Recovered truncated JSON with bracket repair");
                return parsed;
            }
        } catch { /* fall through */ }
    }

    // Strategy 3: regex fallback
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
        try { return JSON.parse(match[0]); } catch {
            try {
                const fixed = fixUnescapedQuotes(match[0]);
                return JSON.parse(fixed);
            } catch { /* fall through */ }
        }
    }

    return null;
}

function salvageClaimsFromMalformedOutput(
    text: string,
    fallbackTopic: string,
): { topic: string; claims: ExtractedClaim[] } | null {
    const topicMatch = text.match(/"topic"\s*:\s*"([^"]{2,180})"/i);
    const topic = (topicMatch?.[1] || fallbackTopic || "General").trim();

    const claimMatches = [...text.matchAll(/"claim"\s*:\s*"([^"]{6,700})"/g)];
    if (claimMatches.length === 0) return null;

    const seen = new Set<string>();
    const claims: ExtractedClaim[] = [];

    for (const m of claimMatches) {
        const claimText = m[1].trim().replace(/\\n/g, " ");
        if (!claimText || seen.has(claimText.toLowerCase())) continue;
        seen.add(claimText.toLowerCase());
        claims.push({
            claim: claimText,
            timestamp: "Unknown",
            query: `${topic} ${claimText}`.slice(0, 280),
        });
        if (claims.length >= MAX_CLAIMS) break;
    }

    if (claims.length === 0) return null;
    return { topic, claims };
}

// Fix unescaped double-quotes inside JSON string values
function fixUnescapedQuotes(json: string): string {
    // Replace curly/smart quotes with straight quotes
    let fixed = json.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"');
    // Replace curly single quotes
    fixed = fixed.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
    // Fix common pattern: "claim":"text with "quotes" inside" → escape inner quotes
    // This is a heuristic — replace double-quote preceded by a letter and followed by a letter (inside a value)
    fixed = fixed.replace(/(?<=\w)"(?=\w)/g, '\\"');
    return fixed;
}

// ============================================================
// Generate text with retry + exponential backoff (for rate limits)
// ============================================================

async function generateTextWithRetry(
    prompt: string,
    options?: {
        model?: Parameters<typeof generateText>[0]["model"];
        maxRetries?: number;
        fallbackPrompt?: string;
    },
): Promise<string> {
    const useModel = options?.model ?? modelLight;
    const fallbackPrompt = options?.fallbackPrompt ?? prompt;
    const isHeavyRequest = isGroq && useModel === modelHeavy;
    const maxRetries = options?.maxRetries ?? (isHeavyRequest ? 1 : 3);

    if (isHeavyRequest && isHeavyModelOnCooldown()) {
        const cooldownSec = Math.ceil((heavyModelBlockedUntil - Date.now()) / 1000);
        console.log(`[Veritas] Heavy model cooldown active (${cooldownSec}s left). Using light model.`);
        return generateTextWithRetry(fallbackPrompt, { model: modelLight, maxRetries: 2 });
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const { text } = await generateText({ model: useModel, prompt });
            return text;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const isRateLimit = msg.includes("Rate limit") || msg.includes("429") || msg.includes("TPM") || msg.includes("TPD") || msg.includes("tokens per");

            if (isRateLimit && isHeavyRequest) {
                markHeavyModelBlocked(msg);
                const cooldownSec = Math.ceil((heavyModelBlockedUntil - Date.now()) / 1000);
                console.log(`[Veritas] Heavy model rate-limited. Cooldown set to ~${cooldownSec}s.`);
            }

            if (isRateLimit && attempt < maxRetries - 1 && !isHeavyRequest) {
                // Exponential backoff: 5s, 10s
                const waitTime = 5000 * Math.pow(2, attempt);
                console.log(`[Veritas] Rate limited, waiting ${waitTime / 1000}s before retry ${attempt + 2}/${maxRetries}...`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }

            // Last resort: if heavy model is rate-limited, fall back to light model
            if (isRateLimit && useModel !== modelLight && isGroq) {
                console.log(`[Veritas] Heavy model rate-limited, falling back to light model...`);
                try {
                    return generateTextWithRetry(fallbackPrompt, { model: modelLight, maxRetries: 2 });
                } catch (fallbackErr) {
                    console.error("[Veritas] Fallback model also failed:", fallbackErr);
                }
            }

            throw e;
        }
    }
    throw new Error("Max retries exceeded");
}

// ============================================================
// Single Claim Verification
// ============================================================

async function verifyClaim(
    claim: string,
    query: string,
    timestamp: string,
    topic: string,
): Promise<VerifiedClaim> {
    const verifyWithModelOnly = async (reasonPrefix: string): Promise<VerifiedClaim> => {
        try {
            const text = await generateTextWithRetry(
                `Fact-check this claim using general world knowledge only.
No web search is available for this request.

Claim: "${claim}"
Topic: "${topic}"
Date: ${new Date().toISOString().split("T")[0]}

Rules:
- If you are not reasonably sure, return "Unverified"
- Keep reasoning concise (1 sentence)
- Write reasoning in English only

Return ONLY JSON: {"verdict":"True"|"False"|"Unverified","confidence":0.0-1.0,"reasoning":"..."}`,
                { model: modelLight, maxRetries: 1 },
            );

            const parsed = extractJSON(text);
            if (!parsed) {
                return {
                    claim, timestamp,
                    verdict: "Unverified", confidence: 0,
                    source: "Model-only fallback",
                    reasoning: `${reasonPrefix} Fallback verification response was malformed.`,
                };
            }

            const validated = VerificationSchema.safeParse(parsed);
            const result = validated.success ? validated.data : {
                verdict: (parsed.verdict as "True" | "False" | "Unverified") || "Unverified",
                confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
                reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Validation failed.",
            };

            const normalizedVerdict = normalizeVerdictByReasoning(result.verdict, result.reasoning);

            return {
                claim,
                timestamp,
                verdict: normalizedVerdict,
                confidence: Math.min(0.75, Math.max(0, result.confidence)),
                source: "Model-only fallback",
                reasoning: `${reasonPrefix} ${result.reasoning}`.trim(),
            };
        } catch {
            return {
                claim, timestamp,
                verdict: "Unverified", confidence: 0,
                source: "Model-only fallback",
                reasoning: `${reasonPrefix} Fallback verification failed.`,
            };
        }
    };

    if (!tvly) {
        return verifyWithModelOnly("Search API key not configured.");
    }

    if (isTavilyOnCooldown()) {
        const seconds = Math.ceil((tavilyBlockedUntil - Date.now()) / 1000);
        return verifyWithModelOnly(`Search provider temporarily unavailable (cooldown ${seconds}s).`);
    }

    try {
        const normalizedQuery = query?.trim() || `${topic} ${claim}`.slice(0, 280);
        const searchResult = await tvly.search(normalizedQuery, {
            searchDepth: "advanced",
            maxResults: 5,
            topic: "general",
            includeAnswer: "advanced",
        });

        if (!searchResult.results || searchResult.results.length === 0) {
            return verifyWithModelOnly("Search returned no relevant results.");
        }

        const rankedResults = [...searchResult.results].sort((a, b) => {
            const trustDiff = domainScore(b.url || "") - domainScore(a.url || "");
            if (trustDiff !== 0) return trustDiff;
            return (b.score || 0) - (a.score || 0);
        });

        // Keep context short for Groq
        const context = rankedResults
            .slice(0, 3)
            .map((r: { title?: string; content?: string }) =>
                `[${r.title || "Untitled"}]: ${(r.content || "").slice(0, 300)}`
            )
            .join("\n");
        const sourceUrl = rankedResults[0]?.url || searchResult.results[0]?.url || "Web Search";
        const tavilyAnswer = (searchResult as { answer?: string }).answer || "";

        const text = await generateTextWithRetry(
            `Fact-check this claim using the search results and AI summary below.

Claim: "${claim}"
Date: ${new Date().toISOString().split("T")[0]}
${tavilyAnswer ? `\nAI Search Summary: ${tavilyAnswer.slice(0, 500)}` : ""}

Sources:
${context}

Rules:
- If sources CONFIRM with matching data → "True"
- If sources CONTRADICT with different data → "False"  
- If sources are irrelevant or don't mention it → "Unverified"
- Reasoning: 1 sentence max.
- Write reasoning in English only.

Return ONLY JSON: {"verdict":"True"|"False"|"Unverified","confidence":0.0-1.0,"reasoning":"..."}`,
        );

        const parsed = extractJSON(text);
        if (!parsed) {
            return {
                claim, timestamp,
                verdict: "Unverified", confidence: 0,
                source: sourceUrl,
                reasoning: "Failed to parse verification response.",
            };
        }

        const validated = VerificationSchema.safeParse(parsed);
        const result = validated.success ? validated.data : {
            verdict: (parsed.verdict as "True" | "False" | "Unverified") || "Unverified",
            confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
            reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Validation failed.",
        };

        const normalizedVerdict = normalizeVerdictByReasoning(result.verdict, result.reasoning);

        return {
            claim, timestamp,
            verdict: normalizedVerdict,
            confidence: result.confidence,
            source: sourceUrl,
            reasoning: result.reasoning,
        };
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isTavilyQuotaError(msg)) {
            markTavilyBlocked(msg);
            const seconds = Math.ceil((tavilyBlockedUntil - Date.now()) / 1000);
            console.warn(`[Veritas] Tavily quota/cap reached. Cooldown set to ~${seconds}s.`);
            return verifyWithModelOnly("Search provider quota exceeded.");
        }

        console.error(`Verification failed for claim: "${claim.slice(0, 60)}..."`, msg);
        return verifyWithModelOnly(`Search provider error: ${msg.slice(0, 90)}.`);
    }
}

// ============================================================
// Sequential Verification with Rate Limit Awareness
// ============================================================

async function verifyClaims(
    claims: ExtractedClaim[],
    topic: string,
): Promise<VerifiedClaim[]> {
    if (VERIFY_CONCURRENCY <= 1) {
        // Sequential: respect Groq's tiny TPM
        const results: VerifiedClaim[] = [];
        for (const c of claims) {
            if (results.length > 0) {
                await new Promise(r => setTimeout(r, VERIFY_DELAY_MS));
            }
            const result = await verifyClaim(c.claim, c.query, c.timestamp, topic);
            results.push(result);
        }
        return results;
    }

    // Parallel with concurrency limit
    const results: VerifiedClaim[] = new Array(claims.length);
    for (let i = 0; i < claims.length; i += VERIFY_CONCURRENCY) {
        const batch = claims.slice(i, i + VERIFY_CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map(c => verifyClaim(c.claim, c.query, c.timestamp, topic))
        );
        batchResults.forEach((r, j) => { results[i + j] = r; });
        if (i + VERIFY_CONCURRENCY < claims.length) {
            await new Promise(r => setTimeout(r, VERIFY_DELAY_MS));
        }
    }
    return results;
}

// ============================================================
// Manipulation / Propaganda Tactics Analysis
// ============================================================

async function analyzeManipulation(
    transcriptText: string,
    topic: string,
): Promise<ManipulationAnalysis> {
    const defaultResult: ManipulationAnalysis = {
        tactics: TACTICS.map(t => ({ tactic: t, score: 0, example: "", explanation: "" })),
        manipulationScore: 0,
        summary: "Could not analyze manipulation tactics.",
    };

    try {
        const text = await generateTextWithRetry(
            `You are an expert in rhetoric, propaganda analysis, and media literacy.
Analyze this transcript for manipulation and persuasion tactics.

Topic: "${topic}"
Transcript (excerpt):
"${transcriptText.slice(0, Math.min(transcriptText.length, 8000))}"

For EACH of these 8 tactics, rate how intensely it is used (0 = not present, 100 = heavily used).
If the tactic IS present, provide a SHORT quote from the text as example and a 1-sentence explanation.
If the tactic is NOT present (score 0), leave example and explanation empty.
IMPORTANT: All output text fields must be in English. If the source transcript is not English, translate examples and explanations to concise English.

Tactics to analyze:
1. Appeal to Emotion — Using fear, anger, sympathy, or outrage to bypass rational thinking
2. Appeal to Authority — Citing vague "experts" or "studies" without naming specifics
3. Cherry-Picking — Selecting only data/facts that support the narrative while ignoring contradicting evidence
4. False Dichotomy — Presenting only two options when more exist ("either you agree or you're the enemy")
5. Loaded Language — Using emotionally charged, biased, or inflammatory words to influence perception
6. Bandwagon — "Everyone knows...", "Most people agree...", implying consensus without evidence
7. Strawman — Misrepresenting the opposing view to make it easier to attack
8. Repetition — Repeating key claims/phrases multiple times to make them seem more true

Also provide:
- manipulationScore: 0-100 overall manipulation intensity
- summary: 1 sentence describing the overall rhetorical strategy

Return ONLY valid JSON:
{"tactics":[{"tactic":"Appeal to Emotion","score":0-100,"example":"...","explanation":"..."},...],"manipulationScore":0-100,"summary":"..."}`,
            { model: modelHeavy },
        );

        let parsed = extractJSON(text);
        if (!parsed || !Array.isArray(parsed.tactics)) {
            console.warn("[Veritas] Manipulation analysis: failed to parse response, attempting JSON repair...");
            try {
                const repairedText = await generateTextWithRetry(
                    `Convert the following output into STRICT valid JSON with this exact schema:
{"tactics":[{"tactic":"Appeal to Emotion","score":0,"example":"","explanation":""}],"manipulationScore":0,"summary":""}

Rules:
- Output JSON only
- Keep all 8 tactics if present, otherwise include with score 0
- score and manipulationScore must be numbers 0-100
- Keep all text fields in English

Output to repair:
${text.slice(0, 3500)}`,
                    { model: modelLight, maxRetries: 1 },
                );
                const repairedParsed = extractJSON(repairedText);
                if (!repairedParsed || !Array.isArray(repairedParsed.tactics)) {
                    return defaultResult;
                }
                parsed = repairedParsed;
            } catch {
                return defaultResult;
            }
        }

        // Map parsed tactics to our strict format, ensuring all 8 are present
        const parsedTactics = parsed.tactics as Array<Record<string, unknown>>;
        const tactics: ManipulationTactic[] = TACTICS.map(tacticName => {
            const found = parsedTactics.find(
                (t) => typeof t.tactic === "string" && t.tactic.toLowerCase().includes(tacticName.toLowerCase().split(" ")[0])
            );
            return {
                tactic: tacticName,
                score: found && typeof found.score === "number" ? Math.min(100, Math.max(0, found.score)) : 0,
                example: found && typeof found.example === "string" ? found.example.slice(0, 200) : "",
                explanation: found && typeof found.explanation === "string" ? found.explanation.slice(0, 200) : "",
            };
        });

        const manipulationScore = typeof parsed.manipulationScore === "number"
            ? Math.min(100, Math.max(0, parsed.manipulationScore))
            : Math.round(tactics.reduce((sum, t) => sum + t.score, 0) / tactics.length);

        const summary = typeof parsed.summary === "string" ? parsed.summary : defaultResult.summary;

        console.log(`[Veritas] Manipulation analysis complete. Score: ${manipulationScore}/100`);
        return { tactics, manipulationScore, summary };
    } catch (e) {
        console.error("[Veritas] Manipulation analysis failed:", e);
        return defaultResult;
    }
}

// ============================================================
// Generate Overall Summary
// ============================================================

async function generateSummary(
    topic: string,
    claims: VerifiedClaim[],
): Promise<string> {
    if (claims.length === 0) return "No verifiable claims were found in this content.";

    const trueCount = claims.filter(c => c.verdict === "True").length;
    const falseCount = claims.filter(c => c.verdict === "False").length;
    const unverifiedCount = claims.filter(c => c.verdict === "Unverified").length;

    try {
        const text = await generateTextWithRetry(
            `Write 2 sentences summarizing this fact-check in English. Be direct.

Topic: "${topic}"
Results: ${trueCount} true, ${falseCount} false, ${unverifiedCount} unverified (${claims.length} total).
Key findings: ${claims.slice(0, 3).map(c => `[${c.verdict}] ${c.claim.slice(0, 80)}`).join("; ")}

No markdown. No bullet points. Just 2 plain sentences.`,
        );
        return text.trim();
    } catch {
        return `Analysis of "${topic}": ${trueCount} claims verified, ${falseCount} flagged false, ${unverifiedCount} unverified. Score: ${claims.length > 0 ? Math.round((trueCount / claims.length) * 100) : 0}/100.`;
    }
}

// ============================================================
// Main API Handler
// ============================================================

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { url, text } = body;

        if (!url && !text) {
            return NextResponse.json(
                { error: "URL or text content required" },
                { status: 400 },
            );
        }

        // ── Demo cache: serve pre-built response for the demo video ──
        if (url) {
            const { extractVideoId } = await import("@/lib/utils");
            const vid = extractVideoId(url);
            if (vid === DEMO_VIDEO_ID) {
                console.log(`[Veritas] Demo cache hit for ${DEMO_VIDEO_ID}`);
                return NextResponse.json(DEMO_RESPONSE);
            }
        }

        // Check AI key
        const hasAIKey = !!(
            process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
            process.env.OPENAI_API_KEY ||
            process.env.GROQ_API_KEY
        );
        if (!hasAIKey) {
            return NextResponse.json(
                { error: "No AI API key configured." },
                { status: 500 },
            );
        }

        // ── Step 1: Get transcript ───────────────────────────────
        let transcriptText = "";

        const transcriptUnavailableResponse = (details?: string) => NextResponse.json({
            url: url || null,
            topic: "Transcript Unavailable",
            summary: "We could not retrieve captions or audio transcript for this video, so no claims were extracted.",
            truthScore: 0,
            claims: [],
            manipulation: {
                tactics: TACTICS.map((tactic) => ({ tactic, score: 0, example: "", explanation: "" })),
                manipulationScore: 0,
                summary: "No transcript available for manipulation analysis.",
            },
            meta: { totalClaims: 0, trueCount: 0, falseCount: 0, unverifiedCount: 0 },
            details,
        });

        if (text) {
            transcriptText = text;
        } else if (url) {
            try {
                console.log(`[Veritas] Fetching transcript for: ${url}`);
                const transcript = await getTranscript(url);
                transcriptText = transcript.map(t => t.text).join(" ");
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                console.error("[Veritas] Transcript fetch failed:", msg);
                return transcriptUnavailableResponse(msg);
            }
        }

        if (!transcriptText.trim()) {
            if (url) {
                return transcriptUnavailableResponse("Transcript text ended up empty after fallback strategies.");
            }
            return NextResponse.json(
                { error: "Empty transcript — no content to analyze." },
                { status: 422 },
            );
        }

        // ── Step 2: Extract claims via LLM ───────────────────────
        console.log(`[Veritas] Extracting claims (transcript: ${transcriptText.length} chars, sending: ${Math.min(transcriptText.length, MAX_TRANSCRIPT_CHARS)} chars)`);

        // Helper function for extraction
        const extractClaimsWithMode = async (mode: "strict" | "relaxed") => {
            const isStrict = mode === "strict";
            const systemPrompt = isStrict
                ? `You are a ruthless fact-checker. Extract ONLY significant, falsifiable claims.
Target: ${MAX_CLAIMS} claims.

PRIORITIZE:
- Economic stats (prices, taxes, wages)
- Political/Legal assertions (laws, votes, crimes)
- Historical events & dates
- Scientific/Medical facts (studies, effectiveness)

CRITICAL: EXTRACT FULL, SELF-CONTAINED SENTENCES.
- BAD: "12 days"
- GOOD: "The subject claims to have spent 12 days in solitary confinement."

IGNORE ABSOLUTELY (unless topic is Health):
- Personal biological details (weight, sleep, diet)
- Anecdotes / Feelings
- Generalizations

LANGUAGE REQUIREMENT:
- Output topic, claim, and query in English only
- If the source text is not English, translate extracted claims into clear English

Return ONLY compact JSON: {"topic":"Subject","claims":[{"claim":"...","timestamp":"...","query":"..."}]}`
                : `You are a fact-checker. Extract ANY verifiable claims, including personal timeline events.
Target: ${MAX_CLAIMS} claims.

EXTRACT:
- Specific numbers (dates, days, amounts, weight lost/gained)
- Specific events in the timeline (arrest, release, travel)
- Quotes or accusations

CRITICAL: EXTRACT FULL, SELF-CONTAINED SENTENCES.

LANGUAGE REQUIREMENT:
- Output topic, claim, and query in English only
- If the source text is not English, translate extracted claims into clear English

Return ONLY compact JSON: {"topic":"Subject","claims":[{"claim":"...","timestamp":"...","query":"..."}]}`;

            console.log(`[Veritas] Extracting claims (${mode} mode)...`);
            const heavyPrompt = `${systemPrompt}\n\nText:\n"${transcriptText.slice(0, MAX_TRANSCRIPT_CHARS)}"`;
            const lightPrompt = `${systemPrompt}\n\nText:\n"${transcriptText.slice(0, LIGHT_MODEL_TRANSCRIPT_CHARS)}"`;
            const text = await generateTextWithRetry(
                heavyPrompt,
                { model: modelHeavy, maxRetries: 1, fallbackPrompt: lightPrompt },
            );
            console.log(`[Veritas DEBUG] ${mode.toUpperCase()} Output:`, text.slice(0, 100) + "...");
            return { text, data: extractJSON(text) };
        };

        // 1. Try STRICT mode first
        let result = await extractClaimsWithMode("strict");
        let extracted = result.data;

        // 2. If strict extraction is empty/too sparse, retry with RELAXED mode
        const strictClaimsCount = extracted && Array.isArray(extracted.claims) ? extracted.claims.length : 0;
        const shouldRetryRelaxed =
            !extracted ||
            !Array.isArray(extracted.claims) ||
            strictClaimsCount === 0 ||
            (strictClaimsCount < 3 && transcriptText.length > 500);

        if (shouldRetryRelaxed) {
            console.warn(`[Veritas] Strict mode yielded ${strictClaimsCount} claims. Retrying with RELAXED mode...`);
            result = await extractClaimsWithMode("relaxed");
            extracted = result.data;
        }

        const generatedText = result.text; // For logging/fallback



        // (Old fallback logic removed as it's handled by helper)

        if (!extracted) {
            const salvaged = salvageClaimsFromMalformedOutput(generatedText, "General");
            if (salvaged && salvaged.claims.length > 0) {
                console.warn(`[Veritas] Salvaged ${salvaged.claims.length} claims from malformed extraction output.`);
                extracted = salvaged as unknown as Record<string, unknown>;
            }
        }

        if (!extracted) {
            console.error("[Veritas] Failed to parse claims from LLM:", generatedText.slice(0, 500));
            // Instead of erroring 500, return a safe "No claims found" response
            return NextResponse.json({
                url: url || null,
                topic: "Analysis Failed",
                summary: "We couldn't extract verifiable claims from this content. The AI output was malformed.",
                truthScore: 0,
                claims: [],
                meta: { totalClaims: 0, trueCount: 0, falseCount: 0, unverifiedCount: 0 },
            });
        }

        const topic = (typeof extracted.topic === "string" ? extracted.topic : "General") || "General";

        // Handle case where claims array exists but might be incomplete
        const rawClaims = Array.isArray(extracted.claims) ? extracted.claims : [];
        const claims: ExtractedClaim[] = rawClaims
            .filter((c: unknown): c is Record<string, unknown> => {
                const obj = c as Record<string, unknown>;
                return typeof obj === "object" && obj !== null && typeof obj.claim === "string" && obj.claim.length > 5;
            })
            .map((obj) => {
                const claimText = String(obj.claim || "").trim();
                const queryText = typeof obj.query === "string" && obj.query.trim().length > 0
                    ? obj.query.trim()
                    : `${topic} ${claimText}`.slice(0, 280);
                const timestampText = typeof obj.timestamp === "string" && obj.timestamp.trim().length > 0
                    ? obj.timestamp.trim()
                    : "Unknown";
                return {
                    claim: claimText,
                    timestamp: timestampText,
                    query: queryText,
                };
            })
            .slice(0, MAX_CLAIMS); // Cap claims to avoid rate limit hell

        console.log(`[Veritas] Extracted ${claims.length} claims for topic: "${topic}"`);

        if (claims.length === 0) {
            return NextResponse.json({
                url: url || null,
                topic,
                summary: "No verifiable claims were found in this content.",
                truthScore: 0,
                claims: [],
                meta: { totalClaims: 0, trueCount: 0, falseCount: 0, unverifiedCount: 0 },
            });
        }

        // ── Step 3: Verify claims (sequential for Groq) ─────────
        console.log(`[Veritas] Verifying ${claims.length} claims (delay: ${VERIFY_DELAY_MS}ms, provider: ${isGroq ? "Groq" : "other"})...`);
        const verifiedClaims = await verifyClaims(claims, topic);

        // ── Step 4: Summary + Manipulation Analysis (parallel) ───
        // Wait before next LLM calls to avoid rate limit
        if (isGroq) await new Promise(r => setTimeout(r, 3000));

        const [summary, manipulation] = await Promise.all([
            generateSummary(topic, verifiedClaims),
            (async () => {
                // Small delay to stagger the two parallel calls for Groq
                if (isGroq) await new Promise(r => setTimeout(r, 2000));
                return analyzeManipulation(transcriptText, topic);
            })(),
        ]);

        // ── Step 5: Compute score ────────────────────────────────
        const trueCount = verifiedClaims.filter(c => c.verdict === "True").length;
        const falseCount = verifiedClaims.filter(c => c.verdict === "False").length;
        const decidedCount = trueCount + falseCount;
        // Only count decided claims (True/False) in the score — Unverified shouldn't penalize
        const truthScore = decidedCount > 0
            ? Math.round((trueCount / decidedCount) * 100)
            : (verifiedClaims.length > 0 ? 50 : 0); // If all unverified, neutral 50

        console.log(`[Veritas] ✓ Analysis complete. Score: ${truthScore}/100, Claims: ${verifiedClaims.length}, Manipulation: ${manipulation.manipulationScore}/100`);

        return NextResponse.json({
            url: url || null,
            topic,
            summary,
            truthScore,
            claims: verifiedClaims,
            manipulation,
            meta: {
                totalClaims: verifiedClaims.length,
                trueCount,
                falseCount: verifiedClaims.filter(c => c.verdict === "False").length,
                unverifiedCount: verifiedClaims.filter(c => c.verdict === "Unverified").length,
            },
        });
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error("[Veritas] Analysis error:", msg);
        return NextResponse.json(
            { error: "Internal Server Error", details: msg },
            { status: 500 },
        );
    }
}
