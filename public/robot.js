class RobotStage {
  constructor() {
    this.wrapper = document.getElementById('robotContainer');
    this.statusPill = document.getElementById('statusPill');
    this.statusText = document.getElementById('statusText');
    this.thinkingBubbles = document.getElementById('thinkingBubbles');
    this.antennaOrb = document.getElementById('antennaOrb');
    this.earLeft = document.getElementById('earGlowLeft');
    this.earRight = document.getElementById('earGlowRight');
    this.cheekLeft = document.getElementById('cheekLeft');
    this.cheekRight = document.getElementById('cheekRight');
    this.chestWave = document.getElementById('chestWave');
    this.mouthPath = document.getElementById('mouthPath');
    this.mouthBarsGroup = document.getElementById('mouthBars');
    this.mouthBars = Array.from(document.querySelectorAll('#mouthBars .mbar'));
    this.leftEye = document.getElementById('leftEye');
    this.rightEye = document.getElementById('rightEye');
    this.happyEyes = document.getElementById('happyEyes');
    this.eyeLids = Array.from(document.querySelectorAll('.eye-lid'));
    this.eyePupils = Array.from(document.querySelectorAll('.eye-pupil'));
    this.eyeIrises = Array.from(document.querySelectorAll('.eye-iris'));
    this.canvas = document.getElementById('visualizerCanvas');
    this.ctx = this.canvas.getContext('2d');

    this.state = 'idle';
    this.speakEnergy = 0;
    this.micLevel = 0;

    this.audioCtx = null;
    this.analyser = null;
    this.micStream = null;
    this.freqData = null;

    this._setupBlinking();
    this._setupPointerTracking();
    this._startRenderLoop();
  }

  setState(nextState, statusMessage) {
    this.state = nextState;
    const states = ['state-idle', 'state-listening', 'state-thinking', 'state-speaking', 'state-error'];
    this.wrapper.classList.remove(...states);
    this.statusPill.classList.remove(...states);
    this.wrapper.classList.add(`state-${nextState}`);
    this.statusPill.classList.add(`state-${nextState}`);

    if (statusMessage) {
      this.statusText.textContent = statusMessage;
    }

    this.thinkingBubbles.classList.toggle('hidden', nextState !== 'thinking');

    const colorMap = {
      idle: '#38bdf8',
      listening: '#22d3ee',
      thinking: '#fbbf24',
      speaking: '#34d399',
      error: '#fb7185',
    };
    const accent = colorMap[nextState] || '#38bdf8';
    this.antennaOrb.setAttribute('fill', accent);
    this.earLeft.setAttribute('fill', accent);
    this.earRight.setAttribute('fill', accent);
    this.chestWave.setAttribute('stroke', accent);
    this.eyeIrises.forEach((el) => el.setAttribute('fill', accent));

    if (nextState === 'speaking') {
      this.mouthPath.setAttribute('opacity', '0');
      this.mouthBarsGroup.setAttribute('opacity', '1');
      this.cheekLeft.setAttribute('opacity', '0.55');
      this.cheekRight.setAttribute('opacity', '0.55');
      this._showHappyEyes(false);
    } else if (nextState === 'listening') {
      this.mouthPath.setAttribute('opacity', '1');
      this.mouthPath.setAttribute('d', 'M-10 2 Q0 12 10 2 Q0 -8 -10 2');
      this.mouthPath.setAttribute('stroke', '#22d3ee');
      this.mouthBarsGroup.setAttribute('opacity', '0');
      this.cheekLeft.setAttribute('opacity', '0.35');
      this.cheekRight.setAttribute('opacity', '0.35');
      this._showHappyEyes(false);
    } else if (nextState === 'thinking') {
      this.mouthPath.setAttribute('opacity', '1');
      this.mouthPath.setAttribute('d', 'M-16 2 Q-8 -5 0 2 T16 2');
      this.mouthPath.setAttribute('stroke', '#fbbf24');
      this.mouthBarsGroup.setAttribute('opacity', '0');
      this._setPupilOffset(4, -5);
      this._showHappyEyes(false);
    } else if (nextState === 'error') {
      this.mouthPath.setAttribute('opacity', '1');
      this.mouthPath.setAttribute('d', 'M-16 8 Q0 -6 16 8');
      this.mouthPath.setAttribute('stroke', '#fb7185');
      this.mouthBarsGroup.setAttribute('opacity', '0');
      this._showHappyEyes(false);
    } else {
      // idle
      this.mouthPath.setAttribute('opacity', '1');
      this.mouthPath.setAttribute('d', 'M-20 -2 Q0 13 20 -2');
      this.mouthPath.setAttribute('stroke', '#38bdf8');
      this.mouthBarsGroup.setAttribute('opacity', '0');
      this.cheekLeft.setAttribute('opacity', '0.25');
      this.cheekRight.setAttribute('opacity', '0.25');
      this._setPupilOffset(0, 0);
      this._showHappyEyes(false);
    }
  }

  flashHappy(durationMs = 1300) {
    if (this.state === 'speaking' || this.state === 'listening') return;
    this._showHappyEyes(true);
    this.cheekLeft.setAttribute('opacity', '0.65');
    this.cheekRight.setAttribute('opacity', '0.65');
    setTimeout(() => {
      if (this.state === 'idle') {
        this._showHappyEyes(false);
        this.cheekLeft.setAttribute('opacity', '0.25');
        this.cheekRight.setAttribute('opacity', '0.25');
      }
    }, durationMs);
  }

  pulseSpeak(strength = 1) {
    this.speakEnergy = Math.min(1.2, Math.max(this.speakEnergy, strength));
  }

  async attachMicStream(stream) {
    try {
      this.micStream = stream;
      if (!this.audioCtx) {
        const AudioContextCls = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContextCls();
      }
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }
      const source = this.audioCtx.createMediaStreamSource(stream);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 128;
      source.connect(this.analyser);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
    } catch {
      // Nếu trình duyệt hạn chế AudioContext vẫn dùng fallback animation
    }
  }

  detachMicStream() {
    this.analyser = null;
    this.freqData = null;
    this.micLevel = 0;
  }

  _showHappyEyes(show) {
    this.leftEye.style.opacity = show ? '0' : '1';
    this.rightEye.style.opacity = show ? '0' : '1';
    this.happyEyes.setAttribute('opacity', show ? '1' : '0');
  }

  _setPupilOffset(x, y) {
    for (const pupil of this.eyePupils) {
      pupil.setAttribute('cx', String(2 + x));
      pupil.setAttribute('cy', String(-2 + y));
    }
  }

  _setupBlinking() {
    const scheduleBlink = () => {
      const wait = 2600 + Math.random() * 3200;
      setTimeout(() => {
        if (this.state !== 'thinking') {
          this.eyeLids.forEach((lid) => lid.setAttribute('height', '44'));
          setTimeout(() => {
            this.eyeLids.forEach((lid) => lid.setAttribute('height', '0'));
          }, 130);
        }
        scheduleBlink();
      }, wait);
    };
    scheduleBlink();
  }

  _setupPointerTracking() {
    window.addEventListener('pointermove', (e) => {
      if (this.state !== 'idle' && this.state !== 'listening') return;
      const rect = this.wrapper.getBoundingClientRect();
      if (!rect.width) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = Math.max(-1, Math.min(1, (e.clientX - cx) / 360));
      const dy = Math.max(-1, Math.min(1, (e.clientY - cy) / 360));
      this._setPupilOffset(dx * 5, dy * 4);
    });
  }

  _updateSpeakingMouth(t) {
    if (this.state !== 'speaking') return;
    this.speakEnergy = Math.max(0.25, this.speakEnergy * 0.92);
    const heights = [0.45, 0.8, 1, 0.8, 0.45];
    this.mouthBars.forEach((bar, idx) => {
      const wave = 0.55 + 0.45 * Math.sin(t * 0.018 + idx * 1.3);
      const h = Math.max(6, Math.round(28 * heights[idx] * wave * Math.min(1.15, this.speakEnergy + 0.35)));
      bar.setAttribute('height', String(h));
      bar.setAttribute('y', String(-h / 2));
    });
  }

  _startRenderLoop() {
    const draw = (t) => {
      const { width, height } = this.canvas;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, width, height);

      const cx = width / 2;
      const cy = height / 2;
      const baseRadius = 148;

      // Đọc mức âm thanh micro thực tế nếu đang thu âm
      let activeLevel = 0;
      if (this.state === 'listening' && this.analyser && this.freqData) {
        this.analyser.getByteFrequencyData(this.freqData);
        let sum = 0;
        for (let i = 0; i < this.freqData.length; i++) sum += this.freqData[i];
        this.micLevel = sum / (this.freqData.length * 255);
        activeLevel = Math.min(1, this.micLevel * 2.2);
      } else if (this.state === 'speaking') {
        this._updateSpeakingMouth(t);
        activeLevel = 0.28 + 0.25 * Math.abs(Math.sin(t * 0.01));
      } else if (this.state === 'thinking') {
        activeLevel = 0.18 + 0.08 * Math.sin(t * 0.008);
      } else {
        activeLevel = 0.06 + 0.03 * Math.sin(t * 0.0025);
      }

      const colorMap = {
        idle: '56, 189, 248',
        listening: '34, 211, 238',
        thinking: '251, 191, 36',
        speaking: '52, 211, 153',
        error: '251, 113, 133',
      };
      const rgb = colorMap[this.state] || colorMap.idle;

      // Vòng radar nền
      ctx.beginPath();
      ctx.arc(cx, cy, baseRadius + activeLevel * 18, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${rgb}, ${0.22 + activeLevel * 0.4})`;
      ctx.lineWidth = 2.5;
      ctx.stroke();

      // Các tia sóng âm quanh Robot
      const bars = 48;
      for (let i = 0; i < bars; i++) {
        const angle = (i / bars) * Math.PI * 2 + (this.state === 'thinking' ? t * 0.002 : 0);
        let amp = 4;
        if (this.state === 'listening' && this.freqData) {
          const bin = this.freqData[i % this.freqData.length] || 0;
          amp = 4 + (bin / 255) * 34;
        } else if (this.state === 'speaking') {
          amp = 6 + 22 * Math.abs(Math.sin(t * 0.012 + i * 0.45)) * (0.5 + this.speakEnergy * 0.5);
        } else if (this.state === 'thinking') {
          amp = 5 + 10 * Math.abs(Math.sin(t * 0.008 + i * 0.35));
        } else {
          amp = 3 + 3 * Math.sin(t * 0.003 + i * 0.5);
        }

        const r1 = baseRadius + 8;
        const r2 = r1 + amp;
        const x1 = cx + Math.cos(angle) * r1;
        const y1 = cy + Math.sin(angle) * r1;
        const x2 = cx + Math.cos(angle) * r2;
        const y2 = cy + Math.sin(angle) * r2;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(${rgb}, ${0.35 + Math.min(0.6, amp / 36)})`;
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      requestAnimationFrame(draw);
    };

    requestAnimationFrame(draw);
  }
}

window.RobotStage = RobotStage;
