import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function loadEnv() {
  try {
    const text = await readFile(join(root, '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
  } catch {}
}

await loadEnv();

const allowedOrigins = new Set(
  String(process.env.FRONTEND_ORIGIN || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

function corsHeaders(req) {
  const requestOrigin = req.headers.origin;
  const allowOrigin = allowedOrigins.has('*')
    ? '*'
    : requestOrigin && allowedOrigins.has(requestOrigin)
      ? requestOrigin
      : '';
  return {
    ...(allowOrigin ? { 'Access-Control-Allow-Origin': allowOrigin } : {}),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const send = (req, res, status, data, type = 'application/json; charset=utf-8') => {
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': type,
  });
  res.end(Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
};

async function collect(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function normalizeEndpoint(value, kind) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  const url = new URL(raw);
  let path = url.pathname.replace(/\/+$/, '');
  const suffix = kind === 'transcription' ? '/audio/transcriptions' : '/chat/completions';
  if (path.endsWith(suffix)) return url.toString();

  if (path.endsWith('/v1')) {
    path += suffix;
  } else {
    path += `/v1${suffix}`;
  }
  url.pathname = path;
  return url.toString();
}

function extractWav(input) {
  return new Promise((resolve, reject) => {
    const bins = [
      process.env.FFMPEG_PATH,
      'C:\\Program Files\\ShadowBot\\shadowbot-6.3.13\\ffmpeg.exe',
      'C:\\Program Files\\ShadowBot\\shadowbot-6.3.12\\ffmpeg.exe',
      'ffmpeg',
    ].filter(Boolean);
    let index = 0;

    const next = () => {
      if (index >= bins.length) return reject(new Error('FFMPEG_UNAVAILABLE'));
      const child = spawn(bins[index++], [
        '-hide_banner',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vn',
        '-ac', '1',
        '-ar', '16000',
        '-f', 'wav',
        'pipe:1',
      ]);
      const output = [];
      let stderr = '';
      let spawnFailed = false;

      child.stdout.on('data', (chunk) => output.push(chunk));
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => {
        spawnFailed = true;
        if (error.code === 'ENOENT') next();
        else reject(error);
      });
      child.on('close', (code) => {
        if (spawnFailed) return;
        const wav = Buffer.concat(output);
        if (code === 0 && wav.length > 44) resolve(wav);
        else if (index < bins.length) next();
        else reject(new Error(stderr || 'FFMPEG_FAILED'));
      });
      child.stdin.end(input);
    };

    next();
  });
}

function parseStructured(text) {
  const source = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (character === '}' && depth) {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          values.push(JSON.parse(source.slice(start, index + 1)));
        } catch {}
        start = -1;
      }
    }
  }

  return values.findLast?.((value) => value && Array.isArray(value.points) && typeof value.summary === 'string')
    || values.at(-1)
    || null;
}

function parseSse(raw) {
  let content = '';
  for (const line of String(raw || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try {
      const chunk = JSON.parse(data);
      const part = chunk?.choices?.[0]?.delta?.content
        ?? chunk?.choices?.[0]?.message?.content
        ?? chunk?.delta?.text
        ?? '';
      if (typeof part === 'string') content += part;
      else if (Array.isArray(part)) content += part.map((item) => item?.text || '').join('');
    } catch {}
  }
  return content;
}

function extractTranscript(payload) {
  const candidates = [
    payload?.text,
    payload?.transcript,
    payload?.output?.text,
    payload?.output?.transcript,
    payload?.data?.text,
    payload?.data?.transcript,
    payload?.result?.text,
    payload?.result?.transcript,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }

  const arrays = [payload?.transcripts, payload?.output?.transcripts, payload?.data?.transcripts];
  for (const items of arrays) {
    if (!Array.isArray(items)) continue;
    const text = items.map((item) => typeof item === 'string' ? item : item?.text || '').join('').trim();
    if (text) return text;
  }
  return '';
}

function timestampMs(item, prefix) {
  const milliseconds = item?.[`${prefix}_time`] ?? item?.[`${prefix}_ms`];
  if (Number.isFinite(Number(milliseconds))) return Math.max(0, Math.round(Number(milliseconds)));
  const seconds = item?.[prefix];
  if (Number.isFinite(Number(seconds))) return Math.max(0, Math.round(Number(seconds) * 1000));
  return null;
}

function normalizeTranscriptSegment(item) {
  const text = String(item?.text ?? item?.transcript ?? item?.content ?? '').trim();
  if (!text) return null;
  return {
    startMs: timestampMs(item, 'begin') ?? timestampMs(item, 'start') ?? 0,
    endMs: timestampMs(item, 'end'),
    text,
  };
}

function splitTimedSentence(sentence) {
  const words = Array.isArray(sentence?.words) ? sentence.words : [];
  if (!words.length) {
    const segment = normalizeTranscriptSegment(sentence);
    return segment ? [segment] : [];
  }

  const segments = [];
  let text = '';
  let startMs = null;
  let endMs = null;

  const flush = () => {
    const value = text.trim();
    if (value) segments.push({ startMs: startMs ?? 0, endMs, text: value });
    text = '';
    startMs = null;
    endMs = null;
  };

  words.forEach((word, index) => {
    const wordText = String(word?.text || '');
    const punctuation = String(word?.punctuation || '');
    const token = punctuation && !wordText.endsWith(punctuation) ? `${wordText}${punctuation}` : wordText;
    const wordStart = timestampMs(word, 'begin') ?? timestampMs(word, 'start');
    const wordEnd = timestampMs(word, 'end');
    if (startMs === null && wordStart !== null) startMs = wordStart;
    if (wordEnd !== null) endMs = wordEnd;
    text += token;

    const next = words[index + 1];
    const nextStart = next ? timestampMs(next, 'begin') ?? timestampMs(next, 'start') : null;
    const longPause = nextStart !== null && endMs !== null && nextStart - endMs >= 1000;
    if (/[.!?。！？]$/u.test(token.trim()) || longPause || !next) flush();
  });

  return segments;
}

function extractTimedSegments(payload) {
  const arrays = [
    payload?.sentences,
    payload?.segments,
    payload?.transcripts,
    payload?.output?.sentences,
    payload?.output?.segments,
    payload?.data?.sentences,
    payload?.data?.segments,
    payload?.result?.sentences,
    payload?.result?.segments,
  ];
  for (const items of arrays) {
    if (!Array.isArray(items) || !items.length) continue;
    const segments = items.flatMap((item) => Array.isArray(item?.words)
      ? splitTimedSentence(item)
      : [normalizeTranscriptSegment(item)].filter(Boolean));
    if (segments.length) return segments;
  }

  const sentence = payload?.output?.sentence ?? payload?.sentence ?? payload?.data?.sentence;
  if (Array.isArray(sentence)) return sentence.flatMap(splitTimedSentence);
  return sentence ? splitTimedSentence(sentence) : [];
}

function parseSsePayloads(raw) {
  const source = String(raw || '').trim();
  if (!source) return [];
  try {
    return [JSON.parse(source)];
  } catch {}

  const payloads = [];
  for (const block of source.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      payloads.push(JSON.parse(data));
    } catch {}
  }
  return payloads;
}

function extractDashscopeTranscription(raw) {
  const payloads = parseSsePayloads(raw);
  if (!payloads.length) return null;

  const text = [...payloads].reverse().map(extractTranscript).find(Boolean) || '';
  const sentences = new Map();
  for (const payload of payloads) {
    const value = payload?.output?.sentence;
    const items = Array.isArray(value) ? value : value ? [value] : [];
    for (const sentence of items) {
      const key = sentence?.sentence_id ?? `${sentence?.begin_time ?? sentences.size}-${sentences.size}`;
      sentences.set(key, sentence);
    }
  }

  let segments = [...sentences.values()]
    .sort((left, right) => (left?.sentence_id ?? left?.begin_time ?? 0) - (right?.sentence_id ?? right?.begin_time ?? 0))
    .flatMap(splitTimedSentence);
  if (!segments.length) {
    segments = [...payloads].reverse().map(extractTimedSegments).find((items) => items.length) || [];
  }

  return { text, segments };
}

function extractAnalysisContent(payload) {
  const content = payload?.choices?.[0]?.message?.content
    ?? payload?.choices?.[0]?.text
    ?? payload?.output_text
    ?? payload?.completion
    ?? payload?.content
    ?? payload;

  if (Array.isArray(content)) {
    return content.map((block) => typeof block === 'string' ? block : block?.text || '').join('');
  }
  return content;
}

function upstreamDetail(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 1200);
}

function languageCode(value) {
  if (value === '中文（普通话）') return 'zh';
  if (value === 'English') return 'en';
  if (value === '日本語') return 'ja';
  return '';
}

function normalizeDashscopeFlashEndpoint(value) {
  const url = new URL(String(value || '').trim());
  if (url.pathname.endsWith('/services/aigc/multimodal-generation/generation')) return url.toString();
  url.pathname = '/api/v1/services/aigc/multimodal-generation/generation';
  return url.toString();
}

async function transcribeDashscopeFlash(wav, language) {
  const { TRANSCRIBE_URL, TRANSCRIBE_KEY, TRANSCRIBE_MODEL } = process.env;
  const endpoint = normalizeDashscopeFlashEndpoint(TRANSCRIBE_URL);
  const audioData = `data:audio/wav;base64,${wav.toString('base64')}`;
  const body = {
    model: TRANSCRIBE_MODEL,
    input: {
      messages: [{
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: audioData } }],
      }],
    },
    parameters: {
      format: 'wav',
      sample_rate: '16000',
      ...(languageCode(language) ? { language_hints: [languageCode(language)] } : {}),
    },
  };

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TRANSCRIBE_KEY}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.API_TIMEOUT_MS || 120000)),
    });
  } catch (error) {
    throw new Error(`语音服务不可达或超时: ${error.message}`);
  }

  const raw = await response.text();
  if (!response.ok) throw new Error(`语音服务返回 ${response.status}: ${upstreamDetail(raw)}`);

  const transcription = extractDashscopeTranscription(raw);
  if (!transcription?.text) throw new Error(`语音服务未返回文字稿: ${upstreamDetail(raw)}`);
  return transcription;
}

async function transcribe(wav, language) {
  const { TRANSCRIBE_URL, TRANSCRIBE_KEY, TRANSCRIBE_MODEL } = process.env;
  if (TRANSCRIBE_MODEL.startsWith('fun-asr-flash-')) {
    return transcribeDashscopeFlash(wav, language);
  }

  const endpoint = normalizeEndpoint(TRANSCRIBE_URL, 'transcription');
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', TRANSCRIBE_MODEL);
  const languageHint = languageCode(language);
  if (languageHint) form.append('language', languageHint);

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TRANSCRIBE_KEY}` },
      body: form,
      signal: AbortSignal.timeout(Number(process.env.API_TIMEOUT_MS || 120000)),
    });
  } catch (error) {
    throw new Error(`转写服务不可达或超时: ${error.message}`);
  }

  const raw = await response.text();
  if (!response.ok) throw new Error(`转写服务返回 ${response.status}: ${upstreamDetail(raw)}`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    if (raw.trim()) return { text: raw.trim(), segments: [] };
    throw new Error('转写服务返回了空响应');
  }

  const transcript = extractTranscript(payload);
  if (!transcript) throw new Error(`转写服务未返回文字稿: ${upstreamDetail(raw)}`);
  return { text: transcript, segments: extractTimedSegments(payload) };
}

async function analyzeTranscript(transcript, style, language) {
  const { AI_URL, AI_KEY, AI_MODEL } = process.env;
  const endpoint = normalizeEndpoint(AI_URL, 'analysis');
  const system = '你是专业的视频内容分析师。必须严格依据文字稿，不得补充文字稿中不存在的事实。只返回一个合法 JSON 对象，不要输出 Markdown 或解释。';
  const prompt = `请分析下面的视频文字稿，并按以下格式返回：\n{"theme":"视频主题","points":["核心观点1","核心观点2","核心观点3"],"summary":"一句话总结","cases":[["案例标题","案例说明"]]}\n\n输出语言：${language || '中文（普通话）'}\n分析风格：${style || '深度提炼'}\n\n完整文字稿：\n${transcript}`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        stream: false,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(Number(process.env.API_TIMEOUT_MS || 120000)),
    });
  } catch (error) {
    throw new Error(`分析服务不可达或超时: ${error.message}`);
  }

  const raw = await response.text();
  if (!response.ok) throw new Error(`分析服务返回 ${response.status}: ${upstreamDetail(raw)}`);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    const streamed = parseSse(raw);
    const result = parseStructured(streamed || raw);
    if (result) return result;
    throw new Error(`分析服务未返回可解析的 JSON: ${upstreamDetail(raw)}`);
  }

  const content = extractAnalysisContent(payload);
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  const result = parseStructured(content);
  if (!result) throw new Error(`分析服务未返回合法的结构化结果: ${upstreamDetail(typeof content === 'string' ? content : raw)}`);
  return result;
}

function normalizeResult(result, transcript, transcriptSegments = []) {
  const points = Array.isArray(result?.points) ? result.points.filter(Boolean).map(String) : [];
  const cases = Array.isArray(result?.cases) ? result.cases : [];
  if (!result?.theme || !result?.summary || !points.length) {
    throw new Error('分析结果缺少主题、核心观点或总结');
  }
  return {
    theme: String(result.theme),
    points,
    summary: String(result.summary),
    cases,
    transcript,
    transcriptSegments,
  };
}

async function handleAnalyze(req, res) {
  const required = ['TRANSCRIBE_URL', 'TRANSCRIBE_KEY', 'TRANSCRIBE_MODEL', 'AI_URL', 'AI_KEY', 'AI_MODEL'];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) return send(req, res, 503, { error: `服务端配置不完整: ${missing.join(', ')}` });

  let media;
  try {
    media = await collect(req, 2 * 1024 * 1024 * 1024);
  } catch (error) {
    return send(req, res, error.message === 'PAYLOAD_TOO_LARGE' ? 413 : 400, {
      error: error.message === 'PAYLOAD_TOO_LARGE' ? '文件超过 2GB 限制' : '无法读取上传文件',
    });
  }
  if (!media.length) return send(req, res, 400, { error: '没有收到视频文件' });

  let wav;
  try {
    wav = await extractWav(media);
  } catch (error) {
    return send(req, res, 422, { error: '无法从视频提取音频', detail: error.message });
  }

  const url = new URL(req.url, 'http://localhost');
  const language = url.searchParams.get('language') || '中文（普通话）';
  const style = url.searchParams.get('style') || '深度提炼';

  let transcription;
  try {
    transcription = await transcribe(wav, language);
  } catch (error) {
    return send(req, res, 502, { error: '语音转写失败', detail: error.message });
  }

  const transcript = transcription.text;
  let result;
  try {
    result = normalizeResult(
      await analyzeTranscript(transcript, style, language),
      transcript,
      transcription.segments,
    );
  } catch (error) {
    return send(req, res, 502, { error: '文字分析失败', detail: error.message });
  }

  return send(req, res, 200, result);
}

function healthPayload() {
  const required = ['TRANSCRIBE_URL', 'TRANSCRIBE_KEY', 'TRANSCRIBE_MODEL', 'AI_URL', 'AI_KEY', 'AI_MODEL'];
  const missing = required.filter((key) => !process.env[key]);
  return {
    configured: missing.length === 0,
    missing,
    transcribeModel: process.env.TRANSCRIBE_MODEL || '',
    analysisModel: process.env.AI_MODEL || '',
  };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      return res.end();
    }
    if (req.url === '/api/health' && req.method === 'GET') return send(req, res, 200, healthPayload());
    if (req.url?.startsWith('/api/analyze') && req.method === 'POST') return handleAnalyze(req, res);

    const requestUrl = new URL(req.url, 'http://localhost');
    const relativePath = requestUrl.pathname === '/' ? 'index.html' : decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    const path = normalize(join(root, relativePath));
    if (!path.startsWith(root)) return send(req, res, 403, { error: 'forbidden' });
    const info = await stat(path);
    if (!info.isFile()) throw new Error('not file');
    return send(req, res, 200, await readFile(path), mime[extname(path)] || 'application/octet-stream');
  } catch {
    return send(req, res, 404, { error: 'not found' });
  }
});

const port = Number(process.env.PORT || 5173);
server.listen(port, () => console.log(`Voxora running at http://localhost:${port}`));
