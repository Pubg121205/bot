class SpeechManager {
  constructor() {
    this.Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.recognition = null;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.micStream = null;
    this.isListening = false;
    this.language = 'vi-VN';
    this.finalTranscript = '';
    this.interimTranscript = '';

    this.hasServerStt = false;
    this.webSpeechBlocked = false;
    this.wavSession = null;
  }

  supportsWebSpeech() {
    return Boolean(this.Recognition);
  }

  setServerSttAvailable(available) {
    this.hasServerStt = Boolean(available);
  }

  setLanguage(lang) {
    this.language = lang || 'vi-VN';
  }

  _shouldUseServerStt() {
    if (!this.hasServerStt) return false;
    if (!this.Recognition || this.webSpeechBlocked) return true;
    // Chromium trên Linux / Raspberry Pi mặc định tắt khóa Google Web Speech API
    return /Linux/i.test(navigator.userAgent || '') && !/Android/i.test(navigator.userAgent || '');
  }

  async startListening({ onStart, onInterim, onFinal, onProcessing, onAudioRecorded, onError, onEnd }) {
    if (this.isListening) return;
    this.finalTranscript = '';
    this.interimTranscript = '';

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      onError?.('Không thể truy cập Micro. Hãy cấp quyền sử dụng Micro cho trình duyệt.');
      return;
    }

    this.isListening = true;
    onStart?.(this.micStream);

    if (this._shouldUseServerStt()) {
      this._startWavRecorder({ onFinal, onProcessing, onError, onEnd });
    } else if (this.Recognition) {
      this._startWebSpeech({ onInterim, onFinal, onProcessing, onError, onEnd });
    } else {
      this._startMediaRecorder({ onAudioRecorded, onError, onEnd });
    }
  }

  stopListening() {
    if (!this.isListening) return;
    this.isListening = false;

    if (this.wavSession) {
      this.wavSession.stop();
      return;
    }

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // ignore
      }
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // ignore
      }
    }
  }

  _cleanupMicStream() {
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }
  }

  _startWebSpeech({ onInterim, onFinal, onProcessing, onError, onEnd }) {
    const rec = new this.Recognition();
    this.recognition = rec;
    rec.lang = this.language;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let deliveredFinal = false;
    let switchingToServer = false;

    rec.onresult = (event) => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        const text = res[0]?.transcript || '';
        if (res.isFinal) {
          finalChunk += text;
        } else {
          interim += text;
        }
      }

      if (finalChunk) {
        this.finalTranscript = `${this.finalTranscript} ${finalChunk}`.trim();
      }
      this.interimTranscript = interim.trim();
      onInterim?.(this.finalTranscript, this.interimTranscript);
    };

    rec.onerror = (event) => {
      if ((event.error === 'network' || event.error === 'service-not-allowed') && this.hasServerStt && this.micStream) {
        this.webSpeechBlocked = true;
        switchingToServer = true;
        this._startWavRecorder({ onFinal, onProcessing, onError, onEnd });
        return;
      }

      this.isListening = false;
      this._cleanupMicStream();
      if (event.error === 'no-speech') {
        onError?.('Chưa nghe thấy giọng nói, em thử nói lại gần mic hơn nhé.');
      } else if (event.error === 'not-allowed') {
        onError?.('Micro chưa được cấp quyền trên trình duyệt.');
      } else if (event.error === 'network' || event.error === 'service-not-allowed') {
        onError?.(
          'Trình duyệt Raspberry Pi chặn Web Speech. Hãy cài SpeechRecognition trên Pi (./piper-venv/bin/pip install SpeechRecognition) để dùng Mic.'
        );
      } else if (event.error !== 'aborted') {
        onError?.(`Lỗi nhận diện giọng nói: ${event.error}`);
      }
      onEnd?.();
    };

    rec.onend = () => {
      if (switchingToServer) return;
      this.isListening = false;
      this._cleanupMicStream();
      const combined = `${this.finalTranscript} ${this.interimTranscript}`.trim();
      if (combined && !deliveredFinal) {
        deliveredFinal = true;
        onFinal?.(combined);
      }
      onEnd?.();
    };

    try {
      rec.start();
    } catch (err) {
      this.isListening = false;
      this._cleanupMicStream();
      onError?.('Không thể khởi động nhận diện giọng nói.');
      onEnd?.();
    }
  }

  _encodeWavBase64(chunks, inputSampleRate) {
    let totalLen = 0;
    for (const c of chunks) totalLen += c.length;
    const merged = new Float32Array(totalLen);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }

    const targetRate = 16000;
    const ratio = inputSampleRate / targetRate;
    const outLen = Math.max(1, Math.round(merged.length / ratio));
    const samples = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const idx = Math.min(merged.length - 1, Math.floor(i * ratio));
      const s = Math.max(-1, Math.min(1, merged[idx]));
      samples[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (pos, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(pos + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let byteOffset = 44;
    for (let i = 0; i < samples.length; i++, byteOffset += 2) {
      view.setInt16(byteOffset, samples[i], true);
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  _startWavRecorder({ onFinal, onProcessing, onError, onEnd }) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !this.micStream) {
      this.isListening = false;
      this._cleanupMicStream();
      onError?.('Trình duyệt không hỗ trợ ghi âm WAV.');
      onEnd?.();
      return;
    }

    const ctx = new AudioCtx();
    const source = ctx.createMediaStreamSource(this.micStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    const pcmChunks = [];
    const startTime = Date.now();
    let spokeAtMs = 0;
    let lastVoiceMs = Date.now();
    let stopped = false;

    const finalize = async () => {
      if (stopped) return;
      stopped = true;
      this.wavSession = null;
      this.isListening = false;

      try {
        processor.disconnect();
        silentGain.disconnect();
        source.disconnect();
        await ctx.close();
      } catch {
        // ignore
      }
      this._cleanupMicStream();

      const durationMs = Date.now() - startTime;
      if (durationMs < 350 || pcmChunks.length === 0) {
        onEnd?.();
        return;
      }

      onProcessing?.('Đang nhận diện giọng nói...');
      try {
        const wavBase64 = this._encodeWavBase64(pcmChunks, ctx.sampleRate || 48000);
        const res = await fetch('/api/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ wavBase64, language: this.language }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'Không nhận diện được giọng nói.');
        }
        if (data.text && data.text.trim()) {
          onFinal?.(data.text.trim());
        } else {
          onError?.('Chưa nghe rõ câu hỏi, em thử nói lại gần mic hơn nhé.');
        }
      } catch (err) {
        onError?.(err.message || 'Lỗi nhận diện giọng nói.');
      } finally {
        onEnd?.();
      }
    };

    this.wavSession = { stop: finalize };

    processor.onaudioprocess = (e) => {
      if (stopped) return;
      const out = e.outputBuffer.getChannelData(0);
      out.fill(0);
      const input = e.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));

      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      const now = Date.now();
      if (rms > 0.015) {
        if (!spokeAtMs) spokeAtMs = now;
        lastVoiceMs = now;
      }

      // Tự dừng sau khi nói xong và im lặng ~1.5s, hoặc tối đa 15s
      if ((spokeAtMs && now - spokeAtMs > 450 && now - lastVoiceMs > 1500) || now - startTime > 15000) {
        finalize();
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(ctx.destination);
  }

  _startMediaRecorder({ onAudioRecorded, onError, onEnd }) {
    if (typeof MediaRecorder === 'undefined') {
      this.isListening = false;
      this._cleanupMicStream();
      onError?.('Trình duyệt này không hỗ trợ thu âm.');
      onEnd?.();
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.recordedChunks = [];
    this.mediaRecorder = new MediaRecorder(this.micStream, { mimeType });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      this.isListening = false;
      const blob = new Blob(this.recordedChunks, { type: mimeType });
      this._cleanupMicStream();
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = String(reader.result || '');
        const base64 = result.split(',')[1] || '';
        if (base64) {
          onAudioRecorded?.({ mimeType: 'audio/webm', data: base64 });
        }
        onEnd?.();
      };
      reader.readAsDataURL(blob);
    };

    this.mediaRecorder.onerror = () => {
      this.isListening = false;
      this._cleanupMicStream();
      onError?.('Lỗi khi ghi âm thanh.');
      onEnd?.();
    };

    this.mediaRecorder.start();
  }
}

class SpeechSpeaker {
  constructor() {
    this.synth = window.speechSynthesis || null;
    this.enabled = true;
    this.rate = 1.05;
    this.language = 'vi-VN';
    this.voiceURI = '';
    this.voices = [];
    this.hasLocalTts = false;
    this.currentAudio = null;

    this.queue = [];
    this.buffer = '';
    this.isSpeaking = false;
    this.streamEnded = false;
    this.pulseTimer = null;
    this.playbackSession = 0;

    this.onStartSpeaking = null;
    this.onFinishSpeaking = null;
    this.onWordPulse = null;

    if (this.synth) {
      this._loadVoices();
      if (typeof this.synth.onvoiceschanged !== 'undefined') {
        this.synth.onvoiceschanged = () => this._loadVoices();
      }
    }
  }

  _loadVoices() {
    if (!this.synth) return;
    this.voices = this.synth.getVoices() || [];
    window.dispatchEvent(new CustomEvent('tts-voices-updated', { detail: this.voices }));
  }

  getVoices() {
    return this.voices;
  }

  setServerTtsAvailable(available) {
    this.hasLocalTts = Boolean(available);
  }

  _canSpeak() {
    return Boolean(this.synth || this.hasLocalTts);
  }

  _shouldUseServerAudio() {
    if (!this.hasLocalTts) return false;
    if (!this.synth || this.voices.length === 0) return true;
    // Trên Linux/Raspberry Pi, voice mặc định là espeak qua speech-dispatcher thường lỗi Bluetooth;
    // ưu tiên phát WAV qua thẻ <audio> đi thẳng PipeWire/PulseAudio tới loa Bluetooth.
    const hasHighQualityBrowserVoice = this.voices.some((v) =>
      /natural|online|neural|google|microsoft/i.test(v.name || '')
    );
    return !this.voiceURI && !hasHighQualityBrowserVoice;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) {
      this.stop();
    }
  }

  setConfig({ rate, language, voiceURI }) {
    if (rate) this.rate = Number(rate);
    if (language) this.language = language;
    if (typeof voiceURI === 'string') this.voiceURI = voiceURI;
  }

  beginStream() {
    this.stop();
    this.streamEnded = false;
    this.buffer = '';
  }

  pushDelta(deltaText) {
    if (!this.enabled || !this._canSpeak()) return;
    this.buffer += deltaText;

    // Gộp câu quá ngắn khi dùng Server TTS để tránh ngắt quãng giữa câu trên loa Bluetooth
    const useServer = this._shouldUseServerAudio();
    const sentenceRegex = useServer ? /^([\s\S]*?[.!?\n]+)(\s+|$)/ : /^([\s\S]*?[.!?\n;]+)(\s+|$)/;
    let match;
    let accumulated = '';
    while ((match = sentenceRegex.exec(this.buffer)) !== null) {
      const sentence = match[1].trim();
      this.buffer = this.buffer.slice(match[0].length);
      if (!sentence) continue;
      if (useServer) {
        accumulated = accumulated ? `${accumulated} ${sentence}` : sentence;
        if (accumulated.length >= 45) {
          this._enqueue(accumulated);
          accumulated = '';
        }
      } else {
        this._enqueue(sentence);
      }
    }
    if (accumulated) {
      this.buffer = `${accumulated} ${this.buffer}`.trim();
    }
  }

  endStream() {
    this.streamEnded = true;
    const leftover = this.buffer.trim();
    this.buffer = '';
    if (this.enabled && this._canSpeak() && leftover) {
      this._enqueue(leftover);
    } else if (!this.isSpeaking && this.queue.length === 0) {
      this.onFinishSpeaking?.();
    }
  }

  speakText(fullText) {
    if (!this.enabled || !this._canSpeak() || !fullText) return;
    this.beginStream();
    this.pushDelta(fullText);
    this.endStream();
  }

  stop() {
    this.playbackSession += 1;
    for (const item of this.queue) {
      if (item && item.blobUrlPromise) {
        item.blobUrlPromise
          .then((u) => {
            if (u) URL.revokeObjectURL(u);
          })
          .catch(() => {});
      }
    }
    this.queue = [];
    this.buffer = '';
    this.streamEnded = true;
    this.isSpeaking = false;
    this._stopPulseTimer();
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        const src = this.currentAudio.src;
        this.currentAudio.src = '';
        if (src && src.startsWith('blob:')) URL.revokeObjectURL(src);
      } catch {
        // ignore
      }
      this.currentAudio = null;
    }
    if (this.synth) {
      try {
        this.synth.cancel();
      } catch {
        // ignore
      }
    }
  }

  _cleanForSpeech(text) {
    return text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[`*_#>~]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  hasExactVoiceFor(lang) {
    const target = (lang || this.language || 'vi-VN').toLowerCase().replace('_', '-');
    return this.voices.some((v) => {
      const vLang = (v.lang || '').toLowerCase().replace('_', '-');
      if (vLang === target) return true;
      if (target === 'en-in') {
        return /india|neerja|prabhat|heera|ravi|rishi/i.test(v.name || '');
      }
      return false;
    });
  }

  getRecommendedVoice(lang = this.language) {
    if (!this.voices.length) return null;
    const target = (lang || 'vi-VN').toLowerCase().replace('_', '-');
    const langPrefix = target.split('-')[0];

    const scoreVoice = (v) => {
      const vLang = (v.lang || '').toLowerCase().replace('_', '-');
      const name = (v.name || '').toLowerCase();
      let score = 0;

      if (vLang === target) score += 100;
      else if (vLang.startsWith(langPrefix)) score += 30;

      if (target === 'en-in' && /india|neerja|prabhat|heera|ravi|rishi/.test(name)) {
        score += 90;
      }
      if (/natural|online|neural|google/.test(name)) {
        score += 20;
      }
      if (/neerja|hoaimy/.test(name)) {
        score += 5;
      }
      return score;
    };

    const ranked = [...this.voices]
      .map((v) => ({ v, score: scoreVoice(v) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked[0]?.v || null;
  }

  _pickVoice() {
    if (!this.voices.length) return null;
    if (this.voiceURI) {
      const chosen = this.voices.find((v) => v.voiceURI === this.voiceURI);
      if (chosen) return chosen;
    }
    return this.getRecommendedVoice(this.language);
  }

  _prefetchServerAudio(text) {
    const url = `/api/tts?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(
      this.language
    )}&rate=${encodeURIComponent(String(this.rate))}`;
    return fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error('TTS HTTP ' + res.status);
        return res.blob();
      })
      .then((blob) => URL.createObjectURL(blob))
      .catch(() => null);
  }

  _enqueue(rawText) {
    const clean = this._cleanForSpeech(rawText);
    if (!clean) return;
    if (this._shouldUseServerAudio()) {
      this.queue.push({
        text: clean,
        blobUrlPromise: this._prefetchServerAudio(clean),
      });
    } else {
      this.queue.push({ text: clean });
    }
    if (!this.isSpeaking) {
      this._playNext();
    }
  }

  async _playNext() {
    if (!this.enabled || !this._canSpeak()) {
      this.queue = [];
      this.isSpeaking = false;
      return;
    }

    if (this.queue.length === 0) {
      this.isSpeaking = false;
      this._stopPulseTimer();
      if (this.streamEnded) {
        this.onFinishSpeaking?.();
      }
      return;
    }

    if (!this.isSpeaking) {
      this.isSpeaking = true;
      this.onStartSpeaking?.();
      this._startPulseTimer();
    }

    const sessionAtStart = this.playbackSession;
    const item = this.queue.shift();
    const text = item.text;

    if (this._shouldUseServerAudio()) {
      const blobUrl = item.blobUrlPromise
        ? await item.blobUrlPromise
        : await this._prefetchServerAudio(text);

      if (sessionAtStart !== this.playbackSession || !this.enabled) {
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        return;
      }
      if (!blobUrl) {
        this._playNext();
        return;
      }

      const audio = new Audio(blobUrl);
      this.currentAudio = audio;
      const finishAudio = () => {
        if (this.currentAudio === audio) this.currentAudio = null;
        URL.revokeObjectURL(blobUrl);
        if (sessionAtStart === this.playbackSession) {
          this._playNext();
        }
      };
      audio.onended = finishAudio;
      audio.onerror = finishAudio;
      audio.play().catch(finishAudio);
      return;
    }

    if (!this.synth) {
      this._playNext();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(text);
    const voice = this._pickVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = this.language;
    }
    utterance.rate = this.rate;
    utterance.pitch = 1.05;

    utterance.onboundary = () => {
      this.onWordPulse?.(1.1);
    };

    utterance.onend = () => {
      this._playNext();
    };

    utterance.onerror = () => {
      this._playNext();
    };

    try {
      this.synth.speak(utterance);
    } catch {
      this._playNext();
    }
  }

  _startPulseTimer() {
    this._stopPulseTimer();
    this.pulseTimer = setInterval(() => {
      if (this.isSpeaking) {
        this.onWordPulse?.(0.75 + Math.random() * 0.45);
      }
    }, 150);
  }

  _stopPulseTimer() {
    if (this.pulseTimer) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }
}

window.SpeechManager = SpeechManager;
window.SpeechSpeaker = SpeechSpeaker;
