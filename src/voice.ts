import { spawn, execFile } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Voice I/O rail — push-to-talk mic capture + spoken replies.
 *
 * STT: OpenAI Whisper API (set OPENAI_API_KEY). Pluggable — swap transcribe().
 * TTS: macOS `say` (zero-dep). No-op on other platforms unless SAY_CMD is set.
 * Mic: ffmpeg avfoundation (macOS). Set MIC_DEVICE to override (default ':0').
 */

let recorder: ReturnType<typeof spawn> | null = null;
let currentFile = '';

export function isRecording(): boolean {
  return recorder !== null;
}

/** Start capturing the mic. Call stopRecording() to finish and get the transcript. */
export function startRecording(): string {
  if (recorder) throw new Error('Already recording.');
  currentFile = join(tmpdir(), `strands-mc-${Date.now()}.wav`);
  const device = process.env.MIC_DEVICE ?? ':0';
  recorder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'avfoundation', '-i', device,
    '-ac', '1', '-ar', '16000',
    '-y', currentFile,
  ]);
  recorder.on('error', () => { recorder = null; });
  return currentFile;
}

/** Stop the mic and transcribe what was said. */
export async function stopRecording(): Promise<string> {
  if (!recorder) throw new Error('Not recording.');
  const proc = recorder;
  recorder = null;
  await new Promise<void>((resolve) => {
    proc.once('close', () => resolve());
    proc.kill('SIGINT'); // lets ffmpeg finalize the wav header
    setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, 3000);
  });
  const audio = await readFile(currentFile);
  const text = await transcribe(audio);
  await unlink(currentFile).catch(() => {});
  return text;
}

async function transcribe(wav: Buffer): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      'No STT configured. Set OPENAI_API_KEY for Whisper transcription (or wire your own in src/voice.ts).'
    );
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', process.env.WHISPER_MODEL ?? 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Whisper API ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { text: string };
  return json.text.trim();
}

/** Speak text out loud (macOS `say`; set SAY_VOICE to pick a voice). */
export function speak(text: string): Promise<void> {
  return new Promise((resolve) => {
    if (platform() !== 'darwin') return resolve();
    const args: string[] = [];
    if (process.env.SAY_VOICE) args.push('-v', process.env.SAY_VOICE);
    args.push(text.slice(0, 1000));
    execFile('say', args, () => resolve());
  });
}
