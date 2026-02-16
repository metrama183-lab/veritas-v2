import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import path from 'path';

const execPromise = util.promisify(exec);
import OpenAI from 'openai';

// Initialize OpenAI client for Groq
const groq = new OpenAI({
    apiKey: process.env.GROQ_API_KEY || "",
    baseURL: "https://api.groq.com/openai/v1",
});

// Use system /tmp for serverless environments (Vercel, AWS Lambda)
// In production, /tmp is the only writable directory
const TEMP_DIR = process.env.VERCEL ? '/tmp' : path.join(process.cwd(), 'tmp');
const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // Groq Whisper limit: 25MB
const YTDLP_TIMEOUT_MS = 90000;
const YTDLP_MAX_BUFFER = 15 * 1024 * 1024;

// Ensure temp directory exists (only needed in local dev)
if (!process.env.VERCEL && !fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function findLatestDownloadedFile(runPrefix: string): string | null {
    const files = fs.readdirSync(TEMP_DIR)
        .filter((f) => f.startsWith(runPrefix))
        .sort((a, b) => {
            const sa = fs.statSync(path.join(TEMP_DIR, a)).mtimeMs;
            const sb = fs.statSync(path.join(TEMP_DIR, b)).mtimeMs;
            return sb - sa;
        });

    return files[0] ? path.join(TEMP_DIR, files[0]) : null;
}

export async function downloadAudio(url: string, videoId: string): Promise<string> {
    // Use a unique prefix so parallel requests for the same video do not overwrite each other.
    const runPrefix = `${videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outputTemplate = path.join(TEMP_DIR, `${runPrefix}.%(ext)s`);
    // Hardcoded absolute path to the binary to bypass Next.js environment issues
    const binaryPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');

    // Diagnostic logging for Vercel debugging
    console.log('[Veritas] yt-dlp binary path:', binaryPath);
    console.log('[Veritas] yt-dlp exists:', fs.existsSync(binaryPath));
    console.log('[Veritas] TEMP_DIR:', TEMP_DIR);
    console.log('[Veritas] TEMP_DIR exists:', fs.existsSync(TEMP_DIR));

    // Try progressively smaller audio formats to stay under Whisper's 25MB limit.
    const formatAttempts = [
        "bestaudio[abr<=64]/bestaudio[abr<=96]/bestaudio/best",
        "worstaudio/worst",
        "bestaudio/best",
    ];

    const attemptErrors: string[] = [];

    for (let i = 0; i < formatAttempts.length; i++) {
        const format = formatAttempts[i];
        const command = `"${binaryPath}" "${url}" --format "${format}" --output "${outputTemplate}" --no-check-certificates --no-warnings --prefer-free-formats --no-part --force-overwrites --no-playlist --print "after_move:filepath"`;

        console.log(`Downloading audio for ${videoId} (attempt ${i + 1}/${formatAttempts.length}, format: ${format})...`);

        try {
            const { stdout, stderr } = await execPromise(command, {
                timeout: YTDLP_TIMEOUT_MS,
                maxBuffer: YTDLP_MAX_BUFFER,
            });
            if (stderr) console.warn(`yt-dlp stderr: ${stderr}`);
            if (stdout) console.log(`yt-dlp stdout: ${stdout}`);

            const filePath = findLatestDownloadedFile(runPrefix);
            if (!filePath) {
                attemptErrors.push(`Attempt ${i + 1}: Download completed but no file found in ${TEMP_DIR}`);
                continue;
            }

            const fileSize = fs.statSync(filePath).size;
            if (fileSize > MAX_AUDIO_SIZE) {
                fs.unlinkSync(filePath);
                attemptErrors.push(`Attempt ${i + 1}: Audio too large (${(fileSize / 1024 / 1024).toFixed(1)}MB > 25MB)`);
                continue;
            }

            return filePath;
        } catch (e: unknown) {
            const err = e as { message?: string; stdout?: string; stderr?: string };
            const errorDetails = `Error: ${err.message || "unknown"}\nStdout: ${err.stdout || ""}\nStderr: ${err.stderr || ""}`;
            console.error("yt-dlp execution details:", errorDetails);
            attemptErrors.push(`Attempt ${i + 1}: ${err.message || "yt-dlp failed"}`);
        }
    }

    throw new Error(`Audio download failed after ${formatAttempts.length} attempts. ${attemptErrors.join(" | ")}`);
}

export async function transcribeAudio(filePath: string): Promise<string> {
    console.log(`Transcribing ${filePath}...`);

    try {
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: "whisper-large-v3-turbo", // Groq's fastest production whisper model
            response_format: "text", // strict text response
            temperature: 0.0,
        });

        // OpenAI SDK may return string or object depending on version
        if (typeof transcription === "string") return transcription;
        const result = transcription as { text?: string };
        if (typeof result.text === "string") return result.text;
        return JSON.stringify(transcription);
    } catch (error) {
        console.error("Groq Transcription failed:", error);
        throw error;
    } finally {
        // Cleanup: verify file exists before deleting
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`Deleted temp file: ${filePath}`);
        }
    }
}

export async function getAudioTranscript(url: string, videoId: string): Promise<string> {
    try {
        const audioPath = await downloadAudio(url, videoId);
        const transcript = await transcribeAudio(audioPath);
        return transcript;
    } catch (error: unknown) {
        const err = error instanceof Error ? error : new Error(String(error));
        const errorMsg = JSON.stringify(err, Object.getOwnPropertyNames(err));
        fs.writeFileSync(path.join(process.cwd(), 'debug_error.log'), `Audio Pipeline Error: ${errorMsg}\n`);
        console.error("Audio Pipeline Failed:", err);
        throw new Error(`Audio Pipeline Error: ${err.message || errorMsg}`);
    }
}

export async function extractSubtitlesWithYtdlp(url: string, videoId: string): Promise<string> {
    const binaryPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
    const runPrefix = `subs-${videoId}-${Date.now()}`;
    const outPath = path.join(TEMP_DIR, runPrefix);

    // Try auto-generated subs first (most videos have them), then manual subs
    const attempts = [
        `"${binaryPath}" "${url}" --write-auto-subs --sub-lang "en" --skip-download --sub-format "vtt/srt/best" --convert-subs "srt" --output "${outPath}" --no-check-certificates --no-warnings --no-playlist`,
        `"${binaryPath}" "${url}" --write-subs --sub-lang "en" --skip-download --sub-format "vtt/srt/best" --convert-subs "srt" --output "${outPath}" --no-check-certificates --no-warnings --no-playlist`,
    ];

    for (const command of attempts) {
        try {
            await execPromise(command, { timeout: 45000, maxBuffer: YTDLP_MAX_BUFFER });

            // Find the generated subtitle file
            const subFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(runPrefix) && (f.endsWith('.srt') || f.endsWith('.vtt')));
            if (subFiles.length === 0) continue;

            const subFile = path.join(TEMP_DIR, subFiles[0]);
            const raw = fs.readFileSync(subFile, 'utf-8');

            // Clean up temp file
            for (const f of subFiles) {
                try { fs.unlinkSync(path.join(TEMP_DIR, f)); } catch { /* ignore */ }
            }

            // Parse SRT: strip sequence numbers, timestamps, and tags
            const text = raw
                .replace(/^\d+\s*$/gm, '')
                .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
                .replace(/<[^>]+>/g, '')
                .replace(/\{[^}]+\}/g, '')
                .replace(/\n{2,}/g, '\n')
                .split('\n')
                .map(l => l.trim())
                .filter(Boolean)
                .join(' ')
                .replace(/\s{2,}/g, ' ')
                .trim();

            if (text.length > 100) return text;
        } catch { /* try next attempt */ }
    }

    throw new Error("yt-dlp subtitle extraction returned no usable subtitles");
}

export async function getVideoMetadataFallbackText(url: string): Promise<string | null> {
    const binaryPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
    const command = `"${binaryPath}" "${url}" --dump-single-json --skip-download --no-warnings --no-check-certificates --no-playlist`;

    try {
        const { stdout } = await execPromise(command, {
            timeout: 45000,
            maxBuffer: 8 * 1024 * 1024,
        });

        const metadata = JSON.parse(stdout);
        const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
        const uploader = typeof metadata.uploader === 'string' ? metadata.uploader.trim() : '';
        const description = typeof metadata.description === 'string' ? metadata.description.trim() : '';
        const categories = Array.isArray(metadata.categories) ? metadata.categories.join(', ') : '';

        const metaText = [
            title ? `Video title: ${title}.` : '',
            uploader ? `Channel: ${uploader}.` : '',
            categories ? `Categories: ${categories}.` : '',
            description ? `Description: ${description.slice(0, 6000)}` : '',
        ]
            .filter(Boolean)
            .join(' ')
            .trim();

        if (metaText.length < 80) {
            return null;
        }

        return metaText;
    } catch (error) {
        console.error('Metadata fallback failed:', error);
        return null;
    }
}
