const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');

/**
 * Đọc file .env nếu tồn tại mà không cần thư viện ngoài.
 */
function parseEnvFile(envPath) {
  const result = {};
  if (!fs.existsSync(envPath)) return result;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

const ENV_PATH = path.join(__dirname, '.env');
const initialEnv = parseEnvFile(ENV_PATH);

function getServerEnv(key) {
  if (process.env[key]) return process.env[key];
  const latest = parseEnvFile(ENV_PATH);
  return latest[key] || '';
}

const PORT = Number(process.env.PORT || initialEnv.PORT) || 3000;
const DEFAULT_MODEL = process.env.GEMINI_MODEL || initialEnv.GEMINI_MODEL || 'gemini-2.5-flash';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const HISTORIES_DIR = path.join(DATA_DIR, 'histories');
const PIPER_VOICES_DIR = path.join(__dirname, 'piper_voices');

function getCandidateDirs() {
  const dirs = [__dirname];
  if (process.cwd() !== __dirname) dirs.push(process.cwd());
  return dirs;
}

function getPiperVoicesDir() {
  for (const base of getCandidateDirs()) {
    const dir = path.join(base, 'piper_voices');
    if (fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.onnx'))) {
      return dir;
    }
  }
  return path.join(__dirname, 'piper_voices');
}

function detectEspeakNg() {
  try {
    execFileSync('espeak-ng', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function detectPiperRunner() {
  const candidates = [];
  for (const base of getCandidateDirs()) {
    candidates.push({ cmd: path.join(base, 'piper-venv', 'bin', 'piper'), prefix: [] });
    candidates.push({ cmd: path.join(base, 'piper-venv', 'bin', 'python3'), prefix: ['-m', 'piper'] });
  }
  candidates.push(
    { cmd: path.join(os.homedir(), '.local', 'bin', 'piper'), prefix: [] },
    { cmd: 'piper', prefix: [] },
    { cmd: 'python3', prefix: ['-m', 'piper'] }
  );
  for (const c of candidates) {
    try {
      execFileSync(c.cmd, [...c.prefix, '--help'], { stdio: 'ignore' });
      return c;
    } catch {
      // thử ứng viên tiếp theo
    }
  }
  return null;
}

function findPiperModel(lang) {
  const voicesDir = getPiperVoicesDir();
  if (!fs.existsSync(voicesDir)) return null;
  const files = fs.readdirSync(voicesDir).filter((f) => f.endsWith('.onnx'));
  if (!files.length) return null;

  const norm = String(lang || 'vi-VN').toLowerCase().replace('-', '_');
  const prefix = norm.split('_')[0];
  const match =
    files.find((f) => f.toLowerCase().startsWith(norm)) ||
    files.find((f) => f.toLowerCase().startsWith(prefix)) ||
    (prefix === 'en' ? files.find((f) => f.toLowerCase().startsWith('en_')) : null);

  return match ? path.join(voicesDir, match) : null;
}

const HAS_ESPEAK_NG = detectEspeakNg();
const PIPER_RUNNER = detectPiperRunner();

function detectPiperPython() {
  const pyCandidates = [];
  for (const base of getCandidateDirs()) {
    pyCandidates.push(path.join(base, 'piper-venv', 'bin', 'python3'));
  }
  pyCandidates.push('python3');
  for (const py of pyCandidates) {
    try {
      execFileSync(py, ['-c', 'import piper'], { stdio: 'ignore' });
      return py;
    } catch {
      // thử tiếp
    }
  }
  return null;
}

const PIPER_PYTHON = detectPiperPython();

function hasAnyPiperModel() {
  if (!PIPER_RUNNER && !PIPER_PYTHON) return false;
  const voicesDir = getPiperVoicesDir();
  if (!fs.existsSync(voicesDir)) return false;
  return fs.readdirSync(voicesDir).some((f) => f.endsWith('.onnx'));
}

const HAS_LOCAL_TTS = HAS_ESPEAK_NG || hasAnyPiperModel();

const PIPER_WORKER_SCRIPT = [
  'import sys, json, wave, inspect',
  'from piper import PiperVoice',
  'try:',
  '    from piper import SynthesisConfig',
  'except Exception:',
  '    SynthesisConfig = None',
  'voices = {}',
  'for raw in sys.stdin:',
  '    raw = raw.strip()',
  '    if not raw:',
  '        continue',
  '    try:',
  '        req = json.loads(raw)',
  '        m = req["model"]',
  '        if m not in voices:',
  '            voices[m] = PiperVoice.load(m)',
  '        v = voices[m]',
  '        ls = float(req.get("length_scale", 1.0))',
  '        with wave.open(req["out"], "wb") as wf:',
  '            if SynthesisConfig is not None:',
  '                v.synthesize_wav(req["text"], wf, syn_config=SynthesisConfig(length_scale=ls))',
  '            else:',
  '                v.synthesize_wav(req["text"], wf)',
  '        print(json.dumps({"ok": True}), flush=True)',
  '    except Exception as exc:',
  '        print(json.dumps({"ok": False, "error": str(exc)}), flush=True)',
].join('\n');

let piperWorkerProc = null;
let piperQueue = Promise.resolve();
let piperLineBuffer = '';
let piperPendingResolve = null;

function ensurePiperWorker() {
  if (!PIPER_PYTHON) return null;
  if (piperWorkerProc && !piperWorkerProc.killed) return piperWorkerProc;

  piperLineBuffer = '';
  const proc = spawn(PIPER_PYTHON, ['-u', '-c', PIPER_WORKER_SCRIPT], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  proc.stdout.on('data', (chunk) => {
    piperLineBuffer += chunk.toString('utf8');
    const idx = piperLineBuffer.indexOf('\n');
    if (idx !== -1) {
      const line = piperLineBuffer.slice(0, idx).trim();
      piperLineBuffer = piperLineBuffer.slice(idx + 1);
      if (piperPendingResolve) {
        const resolve = piperPendingResolve;
        piperPendingResolve = null;
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ ok: false, error: 'Invalid worker JSON' });
        }
      }
    }
  });

  proc.on('error', (err) => {
    if (piperWorkerProc === proc) piperWorkerProc = null;
    if (piperPendingResolve) {
      const resolve = piperPendingResolve;
      piperPendingResolve = null;
      resolve({ ok: false, error: err.message || 'Piper worker error' });
    }
  });

  proc.on('exit', () => {
    if (piperWorkerProc === proc) piperWorkerProc = null;
    if (piperPendingResolve) {
      const resolve = piperPendingResolve;
      piperPendingResolve = null;
      resolve({ ok: false, error: 'Piper worker exited' });
    }
  });

  piperWorkerProc = proc;
  return proc;
}

function synthesizePiperWarm(text, modelPath, rate) {
  const cleanText = String(text || '').trim().slice(0, 600);
  const lengthScale = Math.max(0.65, Math.min(1.5, 1 / (Number(rate) || 1.05)));
  const outPath = path.join(
    os.tmpdir(),
    `roboai_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`
  );

  const task = async () => {
    const proc = ensurePiperWorker();
    if (!proc) throw new Error('Piper Python worker unavailable');

    const res = await new Promise((resolve, reject) => {
      piperPendingResolve = resolve;
      proc.stdin.write(
        `${JSON.stringify({ model: modelPath, text: cleanText, length_scale: lengthScale, out: outPath })}\n`,
        (err) => {
          if (err) {
            piperPendingResolve = null;
            reject(err);
          }
        }
      );
    });

    if (!res.ok || !fs.existsSync(outPath)) {
      try {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        // ignore
      }
      throw new Error(res.error || 'Piper worker failed');
    }

    const buf = fs.readFileSync(outPath);
    fs.unlinkSync(outPath);
    return buf;
  };

  const next = piperQueue.then(task, task);
  piperQueue = next.catch(() => {});
  return next;
}

function synthesizePiperWavCli(text, modelPath, rate) {
  const cleanText = String(text || '').trim().slice(0, 600);
  const lengthScale = Math.max(0.65, Math.min(1.5, 1 / (Number(rate) || 1.05)));
  const outPath = path.join(
    os.tmpdir(),
    `roboai_tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`
  );

  return new Promise((resolve, reject) => {
    const args = [
      ...PIPER_RUNNER.prefix,
      '--model',
      modelPath,
      '--length_scale',
      lengthScale.toFixed(2),
      '--output_file',
      outPath,
    ];
    const child = spawn(PIPER_RUNNER.cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let errText = '';
    child.stderr.on('data', (d) => {
      errText += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        try {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        } catch {
          // ignore
        }
        return reject(new Error(errText || `Piper thoát với mã ${code}`));
      }
      try {
        const buf = fs.readFileSync(outPath);
        fs.unlinkSync(outPath);
        resolve(buf);
      } catch (readErr) {
        reject(readErr);
      }
    });
    child.stdin.write(`${cleanText}\n`);
    child.stdin.end();
  });
}

async function synthesizePiperWav(text, modelPath, rate) {
  if (PIPER_PYTHON) {
    try {
      return await synthesizePiperWarm(text, modelPath, rate);
    } catch (warmErr) {
      console.error('Piper warm worker fallback:', warmErr.message);
    }
  }
  if (PIPER_RUNNER) {
    return synthesizePiperWavCli(text, modelPath, rate);
  }
  throw new Error('Không tìm thấy Piper runner.');
}

function synthesizeEspeakWav(text, lang, rate) {
  const cleanText = String(text || '').trim().slice(0, 600);
  const normLang = String(lang || 'vi-VN').toLowerCase();
  const voiceCode =
    normLang === 'en-in' ? 'en-in' : normLang.startsWith('en') ? 'en-us' : 'vi';
  const wpm = Math.max(110, Math.min(240, Math.round(160 * (Number(rate) || 1.05))));

  const runWithVoice = (voice) =>
    new Promise((resolve, reject) => {
      execFile(
        'espeak-ng',
        ['--stdout', '-v', voice, '-s', String(wpm), cleanText],
        { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return reject(err);
          resolve(stdout);
        }
      );
    });

  return runWithVoice(voiceCode).catch((err) => {
    if (voiceCode === 'en-in') {
      return runWithVoice('en');
    }
    throw err;
  });
}

function ensureDataDirs() {
  fs.mkdirSync(HISTORIES_DIR, { recursive: true });
}

function readProfiles() {
  ensureDataDirs();
  if (!fs.existsSync(PROFILES_FILE)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeProfiles(profiles) {
  ensureDataDirs();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), 'utf8');
}

function sanitizeProfileId(rawId) {
  return String(rawId || 'guest').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'guest';
}

function getHistoryFile(profileId) {
  ensureDataDirs();
  return path.join(HISTORIES_DIR, `${sanitizeProfileId(profileId)}.json`);
}

function readProfileHistory(profileId) {
  const file = getHistoryFile(profileId);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeProfileHistory(profileId, history) {
  const file = getHistoryFile(profileId);
  const safeList = Array.isArray(history) ? history.slice(-60) : [];
  fs.writeFileSync(file, JSON.stringify(safeList, null, 2), 'utf8');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const PERSONA_PROMPTS = {
  general:
    'Bạn là một Robot trợ giảng thân thiện, thông minh và truyền cảm hứng cho học sinh. Hãy trả lời rõ ràng, sinh động, dễ hiểu và khơi gợi trí tò mò.',
  science:
    'Bạn là Robot nhà khoa học vui tính. Khi giải thích hiện tượng tự nhiên, vật lý, hóa học hay sinh học, hãy dùng ví dụ đời thường gần gũi với học sinh.',
  math:
    'Bạn là Robot gia sư Toán & Logic. Hãy hướng dẫn từng bước ngắn gọn, trực quan để học sinh tự hiểu cách giải thay vì chỉ đọc đáp án khô khan.',
  history:
    'Bạn là Robot kể chuyện Lịch sử & Văn học. Hãy kể lại kiến thức như một câu chuyện hấp dẫn, giàu hình ảnh và dễ nhớ cho học sinh.',
  english:
    'Bạn là Robot luyện giao tiếp Tiếng Anh thân thiện. Hãy trả lời bằng tiếng Anh rõ ràng, câu ngắn vừa sức học sinh kèm giải thích hoặc gợi ý ngắn bằng tiếng Việt nếu cần.',
};

const GRADE_PROMPTS = {
  elementary:
    'Đối tượng là học sinh Tiểu học: dùng từ ngữ cực kỳ đơn giản, vui tươi, ví dụ trực quan, câu ngắn để đọc thành tiếng nghe tự nhiên.',
  middle:
    'Đối tượng là học sinh THCS: giải thích mạch lạc, khoa học nhưng gần gũi, độ dài vừa phải.',
  high:
    'Đối tượng là học sinh THPT: giải thích súc tích, chính xác kiến thức chuyên môn, khuyến khích tư duy phản biện.',
};

function buildSystemInstruction({
  persona,
  gradeLevel,
  botName,
  language,
  hasAudio,
  activeProfile,
}) {
  const personaText = PERSONA_PROMPTS[persona] || PERSONA_PROMPTS.general;
  const gradeText = GRADE_PROMPTS[gradeLevel] || GRADE_PROMPTS.middle;
  const safeName = (botName || 'RoboAI').slice(0, 40);

  const isEnglishMode = typeof language === 'string' && language.toLowerCase().startsWith('en');

  const rules = [
    `Tên của bạn là ${safeName}.`,
    personaText,
    gradeText,
    'Vì câu trả lời sẽ được hiển thị trên màn hình lớp học VÀ đọc thành tiếng qua loa (Text-to-Speech), hãy:',
    '- Trả lời súc tích (thường 2-5 câu hoặc các ý ngắn gọn), tự nhiên như đang nói chuyện trực tiếp với học sinh.',
    '- Hạn chế ký tự markdown rườm rà hay bảng biểu phức tạp; có thể dùng **in đậm** cho từ khóa quan trọng.',
    '- Nếu học sinh hỏi ngoài phạm vi an toàn hoặc không phù hợp lứa tuổi, nhẹ nhàng từ chối và hướng về kiến thức học tập lành mạnh.',
    isEnglishMode
      ? 'Trả lời hoàn toàn bằng tiếng Anh tự nhiên, rõ ràng, phù hợp học sinh để đọc trực tiếp bằng giọng đọc tiếng Anh (chỉ chèn tiếng Việt nếu học sinh hỏi bằng tiếng Việt hoặc yêu cầu dịch).'
      : 'Ưu tiên trả lời bằng tiếng Việt chuẩn, tự nhiên (trừ khi học sinh yêu cầu ngôn ngữ khác hoặc đang ở chế độ Tiếng Anh).',
  ];

  if (activeProfile && activeProfile.name) {
    const personName = String(activeProfile.name).slice(0, 60);
    const note = String(activeProfile.personaNote || '').trim().slice(0, 300);
    rules.push(
      `CHẾ ĐỘ AI CÁ NHÂN: Bạn hiện đang là trợ lý AI cá nhân riêng của **${personName}** (đã nhận diện qua khuôn mặt).`,
      `- Hãy gọi tên **${personName}** một cách thân thiện, tự nhiên trong cuộc trò chuyện và nhớ ngữ cảnh hỏi đáp riêng của ${personName}.`
    );
    if (note) {
      rules.push(`- Thông tin / sở thích / phong cách riêng của ${personName}: ${note}`);
    }
  }

  if (hasAudio) {
    rules.push(
      'Người dùng gửi kèm đoạn âm thanh câu hỏi. Hãy lắng nghe và trả lời trực tiếp câu hỏi trong đoạn âm thanh đó.'
    );
  }

  return rules.join('\n');
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendSseEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Dữ liệu gửi lên quá lớn.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('JSON không hợp lệ.'));
      }
    });
    req.on('error', reject);
  });
}

function parseUpstreamError(errorText, status) {
  let friendly = `Lỗi API (${status})`;
  try {
    const parsed = JSON.parse(errorText);
    if (parsed.error && parsed.error.message) {
      friendly = parsed.error.message;
    } else if (typeof parsed.message === 'string') {
      friendly = parsed.message;
    }
  } catch {
    if (errorText && errorText.trim()) {
      friendly = errorText.trim().slice(0, 240);
    }
  }
  return friendly;
}

async function streamOpenAICompatible({
  res,
  baseUrl,
  apiKey,
  model,
  systemInstruction,
  history,
  startTime,
}) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const endpoint = cleanBase.endsWith('/chat/completions')
    ? cleanBase
    : `${cleanBase}/chat/completions`;

  const messages = [{ role: 'system', content: systemInstruction }];
  for (const msg of history) {
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) continue;
    messages.push({
      role: msg.role === 'model' || msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.text.trim(),
    });
  }

  let firstTokenMs = null;

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.7,
      max_tokens: 1024,
    }),
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    sendSseEvent(res, { type: 'error', message: parseUpstreamError(errorText, upstream.status) });
    res.end();
    return;
  }

  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await upstream.json();
    const text = data?.choices?.[0]?.message?.content || '';
    firstTokenMs = Date.now() - startTime;
    if (text) {
      sendSseEvent(res, { type: 'delta', text, firstTokenMs });
    }
    sendSseEvent(res, {
      type: 'done',
      firstTokenMs,
      totalMs: Date.now() - startTime,
      model,
    });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const payload = JSON.parse(jsonStr);
        const deltaText = payload?.choices?.[0]?.delta?.content;
        if (typeof deltaText === 'string' && deltaText.length > 0) {
          if (firstTokenMs === null) {
            firstTokenMs = Date.now() - startTime;
          }
          sendSseEvent(res, {
            type: 'delta',
            text: deltaText,
            firstTokenMs,
          });
        }
      } catch {
        // bỏ qua chunk chưa hoàn chỉnh
      }
    }
  }

  sendSseEvent(res, {
    type: 'done',
    firstTokenMs: firstTokenMs ?? Date.now() - startTime,
    totalMs: Date.now() - startTime,
    model,
  });
  res.end();
}

async function streamGeminiNative({
  res,
  apiKey,
  model,
  systemInstruction,
  contents,
  startTime,
}) {
  let firstTokenMs = null;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 1024,
      },
    }),
  });

  if (!upstream.ok) {
    const errorText = await upstream.text();
    let friendly = parseUpstreamError(errorText, upstream.status);
    if (/API key not valid/i.test(friendly) && apiKey.startsWith('sk-')) {
      friendly =
        "API Key bắt đầu bằng 'sk-' không phải Google Gemini API Key. Nếu dùng router OpenAI-compatible, hãy điền API Base URL (ví dụ: https://router.kynx.space/v1) trong Cài đặt hoặc .env.";
    }
    sendSseEvent(res, { type: 'error', message: friendly });
    res.end();
    return;
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr || jsonStr === '[DONE]') continue;

      try {
        const payload = JSON.parse(jsonStr);
        const parts = payload?.candidates?.[0]?.content?.parts;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            if (firstTokenMs === null) {
              firstTokenMs = Date.now() - startTime;
            }
            sendSseEvent(res, {
              type: 'delta',
              text: part.text,
              firstTokenMs,
            });
          }
        }
      } catch {
        // bỏ qua chunk chưa hoàn chỉnh
      }
    }
  }

  sendSseEvent(res, {
    type: 'done',
    firstTokenMs: firstTokenMs ?? Date.now() - startTime,
    totalMs: Date.now() - startTime,
    model,
  });
  res.end();
}

async function handleChatStream(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const clientKey = (body.apiKey || '').trim();
  const serverKey = getServerEnv('GEMINI_API_KEY').trim();
  const validServerKey =
    serverKey && serverKey !== 'your_gemini_api_key_here' ? serverKey : '';
  // Ưu tiên key người dùng nhập trong Cài đặt nếu có, sau đó mới dùng .env
  const effectiveKey = clientKey || validServerKey;

  if (!effectiveKey) {
    sendJson(res, 401, {
      error: 'Chưa cấu hình API Key. Hãy thêm key vào file .env hoặc nhập trong phần Cài đặt.',
    });
    return;
  }

  const serverBaseUrl = getServerEnv('API_BASE_URL').trim();
  const effectiveBaseUrl = (body.baseUrl || '').trim() || serverBaseUrl;
  const serverModel = getServerEnv('GEMINI_MODEL').trim() || DEFAULT_MODEL;
  const model = ((body.model || '').trim() || serverModel).replace(/[^a-zA-Z0-9._:/-]/g, '');

  const history = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const contents = [];

  for (const msg of history) {
    if (!msg || typeof msg.text !== 'string' || !msg.text.trim()) continue;
    contents.push({
      role: msg.role === 'model' ? 'model' : 'user',
      parts: [{ text: msg.text.trim() }],
    });
  }

  if (body.audioData && body.audioData.data && body.audioData.mimeType) {
    if (effectiveBaseUrl) {
      sendJson(res, 400, {
        error: 'Endpoint router không hỗ trợ gửi audio trực tiếp. Hãy dùng Chrome/Edge để nhận diện giọng nói hoặc gõ câu hỏi.',
      });
      return;
    }
    const audioParts = [
      {
        inlineData: {
          mimeType: body.audioData.mimeType,
          data: body.audioData.data,
        },
      },
    ];
    if (body.promptText) {
      audioParts.unshift({ text: body.promptText });
    }
    contents.push({ role: 'user', parts: audioParts });
  }

  if (contents.length === 0) {
    sendJson(res, 400, { error: 'Chưa có nội dung câu hỏi.' });
    return;
  }

  const systemInstruction = buildSystemInstruction({
    persona: body.persona,
    gradeLevel: body.gradeLevel,
    botName: body.botName,
    language: body.language,
    hasAudio: Boolean(body.audioData),
    activeProfile: body.activeProfile,
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const startTime = Date.now();

  try {
    const useOpenAI = Boolean(effectiveBaseUrl) && !effectiveBaseUrl.includes('generativelanguage.googleapis.com');
    if (useOpenAI) {
      await streamOpenAICompatible({
        res,
        baseUrl: effectiveBaseUrl,
        apiKey: effectiveKey,
        model,
        systemInstruction,
        history,
        startTime,
      });
    } else {
      await streamGeminiNative({
        res,
        apiKey: effectiveKey,
        model,
        systemInstruction,
        contents,
        startTime,
      });
    }
  } catch (err) {
    sendSseEvent(res, {
      type: 'error',
      message: err.message || 'Không thể kết nối tới máy chủ AI.',
    });
    res.end();
  }
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = urlObj;

  if (req.method === 'GET' && pathname === '/api/config') {
    const serverKey = getServerEnv('GEMINI_API_KEY').trim();
    const hasServerKey = Boolean(serverKey && serverKey !== 'your_gemini_api_key_here');
    const defaultModel = getServerEnv('GEMINI_MODEL').trim() || DEFAULT_MODEL;
    const defaultBaseUrl = getServerEnv('API_BASE_URL').trim();
    const piperActive = Boolean((PIPER_RUNNER || PIPER_PYTHON) && hasAnyPiperModel());
    sendJson(res, 200, {
      hasServerKey,
      defaultModel,
      defaultBaseUrl,
      hasLocalTts: HAS_ESPEAK_NG || piperActive,
      localTtsEngine: piperActive ? 'piper' : HAS_ESPEAK_NG ? 'espeak' : null,
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/tts') {
    const text = urlObj.searchParams.get('text') || '';
    const lang = urlObj.searchParams.get('lang') || 'vi-VN';
    const rate = urlObj.searchParams.get('rate') || '1.05';
    if (!text.trim()) {
      sendJson(res, 400, { error: 'Thiếu nội dung text.' });
      return;
    }

    const piperModel = PIPER_RUNNER || PIPER_PYTHON ? findPiperModel(lang) : null;
    if (!piperModel && !HAS_ESPEAK_NG) {
      sendJson(res, 501, { error: 'Server chưa cài Piper TTS hoặc espeak-ng.' });
      return;
    }

    try {
      let wav;
      if (piperModel) {
        try {
          wav = await synthesizePiperWav(text, piperModel, rate);
        } catch (piperErr) {
          console.error('Piper TTS error:', piperErr.message);
          if (!HAS_ESPEAK_NG) throw piperErr;
          wav = await synthesizeEspeakWav(text, lang, rate);
        }
      } else {
        wav = await synthesizeEspeakWav(text, lang, rate);
      }
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': wav.length,
        'Cache-Control': 'no-store',
      });
      res.end(wav);
    } catch (err) {
      sendJson(res, 500, { error: err.message || 'Lỗi tạo âm thanh TTS.' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/profiles') {
    sendJson(res, 200, { profiles: readProfiles() });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/profiles') {
    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().slice(0, 60);
      const descriptors = Array.isArray(body.descriptors) ? body.descriptors : [];
      if (!name) {
        sendJson(res, 400, { error: 'Vui lòng nhập tên người dùng.' });
        return;
      }
      if (descriptors.length === 0 || !Array.isArray(descriptors[0]) || descriptors[0].length !== 128) {
        sendJson(res, 400, { error: 'Chưa quét được đặc trưng khuôn mặt hợp lệ.' });
        return;
      }

      const profiles = readProfiles();
      const id = body.id ? sanitizeProfileId(body.id) : `user_${Date.now()}`;
      const profile = {
        id,
        name,
        personaNote: String(body.personaNote || '').trim().slice(0, 300),
        preferredPersona: String(body.preferredPersona || 'general'),
        preferredGrade: String(body.preferredGrade || 'middle'),
        preferredLanguage: String(body.preferredLanguage || 'vi-VN'),
        avatarDataUrl: typeof body.avatarDataUrl === 'string' ? body.avatarDataUrl.slice(0, 200000) : '',
        descriptors: descriptors.slice(0, 5),
        createdAt: Date.now(),
      };

      const existingIdx = profiles.findIndex((p) => p.id === id);
      if (existingIdx >= 0) {
        profiles[existingIdx] = profile;
      } else {
        profiles.push(profile);
      }
      writeProfiles(profiles);
      sendJson(res, 200, { profile });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Không thể lưu hồ sơ khuôn mặt.' });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
    const id = sanitizeProfileId(pathname.slice('/api/profiles/'.length));
    const profiles = readProfiles();
    const next = profiles.filter((p) => p.id !== id);
    writeProfiles(next);
    const histFile = getHistoryFile(id);
    if (fs.existsSync(histFile)) {
      fs.unlinkSync(histFile);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/history') {
    const profileId = urlObj.searchParams.get('profileId') || 'guest';
    sendJson(res, 200, { history: readProfileHistory(profileId) });
    return;
  }

  if (req.method === 'PUT' && pathname === '/api/history') {
    try {
      const body = await readJsonBody(req);
      const profileId = body.profileId || 'guest';
      writeProfileHistory(profileId, body.history || []);
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (req.method === 'DELETE' && pathname === '/api/history') {
    const profileId = urlObj.searchParams.get('profileId') || 'guest';
    writeProfileHistory(profileId, []);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat/stream') {
    handleChatStream(req, res);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405);
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  const piperActive = Boolean((PIPER_RUNNER || PIPER_PYTHON) && hasAnyPiperModel());
  const ttsMode = piperActive ? 'Piper Neural' : HAS_ESPEAK_NG ? 'espeak-ng' : 'Browser Web Speech';
  console.log(`🤖 RoboAI Classroom Server đang chạy tại: http://localhost:${PORT} (TTS: ${ttsMode})`);
  if (piperActive) {
    ensurePiperWorker();
  }
});
