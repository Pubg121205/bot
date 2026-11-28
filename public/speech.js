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
  }

  supportsWebSpeech() {
    return Boolean(this.Recognition);
  }

  setLanguage(lang) {
    this.language = lang || 'vi-VN';
  }

  async startListening({ onStart, onInterim, onFinal, onAudioRecorded, onError, onEnd }) {
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

    if (this.Recognition) {
      this._startWebSpeech({ onInterim, onFinal, onError, onEnd });
    } else {
      this._startMediaRecorder({ onAudioRecorded, onError, onEnd });
    }
  }

  stopListening() {
    if (!this.isListening) return;
    this.isListening = false;

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

  _startWebSpeech({ onInterim, onFinal, onError, onEnd }) {
    const rec = new this.Recognition();
    this.recognition = rec;
    rec.lang = this.language;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    let deliveredFinal = false;

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
      this.isListening = false;
      this._cleanupMicStream();
      if (event.error === 'no-speech') {
        onError?.('Chưa nghe thấy giọng nói, em thử nói lại gần mic hơn nhé.');
      } else if (event.error === 'not-allowed') {
        onError?.('Micro chưa được cấp quyền trên trình duyệt.');
      } else if (event.error !== 'aborted') {
        onError?.(`Lỗi nhận diện giọng nói: ${event.error}`);
      }
      onEnd?.();
    };

    rec.onend = () => {
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

    this.queue = [];
    this.buffer = '';
    this.isSpeaking = false;
    this.streamEnded = false;
    this.pulseTimer = null;

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
    if (!this.enabled || !this.synth) return;
    this.buffer += deltaText;

    // Tách câu ngay khi gặp dấu kết thúc câu để đọc nối tiếp tốc độ cao
    const sentenceRegex = /^([\s\S]*?[.!?\n;]+)(\s+|$)/;
    let match;
    while ((match = sentenceRegex.exec(this.buffer)) !== null) {
      const sentence = match[1].trim();
      this.buffer = this.buffer.slice(match[0].length);
      if (sentence) {
        this._enqueue(sentence);
      }
    }
  }

  endStream() {
    this.streamEnded = true;
    const leftover = this.buffer.trim();
    this.buffer = '';
    if (this.enabled && this.synth && leftover) {
      this._enqueue(leftover);
    } else if (!this.isSpeaking && this.queue.length === 0) {
      this.onFinishSpeaking?.();
    }
  }

  speakText(fullText) {
    if (!this.enabled || !this.synth || !fullText) return;
    this.beginStream();
    this.pushDelta(fullText);
    this.endStream();
  }

  stop() {
    this.queue = [];
    this.buffer = '';
    this.streamEnded = true;
    this.isSpeaking = false;
    this._stopPulseTimer();
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

  _enqueue(rawText) {
    const clean = this._cleanForSpeech(rawText);
    if (!clean) return;
    this.queue.push(clean);
    if (!this.isSpeaking) {
      this._playNext();
    }
  }

  _playNext() {
    if (!this.enabled || !this.synth) {
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

    const text = this.queue.shift();
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
