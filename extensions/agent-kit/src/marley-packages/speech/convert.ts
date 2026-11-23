import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SpeechError } from "./types.js";

export type ConvertOptions = {
  /** Path or name of the ffmpeg binary. Default "ffmpeg" from PATH. */
  ffmpegPath?: string;
  /** Stop after this many seconds of audio. */
  maxSeconds: number;
  /** Kill ffmpeg after this long. Default 120 000 ms. */
  timeoutMs?: number;
};

/** Turns audio or video bytes into Ogg Opus. Returns null when the media has no audio stream. */
export type Converter = (input: Buffer, options: ConvertOptions) => Promise<Buffer | null>;

const NO_AUDIO = /matches no streams|does not contain any stream|Output file does not contain|no audio/i;

/**
 * Runs ffmpeg to produce mono 16 kHz Ogg Opus from any audio file or the first audio track of a video (mp3, m4a/aac,
 * wav, amr, ogg, mp4, 3gp, mov, ...). The input goes through a temp file because mp4 and mov may keep their index at
 * the end, which a pipe cannot seek to.
 */
export const ffmpegConverter: Converter = async (input, options) => {
  const dir = await mkdtemp(join(tmpdir(), "zs-speech-"));
  const source = join(dir, "in.bin");
  const target = join(dir, "out.ogg");
  try {
    await writeFile(source, input);
    const args = [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
      "-i", source,
      "-map", "0:a:0", "-vn", "-sn", "-dn",
      "-t", String(Math.ceil(options.maxSeconds)),
      "-ac", "1", "-ar", "16000",
      "-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-compression_level", "2",
      "-f", "ogg", target,
    ];
    await new Promise<void>((resolve, reject) => {
      execFile(options.ffmpegPath ?? "ffmpeg", args, { timeout: options.timeoutMs ?? 120_000, maxBuffer: 1_000_000 }, (error, _stdout, stderr) => {
        if (!error) return resolve();
        const failure = error as NodeJS.ErrnoException & { killed?: boolean };
        if (failure.code === "ENOENT") {
          return reject(new SpeechError("not-configured", `ffmpeg not found (${options.ffmpegPath ?? "ffmpeg"}); install it in the image`));
        }
        if (failure.killed) return reject(new SpeechError("timeout", "ffmpeg timed out converting the audio"));
        if (NO_AUDIO.test(stderr)) return reject(new NoAudioError());
        reject(new SpeechError("unsupported-audio", `ffmpeg could not read the media: ${stderr.trim().slice(0, 300)}`));
      });
    });
    const out = await readFile(target);
    return out.length > 0 ? out : null;
  } catch (error) {
    if (error instanceof NoAudioError) return null;
    throw error;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

class NoAudioError extends Error {}
