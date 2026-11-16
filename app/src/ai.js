import { Capacitor } from '@capacitor/core';
import { GenAiPrompt } from '@capacitor-mlkit/genai-prompt';

// Gemini Nano, Google's AI model built into some Android phones, used through ML Kit's GenAI
// Prompt API. It runs entirely on the phone: prompts and answers never leave the device.
// Every caller keeps a non-AI fallback, so phones without Gemini Nano lose nothing.

// The household turns this on in Settings: until then the app never calls ML Kit, because
// ML Kit sends Google usage statistics (device model, app version, performance) once used.
let status = 'off'; // 'off' | 'ready' | 'downloadable' | 'downloading' | 'none'
export const aiStatus = () => status;
export const turnOffAi = () => { status = 'off'; };

export async function checkAi() {
  if (!Capacitor.isNativePlatform()) return (status = 'none');
  try {
    const { featureStatus } = await GenAiPrompt.checkFeatureStatus();
    status = { AVAILABLE: 'ready', DOWNLOADABLE: 'downloadable', DOWNLOADING: 'downloading' }[featureStatus] ?? 'none';
  } catch {
    status = 'none';
  }
  return status;
}

/** Ask Android to download the model. `onProgress(megabytes)` reports progress. */
export async function setUpAi(onProgress) {
  status = 'downloading';
  const handle = await GenAiPrompt.addListener('downloadProgress', (e) =>
    onProgress?.(Math.round(e.totalBytesDownloaded / 1e6)));
  try {
    await GenAiPrompt.downloadFeature();
  } finally {
    await handle.remove();
  }
  return checkAi();
}

// The model handles one request at a time.
let queue = Promise.resolve();
function ask(prompt, { maxOutputTokens = 200, timeoutMs = 20000 } = {}) {
  if (status !== 'ready') return Promise.reject(new Error('On-phone AI is not available.'));
  const run = queue.then(() => Promise.race([
    GenAiPrompt.generateContent({ prompt, temperature: 0.2, topK: 10, maxOutputTokens }).then((r) => r.text.trim()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('On-phone AI took too long.')), timeoutMs)),
  ]));
  queue = run.catch(() => {});
  return run;
}

const firstJson = (text) => {
  const m = text.match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
};

/**
 * Understand a free-form note such as "no milk on the 3rd and 5th" or "half litre came yesterday".
 * Returns { status: 'y'|'n'|null, kind: 'one'|'half'|null, days: [day numbers] } or null.
 * `ctx`: { todayText, monthText, lastDay } — the month shown and the latest day that can be marked.
 */
export async function understandNote(note, ctx) {
  const text = await ask(
    `You turn a household's note about milk deliveries into JSON.\n` +
    `Today is ${ctx.todayText}. The note is about ${ctx.monthText}; valid days are 1 to ${ctx.lastDay}.\n` +
    `Reply with only JSON in this form: {"status":"received","quantity":"usual","days":[14,15]}\n` +
    `status is "received", "not received" or "clear". quantity is "1 litre", "half litre" or "usual".\n` +
    `days lists every day number the note refers to. If the note is not about milk deliveries, reply {"days":[]}.\n` +
    `Note: ${note.slice(0, 300)}`,
    { maxOutputTokens: 80 },
  );
  const j = firstJson(text);
  if (!j || !Array.isArray(j.days)) return null;
  const days = [...new Set(j.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 1 && d <= ctx.lastDay).sort((a, b) => a - b);
  if (!days.length) return null;
  const status = /^not/i.test(j.status) ? 'n' : /^clear/i.test(j.status) ? null : 'y';
  const kind = /half|½/i.test(j.quantity) ? 'half' : /^1/.test(j.quantity ?? '') ? 'one' : null;
  return { status, kind, days };
}

/** Answer a question using only the household's records, summarised in `facts`. */
export function answerQuestion(question, facts) {
  return ask(
    `You help a household in India keep track of daily milk deliveries. Answer their question in at most ` +
    `three short sentences, using only the records below. Copy ₹ amounts and dates exactly as written. ` +
    `If the records don't answer it, say you don't know.\n\nRecords:\n${facts}\n\nQuestion: ${question.slice(0, 300)}`,
    { maxOutputTokens: 160 },
  );
}

/**
 * Rewrite the plain bill message more warmly. Returns null unless every number in the original
 * appears unchanged in the rewrite, so the bill can never be altered.
 */
export async function friendlierBill(message) {
  const text = await ask(
    `Rewrite this message from a customer to their milk delivery person in India so it sounds warm and ` +
    `polite, like a WhatsApp message to someone you know. Keep it short. Keep every number, ₹ amount and ` +
    `date exactly as written. Reply with only the message.\n\nMessage:\n${message}`,
    { maxOutputTokens: 200 },
  );
  const numbers = (s) => (s.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, ''));
  const out = new Set(numbers(text));
  return text && numbers(message).every((n) => out.has(n)) ? text : null;
}
