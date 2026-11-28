class FaceRecognitionManager {
  constructor() {
    this.modelsLoaded = false;
    this.loadingPromise = null;
    this.stream = null;
    this.isScanning = false;
    this.isEnrolling = false;
    this.scanTimer = null;
    this.profiles = [];
    this.matcher = null;
    this.lastCandidateId = null;
    this.candidateStreak = 0;
  }

  async ensureModelsLoaded(onProgress) {
    if (this.modelsLoaded) return;
    if (this.loadingPromise) return this.loadingPromise;

    if (typeof window.faceapi === 'undefined') {
      throw new Error('Không tìm thấy thư viện face-api.js.');
    }

    const modelUrl = '/vendor/face-api/models';
    this.loadingPromise = (async () => {
      onProgress?.('Đang tải mô hình phát hiện khuôn mặt...');
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
      onProgress?.('Đang tải mô hình điểm mốc khuôn mặt...');
      await window.faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelUrl);
      onProgress?.('Đang tải mô hình nhận diện danh tính...');
      await window.faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl);
      this.modelsLoaded = true;
    })();

    try {
      await this.loadingPromise;
    } catch (err) {
      this.loadingPromise = null;
      throw err;
    }
  }

  setProfiles(profiles) {
    this.profiles = Array.isArray(profiles) ? profiles : [];
    this.rebuildMatcher();
  }

  rebuildMatcher() {
    if (!this.modelsLoaded || typeof window.faceapi === 'undefined') {
      this.matcher = null;
      return;
    }
    const labeled = [];
    for (const p of this.profiles) {
      if (!Array.isArray(p.descriptors) || p.descriptors.length === 0) continue;
      const floatDescs = p.descriptors
        .filter((d) => Array.isArray(d) && d.length === 128)
        .map((d) => new Float32Array(d));
      if (floatDescs.length > 0) {
        labeled.push(new window.faceapi.LabeledFaceDescriptors(p.id, floatDescs));
      }
    }
    this.matcher = labeled.length > 0 ? new window.faceapi.FaceMatcher(labeled, 0.5) : null;
  }

  async startCamera(videoEl) {
    if (this.stream) {
      videoEl.srcObject = this.stream;
      await videoEl.play().catch(() => {});
      return this.stream;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Trình duyệt không hỗ trợ truy cập Camera (cần chạy trên localhost hoặc HTTPS).');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
      },
      audio: false,
    });

    videoEl.srcObject = this.stream;
    await videoEl.play();
    return this.stream;
  }

  stopCamera(videoEl) {
    this.stopLoop();
    this.isEnrolling = false;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (videoEl) {
      videoEl.srcObject = null;
    }
  }

  stopLoop() {
    this.isScanning = false;
    this.isEnrolling = false;
    this.lastCandidateId = null;
    this.candidateStreak = 0;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
  }

  async detectSingle(videoEl) {
    if (!this.modelsLoaded || !videoEl || videoEl.readyState < 2) return null;
    const options = new window.faceapi.TinyFaceDetectorOptions({
      inputSize: 320,
      scoreThreshold: 0.5,
    });
    return window.faceapi
      .detectSingleFace(videoEl, options)
      .withFaceLandmarks(true)
      .withFaceDescriptor();
  }

  estimateHeadPose(landmarks) {
    const pts = landmarks?.positions;
    if (!pts || pts.length < 48) {
      return { yawRatio: 0.5, pitchRatio: 0.42, label: 'center' };
    }
    const leftEyeOuter = pts[36];
    const rightEyeOuter = pts[45];
    const noseTip = pts[30];
    const browCenter = pts[27];
    const chin = pts[8];

    const eyeSpan = Math.max(1, rightEyeOuter.x - leftEyeOuter.x);
    const yawRatio = (noseTip.x - leftEyeOuter.x) / eyeSpan;
    const faceHeight = Math.max(1, chin.y - browCenter.y);
    const pitchRatio = (noseTip.y - browCenter.y) / faceHeight;

    // Video hiển thị lật gương trên UI
    let label = 'center';
    if (yawRatio > 0.57) label = 'left';
    else if (yawRatio < 0.43) label = 'right';
    else if (pitchRatio < 0.36) label = 'up';
    else if (pitchRatio > 0.5) label = 'down';

    return { yawRatio, pitchRatio, label };
  }

  _syncCanvasAndTransform(canvasEl, videoEl) {
    const cw = canvasEl.clientWidth || videoEl.videoWidth || 420;
    const ch = canvasEl.clientHeight || videoEl.videoHeight || 315;
    if (canvasEl.width !== cw) canvasEl.width = cw;
    if (canvasEl.height !== ch) canvasEl.height = ch;

    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;
    const scale = Math.max(cw / vw, ch / vh);
    const offsetX = (cw - vw * scale) / 2;
    const offsetY = (ch - vh * scale) / 2;
    return { cw, ch, vw, vh, scale, offsetX, offsetY };
  }

  _mapMirroredPoint(pt, tf) {
    return {
      x: tf.cw - (pt.x * tf.scale + tf.offsetX),
      y: pt.y * tf.scale + tf.offsetY,
    };
  }

  drawFaceLandmarks(ctx, tf, detection, dotColor = 'rgba(56, 189, 248, 0.75)') {
    const pts = detection?.landmarks?.positions;
    if (!pts) return;
    ctx.fillStyle = dotColor;
    for (let i = 0; i < pts.length; i += 2) {
      const p = this._mapMirroredPoint(pts[i], tf);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawHudBox(canvasEl, videoEl, detection, label, color = '#38bdf8') {
    if (!canvasEl || !videoEl) return;
    const tf = this._syncCanvasAndTransform(canvasEl, videoEl);
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, tf.cw, tf.ch);

    if (!detection) return;
    this.drawFaceLandmarks(ctx, tf, detection, color);

    const box = detection.detection.box;
    const bw = box.width * tf.scale;
    const bh = box.height * tf.scale;
    const x = tf.cw - ((box.x + box.width) * tf.scale + tf.offsetX);
    const y = box.y * tf.scale + tf.offsetY;

    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    const corner = Math.min(24, bw * 0.22);

    // 4 góc khung quét kiểu HUD
    ctx.beginPath();
    ctx.moveTo(x, y + corner);
    ctx.lineTo(x, y);
    ctx.lineTo(x + corner, y);

    ctx.moveTo(x + bw - corner, y);
    ctx.lineTo(x + bw, y);
    ctx.lineTo(x + bw, y + corner);

    ctx.moveTo(x + bw, y + bh - corner);
    ctx.lineTo(x + bw, y + bh);
    ctx.lineTo(x + bw - corner, y + bh);

    ctx.moveTo(x + corner, y + bh);
    ctx.lineTo(x, y + bh);
    ctx.lineTo(x, y + bh - corner);
    ctx.stroke();

    if (label) {
      ctx.font = 'bold 14px "Be Vietnam Pro", sans-serif';
      const padX = 10;
      const textW = ctx.measureText(label).width;
      const pillW = textW + padX * 2;
      const pillY = Math.max(8, y - 30);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
      ctx.fillRect(x, pillY, pillW, 24);
      ctx.fillStyle = color;
      ctx.fillText(label, x + padX, pillY + 17);
    }
  }

  drawFaceIdRing(canvasEl, videoEl, detection, { progress = 0, stepProgress = 0, hasFace = false }) {
    if (!canvasEl || !videoEl) return;
    const tf = this._syncCanvasAndTransform(canvasEl, videoEl);
    const ctx = canvasEl.getContext('2d');
    ctx.clearRect(0, 0, tf.cw, tf.ch);

    const cx = tf.cw / 2;
    const cy = tf.ch / 2 - 8;
    const radius = Math.min(tf.cw, tf.ch) * 0.34;

    if (detection) {
      this.drawFaceLandmarks(ctx, tf, detection, hasFace ? 'rgba(52, 211, 153, 0.85)' : 'rgba(56, 189, 248, 0.8)');
    }

    // Vòng dẫn hướng mảnh ở tâm
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = hasFace ? 'rgba(52, 211, 153, 0.45)' : 'rgba(56, 189, 248, 0.45)';
    ctx.stroke();

    // Vẽ 40 vạch tia Face ID quanh vòng tròn
    const totalTicks = 40;
    const filledTicks = Math.round(progress * totalTicks);
    const activeExtra = Math.round(stepProgress * (totalTicks / 4));

    for (let i = 0; i < totalTicks; i++) {
      const angle = (i / totalTicks) * Math.PI * 2 - Math.PI / 2;
      const isDone = i < filledTicks;
      const isActive = i >= filledTicks && i < filledTicks + activeExtra;

      const rInner = radius + 5;
      const rOuter = radius + (isDone ? 18 : isActive ? 15 : 11);

      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * rInner, cy + Math.sin(angle) * rInner);
      ctx.lineTo(cx + Math.cos(angle) * rOuter, cy + Math.sin(angle) * rOuter);
      ctx.lineWidth = isDone ? 4.2 : 3;
      ctx.lineCap = 'round';
      ctx.strokeStyle = isDone
        ? '#34d399'
        : isActive
          ? '#38bdf8'
          : hasFace
            ? 'rgba(148, 163, 184, 0.5)'
            : 'rgba(248, 113, 113, 0.45)';
      ctx.stroke();
    }
  }

  startLoop({ videoEl, canvasEl, mode, onStatus, onMatch }) {
    this.stopLoop();
    this.isScanning = true;
    this.rebuildMatcher();

    const step = async () => {
      if (!this.isScanning) return;
      try {
        const detection = await this.detectSingle(videoEl);
        if (!this.isScanning) return;

        if (!detection) {
          this.lastCandidateId = null;
          this.candidateStreak = 0;
          if (mode === 'register') {
            this.drawFaceIdRing(canvasEl, videoEl, null, { progress: 0, stepProgress: 0, hasFace: false });
          } else {
            this.drawHudBox(canvasEl, videoEl, null);
          }
          onStatus?.(
            false,
            mode === 'register'
              ? 'Đưa khuôn mặt vào giữa vòng tròn để chuẩn bị quét Face ID.'
              : 'Đang tìm khuôn mặt trước camera...'
          );
        } else if (mode === 'register') {
          this.drawFaceIdRing(canvasEl, videoEl, detection, { progress: 0, stepProgress: 0.15, hasFace: true });
          onStatus?.(true, '✓ Đã thấy khuôn mặt — nhập tên rồi bấm "Bắt đầu quét Face ID"!');
        } else if (!this.matcher) {
          this.drawHudBox(canvasEl, videoEl, detection, 'Chưa có dữ liệu khuôn mặt', '#fbbf24');
          onStatus?.(true, 'Chưa có khuôn mặt nào được lưu. Hãy chuyển sang tab "Thêm khuôn mặt"!');
        } else {
          const match = this.matcher.findBestMatch(detection.descriptor);
          if (match.label === 'unknown') {
            this.lastCandidateId = null;
            this.candidateStreak = 0;
            this.drawHudBox(canvasEl, videoEl, detection, 'Người mới (chưa lưu)', '#fbbf24');
            onStatus?.(true, 'Chưa nhận ra khuôn mặt này — bạn có thể thêm mới ở tab bên cạnh.');
          } else {
            const profile = this.profiles.find((p) => p.id === match.label);
            const confidence = Math.max(0, Math.min(99, Math.round((1 - match.distance) * 100)));
            const label = profile ? `✓ ${profile.name} (${confidence}%)` : match.label;
            this.drawHudBox(canvasEl, videoEl, detection, label, '#34d399');

            if (this.lastCandidateId === match.label) {
              this.candidateStreak += 1;
            } else {
              this.lastCandidateId = match.label;
              this.candidateStreak = 1;
            }

            onStatus?.(true, `Đang xác nhận: ${profile?.name || ''} (${confidence}%)...`);
            if (profile && (this.candidateStreak >= 2 || match.distance < 0.4)) {
              this.stopLoop();
              onMatch?.(profile, confidence);
              return;
            }
          }
        }
      } catch {
        // bỏ qua lỗi frame tạm thời
      }

      if (this.isScanning) {
        this.scanTimer = setTimeout(step, 260);
      }
    };

    step();
  }

  captureAvatarThumbnail(videoEl, box) {
    const thumb = document.createElement('canvas');
    thumb.width = 180;
    thumb.height = 180;
    const ctx = thumb.getContext('2d');

    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;

    let sx = 0;
    let sy = 0;
    let sSize = Math.min(vw, vh);

    if (box) {
      const pad = Math.max(box.width, box.height) * 0.35;
      sSize = Math.min(Math.min(vw, vh), Math.max(box.width, box.height) + pad * 2);
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      sx = Math.max(0, Math.min(vw - sSize, cx - sSize / 2));
      sy = Math.max(0, Math.min(vh - sSize, cy - sSize / 2));
    }

    // Lật gương thumbnail cho khớp với góc nhìn tự nhiên
    ctx.translate(180, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, sx, sy, sSize, sSize, 0, 0, 180, 180);
    return thumb.toDataURL('image/jpeg', 0.85);
  }

  /**
   * Quét khuôn mặt nhiều góc kiểu iPhone Face ID:
   * 1. Nhìn thẳng -> 2. Xoay nhẹ trái -> 3. Xoay nhẹ phải -> 4. Ngẩng nhẹ / cười
   */
  async runFaceIdEnrollment({ videoEl, canvasEl, onStepUpdate }) {
    this.stopLoop();
    this.isEnrolling = true;

    const steps = [
      {
        key: 'center',
        prompt: 'Bước 1/4: 👀 Nhìn thẳng vào giữa vòng tròn',
        minHoldMs: 1400,
        maxHoldMs: 2200,
        matchPose: (pose) => pose.label === 'center',
      },
      {
        key: 'left',
        prompt: 'Bước 2/4: ⬅️ Xoay nhẹ khuôn mặt sang trái',
        minHoldMs: 1500,
        maxHoldMs: 2500,
        matchPose: (pose) => pose.label === 'left' || pose.yawRatio > 0.54,
      },
      {
        key: 'right',
        prompt: 'Bước 3/4: ➡️ Xoay nhẹ khuôn mặt sang phải',
        minHoldMs: 1500,
        maxHoldMs: 2500,
        matchPose: (pose) => pose.label === 'right' || pose.yawRatio < 0.46,
      },
      {
        key: 'up',
        prompt: 'Bước 4/4: ⬆️ Ngẩng nhẹ cằm lên hoặc cười tươi nào!',
        minHoldMs: 1500,
        maxHoldMs: 2300,
        matchPose: (pose) => pose.label === 'up' || pose.pitchRatio < 0.39,
      },
    ];

    const descriptors = [];
    let frontBox = null;
    let avatarDataUrl = '';

    try {
      for (let idx = 0; idx < steps.length; idx++) {
        if (!this.isEnrolling) throw new Error('Đã hủy quá trình quét Face ID.');
        const step = steps[idx];
        let stepVisibleMs = 0;
        let poseMatchedMs = 0;
        let lastTick = performance.now();
        let bestDetection = null;

        while (this.isEnrolling) {
          const det = await this.detectSingle(videoEl);
          const now = performance.now();
          const dt = Math.min(400, now - lastTick);
          lastTick = now;

          const baseProgress = idx / steps.length;

          if (!det || !det.descriptor) {
            this.drawFaceIdRing(canvasEl, videoEl, null, {
              progress: baseProgress,
              stepProgress: 0,
              hasFace: false,
            });
            onStepUpdate?.({
              stepIndex: idx,
              totalSteps: steps.length,
              percent: Math.round(baseProgress * 100),
              text: `${step.prompt} (Chưa thấy mặt rõ)`,
            });
          } else {
            bestDetection = det;
            if (idx === 0 && !frontBox) {
              frontBox = det.detection.box;
            }
            stepVisibleMs += dt;
            const pose = this.estimateHeadPose(det.landmarks);
            if (step.matchPose(pose)) {
              poseMatchedMs += dt;
            }

            const ratio = Math.min(1, Math.max(stepVisibleMs / step.maxHoldMs, poseMatchedMs / step.minHoldMs));
            this.drawFaceIdRing(canvasEl, videoEl, det, {
              progress: baseProgress,
              stepProgress: ratio,
              hasFace: true,
            });

            const totalPercent = Math.min(99, Math.round((baseProgress + ratio / steps.length) * 100));
            const poseHint = step.matchPose(pose) ? '✓ Đúng góc rồi, giữ yên...' : step.prompt;
            onStepUpdate?.({
              stepIndex: idx,
              totalSteps: steps.length,
              percent: totalPercent,
              text: poseHint,
            });

            const readyByPose = poseMatchedMs >= step.minHoldMs && stepVisibleMs >= 1100;
            const readyByTimeout = stepVisibleMs >= step.maxHoldMs;
            if (readyByPose || readyByTimeout) {
              descriptors.push(Array.from(det.descriptor));
              if (idx === 0) {
                avatarDataUrl = this.captureAvatarThumbnail(videoEl, det.detection.box);
              }
              break;
            }
          }

          await new Promise((r) => setTimeout(r, 140));
        }

        if (bestDetection && !avatarDataUrl) {
          avatarDataUrl = this.captureAvatarThumbnail(videoEl, bestDetection.detection.box);
        }
      }

      this.drawFaceIdRing(canvasEl, videoEl, null, {
        progress: 1,
        stepProgress: 0,
        hasFace: true,
      });

      if (descriptors.length === 0) {
        throw new Error('Không quét được khuôn mặt rõ nét. Vui lòng thử lại.');
      }

      onStepUpdate?.({
        stepIndex: steps.length,
        totalSteps: steps.length,
        percent: 100,
        text: '💾 Đang hoàn tất lưu hồ sơ AI cá nhân...',
      });

      return { descriptors, avatarDataUrl };
    } finally {
      this.isEnrolling = false;
    }
  }
}

window.FaceRecognitionManager = FaceRecognitionManager;
