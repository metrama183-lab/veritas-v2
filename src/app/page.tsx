import { UrlInput } from "@/components/url-input";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 relative overflow-hidden bg-black selection:bg-red-500/30">
      {/* Background Gradients */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[1000px] h-[500px] bg-red-900/20 rounded-[100%] blur-[100px] pointer-events-none" />

      <div className="z-10 flex flex-col items-center text-center space-y-8 max-w-4xl mx-auto">
        <div className="space-y-4">
          <h1 className="text-6xl md:text-8xl font-bold tracking-tighter text-transparent bg-clip-text bg-gradient-to-b from-white to-zinc-500">
            VERITAS
          </h1>
          <p className="text-xl md:text-2xl text-zinc-400 font-light tracking-wide">
            The AI-Powered <span className="text-red-500 font-medium">Bullshit Detector</span>
          </p>
        </div>

        <p className="max-w-2xl text-zinc-500 md:text-lg">
          In an era of misinformation, truth is a luxury. <br className="hidden md:block" />
          Veritas listens to YouTube videos and fact-checks claims in real-time.
        </p>

        <div className="w-full pt-8">
          <UrlInput />
        </div>

        <div className="pt-16 grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
          <FeatureCard
            title="Instant Transcription"
            desc="Extracts audio and generates time-stamped text in seconds."
          />
          <FeatureCard
            title="AI Claim Extraction"
            desc="Identifies factual assertions vs. opinions automatically."
          />
          <FeatureCard
            title="Real-time Verification"
            desc="Cross-references claims with trusted web sources."
          />
        </div>
      </div>

      <footer className="absolute bottom-6 text-zinc-700 text-sm">
        Built for Avalon 2026
      </footer>
    </main>
  );
}

function FeatureCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="p-6 rounded-2xl bg-zinc-900/50 border border-zinc-800/50 hover:border-red-500/20 transition-colors backdrop-blur-sm">
      <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
      <p className="text-zinc-400 leading-relaxed">{desc}</p>
    </div>
  )
}
