"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, CheckCircle, XCircle, ArrowLeft, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import { LoadingScreen } from "@/components/loading-screen";
import { BullshitMeter } from "@/components/bullshit-meter";
import { ManipulationRadar } from "@/components/manipulation-radar";
import { VideoTimeline } from "@/components/video-timeline";
import { cn, extractVideoId } from "@/lib/utils";

interface Claim {
    claim: string;
    timestamp: string;
    verdict: "True" | "False" | "Unverified";
    confidence: number;
    source: string;
    reasoning: string;
}

interface ManipulationTactic {
    tactic: string;
    score: number;
    example: string;
    explanation: string;
}

interface ManipulationData {
    tactics: ManipulationTactic[];
    manipulationScore: number;
    summary: string;
}

interface AnalysisResult {
    url: string | null;
    topic: string;
    summary: string;
    truthScore: number;
    claims: Claim[];
    manipulation?: ManipulationData;
    meta: {
        totalClaims: number;
        trueCount: number;
        falseCount: number;
        unverifiedCount: number;
    };
}

export default function ReportPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center justify-center min-h-screen bg-black">
                <LoadingScreen mode="video" />
            </div>
        }>
            <ReportPageContent />
        </Suspense>
    );
}

function ReportPageContent() {
    const searchParams = useSearchParams();
    const videoUrl = searchParams.get("q");
    const mode = searchParams.get("mode");

    const [result, setResult] = useState<AnalysisResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [expandedClaim, setExpandedClaim] = useState<number | null>(null);

    const videoId = videoUrl ? extractVideoId(decodeURIComponent(videoUrl)) : null;

    useEffect(() => {
        if (!videoUrl && mode !== "text") return;

        const fetchAnalysis = async () => {
            setError(null);
            try {
                let body = {};
                if (mode === "text") {
                    const text = sessionStorage.getItem("veritas_manual_text");
                    if (!text) throw new Error("No text found in session storage.");
                    body = { text, mode: "demo" };
                } else {
                    body = { url: decodeURIComponent(videoUrl!), mode: "demo" };
                }

                const res = await fetch("/api/analyze", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });
                const data = await res.json();

                if (res.status === 422) {
                    // Check if it's specifically a transcript failure
                    if (data.error === "TRANSCRIPT_FAILED" || data.details?.includes("TRANSCRIPT_FAILED")) {
                        setResult({
                            url: data.url || (mode === "text" ? null : decodeURIComponent(videoUrl!)),
                            topic: data.topic || "Transcript Unavailable",
                            summary: data.summary || "No transcript could be extracted for this video.",
                            truthScore: data.truthScore ?? 0,
                            claims: data.claims || [],
                            manipulation: data.manipulation || undefined,
                            meta: data.meta || {
                                totalClaims: 0,
                                trueCount: 0,
                                falseCount: 0,
                                unverifiedCount: 0,
                            },
                        });
                        return;
                    }
                    // Other 422 errors (e.g. empty transcript)
                    setLoading(false);
                    setError(data.error || "Analysis failed: No content found.");
                    return;
                }

                if (!res.ok) {
                    throw new Error(data.details || data.error || "Analysis failed");
                }

                setResult({
                    url: data.url,
                    topic: data.topic || "Unknown",
                    summary: data.summary || "",
                    truthScore: data.truthScore ?? 0,
                    claims: data.claims || [],
                    manipulation: data.manipulation || undefined,
                    meta: data.meta || {
                        totalClaims: (data.claims || []).length,
                        trueCount: 0,
                        falseCount: 0,
                        unverifiedCount: 0,
                    },
                });
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error("Failed to fetch report:", msg);
                setError(msg || "Something went wrong during analysis.");
            } finally {
                setLoading(false);
            }
        };

        fetchAnalysis();
    }, [videoUrl, mode]);

    // Invalid input guard
    if ((!videoUrl && mode !== "text") || (mode !== "text" && !videoId)) {
        return (
            <div className="flex flex-col items-center justify-center min-h-screen text-zinc-400 p-10 space-y-4">
                <h2 className="text-xl font-bold text-white">⚠️ Invalid URL or Input</h2>
                <p>We couldn&apos;t extract a valid YouTube Video ID from the provided URL.</p>
                <code className="bg-zinc-900 p-2 rounded text-xs">{videoUrl || "No URL provided"}</code>
                <Link href="/" className="px-4 py-2 bg-white text-black rounded-full font-bold hover:bg-zinc-200 transition-colors">
                    Go Back
                </Link>
            </div>
        );
    }

    const claims = result?.claims || [];
    const meta = result?.meta;

    return (
        <main className="min-h-screen bg-black text-zinc-100 p-6">
            <header className="max-w-7xl mx-auto flex items-center gap-4 mb-8">
                <Link href="/" className="p-2 hover:bg-zinc-900 rounded-full transition-colors">
                    <ArrowLeft className="w-6 h-6" />
                </Link>
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Veritas Report</h1>
                    {result?.topic && result.topic !== "General" && (
                        <p className="text-sm text-zinc-500">Topic: {result.topic}</p>
                    )}
                </div>
            </header>

            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* ===== Left Column: Video + Summary ===== */}
                <div className="lg:col-span-2 space-y-6">
                    {videoId && (
                        <div className="aspect-video w-full bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 relative">
                            <iframe
                                src={`https://www.youtube.com/embed/${videoId}`}
                                className="w-full h-full"
                                allowFullScreen
                                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                            />
                        </div>
                    )}

                    {/* Stats Row */}
                    {!loading && !error && meta && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="grid grid-cols-2 md:grid-cols-4 gap-3"
                        >
                            <StatCard
                                label="Truth Score"
                                value={`${result?.truthScore ?? 0}/100`}
                                color={
                                    (result?.truthScore ?? 0) >= 70 ? "text-green-500" :
                                        (result?.truthScore ?? 0) >= 40 ? "text-yellow-500" :
                                            "text-red-500"
                                }
                            />
                            <StatCard label="Claims Checked" value={String(meta.totalClaims)} color="text-white" />
                            <StatCard label="Verified True" value={String(meta.trueCount)} color="text-green-500" />
                            <StatCard label="Flagged False" value={String(meta.falseCount)} color="text-red-500" />
                        </motion.div>
                    )}

                    {/* Video Timeline with claim markers */}
                    {!loading && !error && claims.length > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.15 }}
                            className="p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800"
                        >
                            <VideoTimeline
                                claims={claims}
                                onClaimClick={(idx) => setExpandedClaim(expandedClaim === idx ? null : idx)}
                            />
                        </motion.div>
                    )}

                    {/* AI Summary */}
                    {!loading && !error && result?.summary && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.2 }}
                            className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800"
                        >
                            <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500 mb-3">
                                AI Analysis Summary
                            </h3>
                            <p className="text-zinc-300 leading-relaxed">{result.summary}</p>
                        </motion.div>
                    )}

                    {/* Manipulation Radar */}
                    {!loading && !error && result?.manipulation && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            transition={{ delay: 0.4 }}
                            className="p-5 rounded-2xl bg-zinc-900/60 border border-zinc-800"
                        >
                            <ManipulationRadar
                                tactics={result.manipulation.tactics}
                                manipulationScore={result.manipulation.manipulationScore}
                                summary={result.manipulation.summary}
                            />
                        </motion.div>
                    )}
                </div>

                {/* ===== Right Column: Scores + Claims ===== */}
                <div className="space-y-4">
                    {/* BullshitMeter */}
                    {!loading && !error && result && (
                        <motion.div
                            initial={{ opacity: 0, scale: 0.9 }}
                            animate={{ opacity: 1, scale: 1 }}
                            className="flex justify-center p-4 rounded-2xl bg-zinc-900/60 border border-zinc-800"
                        >
                            <BullshitMeter score={result.truthScore} size={180} />
                        </motion.div>
                    )}

                    <h3 className="text-xl font-semibold sticky top-4">Verified Claims</h3>

                    {loading ? (
                        <div className="flex flex-col items-center justify-center min-h-[400px]">
                            <LoadingScreen mode={mode === "text" ? "text" : "video"} />
                        </div>
                    ) : error ? (
                        <div className="flex flex-col items-center justify-center p-8 space-y-4 text-center border border-red-900/50 bg-red-950/10 rounded-2xl">
                            <AlertTriangle className="w-12 h-12 text-red-500" />
                            <h4 className="text-lg font-bold text-red-400">Analysis Failed</h4>
                            <p className="text-sm text-zinc-400">{error}</p>
                            <button
                                onClick={() => window.location.reload()}
                                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-bold hover:bg-red-700 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    ) : claims.length === 0 ? (
                        <div className="flex flex-col items-center justify-center p-8 space-y-4 text-center border border-zinc-800 bg-zinc-900/10 rounded-2xl">
                            <p className="text-zinc-400">No verifiable claims found in this content.</p>
                        </div>
                    ) : (
                        <div className="space-y-4 overflow-y-auto max-h-[80vh] pr-2">
                            {claims.map((claim, idx) => {
                                const isExpanded = expandedClaim === idx;
                                return (
                                    <motion.div
                                        key={idx}
                                        initial={{ opacity: 0, x: 20 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: idx * 0.08 }}
                                        className={cn(
                                            "p-4 rounded-xl border cursor-pointer transition-all",
                                            claim.verdict === "False"
                                                ? "bg-red-950/20 border-red-900/50 hover:border-red-700/60"
                                                : claim.verdict === "True"
                                                    ? "bg-green-950/20 border-green-900/50 hover:border-green-700/60"
                                                    : "bg-yellow-950/20 border-yellow-900/50 hover:border-yellow-700/60",
                                        )}
                                        onClick={() => setExpandedClaim(isExpanded ? null : idx)}
                                    >
                                        {/* Top Row: Timestamp + Verdict */}
                                        <div className="flex justify-between items-start mb-2">
                                            <span className="font-mono text-xs bg-black/50 px-2 py-1 rounded text-zinc-400">
                                                {claim.timestamp}
                                            </span>
                                            <VerdictBadge verdict={claim.verdict} />
                                        </div>

                                        {/* Claim text */}
                                        <p className="font-medium text-zinc-200 mb-2">&quot;{claim.claim}&quot;</p>

                                        {/* Confidence bar */}
                                        <div className="flex items-center gap-2 mb-2">
                                            <div className="flex-1 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                                <div
                                                    className={cn(
                                                        "h-full rounded-full transition-all duration-700",
                                                        claim.verdict === "True" ? "bg-green-500"
                                                            : claim.verdict === "False" ? "bg-red-500"
                                                                : "bg-yellow-500",
                                                    )}
                                                    style={{ width: `${Math.round(claim.confidence * 100)}%` }}
                                                />
                                            </div>
                                            <span className="text-xs text-zinc-500 font-mono w-10 text-right">
                                                {Math.round(claim.confidence * 100)}%
                                            </span>
                                        </div>

                                        {/* Source */}
                                        <div className="text-xs text-zinc-500 flex items-center gap-1">
                                            {claim.source && claim.source.startsWith("http") ? (
                                                <a
                                                    href={claim.source}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="hover:text-zinc-300 underline flex items-center gap-1"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <ExternalLink className="w-3 h-3" />
                                                    {new URL(claim.source).hostname}
                                                </a>
                                            ) : (
                                                <span>{claim.source}</span>
                                            )}
                                        </div>

                                        {/* Expandable Reasoning */}
                                        {isExpanded && claim.reasoning && (
                                            <motion.div
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: "auto" }}
                                                className="mt-3 pt-3 border-t border-zinc-800"
                                            >
                                                <p className="text-xs text-zinc-400 italic">
                                                    <span className="font-bold text-zinc-300 not-italic">Reasoning:</span>{" "}
                                                    {claim.reasoning}
                                                </p>
                                            </motion.div>
                                        )}

                                        {/* Expand indicator */}
                                        <div className="flex justify-center mt-2">
                                            {isExpanded
                                                ? <ChevronUp className="w-4 h-4 text-zinc-600" />
                                                : <ChevronDown className="w-4 h-4 text-zinc-600" />
                                            }
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>
        </main>
    );
}

function VerdictBadge({ verdict }: { verdict: "True" | "False" | "Unverified" }) {
    const config = {
        False: { icon: XCircle, label: "Bullshit", className: "text-red-500" },
        True: { icon: CheckCircle, label: "Verified", className: "text-green-500" },
        Unverified: { icon: AlertTriangle, label: "Unverified", className: "text-yellow-500" },
    };
    const { icon: Icon, label, className } = config[verdict];

    return (
        <span className={cn("flex items-center gap-1 text-sm font-bold", className)}>
            <Icon className="w-4 h-4" /> {label}
        </span>
    );
}

function StatCard({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div className="p-4 bg-zinc-900/60 rounded-xl border border-zinc-800">
            <div className="text-xs text-zinc-500 mb-1">{label}</div>
            <div className={cn("text-2xl font-bold", color)}>{value}</div>
        </div>
    );
}
