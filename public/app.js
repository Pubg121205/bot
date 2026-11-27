(() => {
  const STORAGE_SETTINGS_KEY = 'roboai_settings_v1';
  const STORAGE_HISTORY_KEY = 'roboai_history_v1';

  const robot = new window.RobotStage();
  const speech = new window.SpeechManager();
  const speaker = new window.SpeechSpeaker();

  // DOM Elements
  const appTitleEl = document.getElementById('appTitle');
  const personaSelect = document.getElementById('personaSelect');
  const gradeSelect = document.getElementById('gradeSelect');
  const topbarLangSelect = document.getElementById('topbarLangSelect');
  const ttsToggleBtn = document.getElementById('ttsToggleBtn');
  const handsFreeBtn = document.getElementById('handsFreeBtn');
  const fullscreenBtn = document.getElementById('fullscreenBtn');
  const settingsBtn = document.getElementById('settingsBtn');

  const latencyBadge = document.getElementById('latencyBadge');
  const latencyValue = document.getElementById('latencyValue');
  const captionTag = document.getElementById('captionTag');
  const liveCaption = document.getElementById('liveCaption');

  const micBtn = document.getElementById('micBtn');
  const micBtnLabel = document.getElementById('micBtnLabel');
  const stopSpeakBtn = document.getElementById('stopSpeakBtn');
  const textAskForm = document.getElementById('textAskForm');
  const textInput = document.getElementById('textInput');
  const chipBtns = Array.from(document.querySelectorAll('.chip-btn'));

  const historyList = document.getElementById('historyList');
  const emptyHistory = document.getElementById('emptyHistory');
  const historyCount = document.getElementById('historyCount');
  const exportBtn = document.getElementById('exportBtn');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  // Settings Modal
  const settingsModal = document.getElementById('settingsModal');
  const settingsForm = document.getElementById('settingsForm');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const cancelSettingsBtn = document.getElementById('cancelSettingsBtn');
  const botNameInput = document.getElementById('botNameInput');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const baseUrlInput = document.getElementById('baseUrlInput');
  const serverKeyStatus = document.getElementById('serverKeyStatus');
  const modelInput = document.getElementById('modelInput');
  const languageSelect = document.getElementById('languageSelect');
  const voiceSelect = document.getElementById('voiceSelect');
  const testVoiceBtn = document.getElementById('testVoiceBtn');
  const voiceStatusNote = document.getElementById('voiceStatusNote');
  const speechRateRange = document.getElementById('speechRateRange');
  const speechRateVal = document.getElementById('speechRateVal');

  let serverHasKey = false;
  let isBusy = false;
  let activeAbortController = null;

  let settings = loadSettings();
  let history = loadHistory();

  function loadSettings() {
    const defaults = {
      botName: 'RoboAI Trợ Giảng',
      apiKey: '',
      baseUrl: '',
      model: '',
      language: 'vi-VN',
      voiceURI: '',
      speechRate: 1.05,
      ttsEnabled: true,
      handsFree: false,
      persona: 'general',
      gradeLevel: 'middle',
    };
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || '{}');
      return { ...defaults, ...saved };
    } catch {
      return defaults;
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify(settings));
  }

  function loadHistory() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_HISTORY_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(history.slice(-60)));
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdownLite(rawText) {
    const escaped = escapeHtml(rawText);
    const lines = escaped.split(/\r?\n/);
    let html = '';
    let inList = false;

    const formatInline = (line) =>
      line
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*•]\s+/.test(trimmed)) {
        if (!inList) {
          html += '<ul>';
          inList = true;
        }
        html += `<li>${formatInline(trimmed.replace(/^[-*•]\s+/, ''))}</li>`;
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (trimmed) {
          html += `<p>${formatInline(trimmed)}</p>`;
        }
      }
    }
    if (inList) html += '</ul>';
    return html || `<p>${escaped}</p>`;
  }

  function formatTime(ts) {
    const d = new Date(ts || Date.now());
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  }

  function setCaption(tagText, tagClass, htmlContent) {
    captionTag.textContent = tagText;
    captionTag.className = `caption-tag ${tagClass || ''}`.trim();
    liveCaption.innerHTML = htmlContent;
  }

  const SUGGESTIONS_VI = [
    { label: '🌤️ Tại sao bầu trời màu xanh?', q: 'Tại sao bầu trời lại có màu xanh?' },
    { label: '🍎 Định luật hấp dẫn', q: 'Giải thích định luật vạn vật hấp dẫn thật dễ hiểu!' },
    { label: '🧩 Đố vui khoa học', q: 'Cho em một câu đố vui khoa học kèm đáp án nhé!' },
    { label: '🌿 Vì sao lá cây màu xanh?', q: 'Vì sao lá cây có màu xanh lục?' },
  ];

  const SUGGESTIONS_EN = [
    { label: '🌤️ Why is the sky blue?', q: 'Why is the sky blue? Explain simply for students.' },
    { label: '🍎 Gravity explained', q: 'Explain gravity in a fun and simple way!' },
    { label: '🧩 Science riddle', q: 'Give me a fun science riddle and wait for my guess or tell me the answer!' },
    { label: '🗣️ Practice greeting', q: 'Hello! Can you help me practice speaking English today?' },
  ];

  function updateSuggestionChips() {
    const isEn = (settings.language || '').toLowerCase().startsWith('en');
    const list = isEn ? SUGGESTIONS_EN : SUGGESTIONS_VI;
    chipBtns.forEach((btn, idx) => {
      const item = list[idx];
      if (!item) return;
      btn.textContent = item.label;
      btn.dataset.question = item.q;
    });
    textInput.placeholder = isEn
      ? 'Or type your question in English here...'
      : 'Hoặc gõ câu hỏi nhanh tại đây...';
  }

  function syncUIWithSettings() {
    appTitleEl.textContent = settings.botName || 'RoboAI Trợ Giảng';
    personaSelect.value = settings.persona;
    gradeSelect.value = settings.gradeLevel;
    if (topbarLangSelect) {
      topbarLangSelect.value = settings.language || 'vi-VN';
    }

    speaker.setEnabled(settings.ttsEnabled);
    speaker.setConfig({
      rate: settings.speechRate,
      language: settings.language,
      voiceURI: settings.voiceURI,
    });
    speech.setLanguage(settings.language);
    updateSuggestionChips();

    ttsToggleBtn.classList.toggle('active', settings.ttsEnabled);
    ttsToggleBtn.innerHTML = `<span>${settings.ttsEnabled ? '🔊' : '🔇'}</span><span class="btn-label">${
      settings.ttsEnabled ? 'Loa: Bật' : 'Loa: Tắt'
    }</span>`;

    handsFreeBtn.classList.toggle('active', settings.handsFree);
    handsFreeBtn.innerHTML = `<span>🔄</span><span class="btn-label">${
      settings.handsFree ? 'Liên tục: Bật' : 'Liên tục'
    }</span>`;
  }

  function updateVoiceStatusNote(targetLang) {
    if (!voiceStatusNote) return;
    const voices = speaker.getVoices();
    const recVoice = speaker.getRecommendedVoice(targetLang);
    if (!voices.length) {
      voiceStatusNote.textContent = 'Trình duyệt chưa nạp danh sách giọng đọc.';
      return;
    }
    if (targetLang === 'en-IN') {
      if (speaker.hasExactVoiceFor('en-IN')) {
        voiceStatusNote.textContent = `✓ Sẵn sàng giọng Ấn Độ: ${recVoice ? recVoice.name : 'en-IN'}`;
      } else {
        voiceStatusNote.textContent =
          '⚠ Trình duyệt này chưa có giọng en-IN (Ấn Độ). Hãy mở bằng Microsoft Edge (có sẵn Neerja/Prabhat Indian English) hoặc cài gói giọng English (India) trong Windows Settings.';
      }
    } else {
      voiceStatusNote.textContent = recVoice
        ? `Tự động ưu tiên: ${recVoice.name} (${recVoice.lang})`
        : 'Đang dùng giọng mặc định của hệ thống.';
    }
  }

  function populateVoicesDropdown(targetLang = settings.language) {
    const langStr = typeof targetLang === 'string' && targetLang ? targetLang : settings.language;
    const voices = speaker.getVoices();
    const current = settings.voiceURI;
    const activePrefix = (langStr || 'vi-VN').split('-')[0].toLowerCase();
    const activeExact = (langStr || 'vi-VN').toLowerCase();

    voiceSelect.innerHTML = '<option value="">Tự động chọn giọng phù hợp</option>';
    const sorted = [...voices].sort((a, b) => {
      const aExact = a.lang.toLowerCase() === activeExact ? 0 : 1;
      const bExact = b.lang.toLowerCase() === activeExact ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      const aPref = a.lang.toLowerCase().startsWith(activePrefix) ? 0 : 1;
      const bPref = b.lang.toLowerCase().startsWith(activePrefix) ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
      return a.name.localeCompare(b.name);
    });

    for (const v of sorted) {
      const opt = document.createElement('option');
      opt.value = v.voiceURI;
      opt.textContent = `${v.name} (${v.lang})`;
      if (v.voiceURI === current) opt.selected = true;
      voiceSelect.appendChild(opt);
    }
    updateVoiceStatusNote(langStr);
  }

  function createHistoryBubbleEl(item) {
    const wrapper = document.createElement('div');
    wrapper.className = `chat-item ${item.role}`;
    wrapper.dataset.id = item.id;

    const who = item.role === 'user' ? '🎒 Học sinh' : `🤖 ${settings.botName || 'RoboAI'}`;
    const metaHtml = `
      <div class="chat-meta">
        <span>${escapeHtml(who)}</span>
        <span>•</span>
        <span>${formatTime(item.timestamp)}</span>
        ${item.latencyMs ? `<span class="latency-tag">⚡ ${item.latencyMs}ms</span>` : ''}
      </div>
    `;

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.innerHTML = item.role === 'user' ? `<p>${escapeHtml(item.text)}</p>` : renderMarkdownLite(item.text);

    wrapper.innerHTML = metaHtml;
    wrapper.appendChild(bubble);

    if (item.role === 'model' && item.text) {
      const tools = document.createElement('div');
      tools.className = 'chat-item-tools';

      const replayBtn = document.createElement('button');
      replayBtn.type = 'button';
      replayBtn.className = 'mini-btn';
      replayBtn.textContent = '🔊 Đọc lại';
      replayBtn.addEventListener('click', () => {
        speaker.setEnabled(true);
        settings.ttsEnabled = true;
        syncUIWithSettings();
        saveSettings();
        speaker.speakText(item.text);
      });

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'mini-btn';
      copyBtn.textContent = '📋 Sao chép';
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(item.text);
          copyBtn.textContent = '✓ Đã chép';
          setTimeout(() => (copyBtn.textContent = '📋 Sao chép'), 1400);
        } catch {
          // ignore
        }
      });

      tools.appendChild(replayBtn);
      tools.appendChild(copyBtn);
      wrapper.appendChild(tools);
    }

    return wrapper;
  }

  function renderHistory() {
    const questionCount = history.filter((m) => m.role === 'user').length;
    historyCount.textContent = String(questionCount);

    historyList.querySelectorAll('.chat-item').forEach((el) => el.remove());
    if (history.length === 0) {
      emptyHistory.classList.remove('hidden');
      return;
    }

    emptyHistory.classList.add('hidden');
    for (const item of history) {
      historyList.appendChild(createHistoryBubbleEl(item));
    }
    historyList.scrollTop = historyList.scrollHeight;
  }

  function setMicButtonUI(recording) {
    micBtn.classList.toggle('recording', recording);
    micBtnLabel.textContent = recording ? 'Đang nghe... Nhấn để xong' : 'Nhấn để Hỏi';
  }

  // Speaker callbacks -> sync Robot state
  speaker.onStartSpeaking = () => {
    robot.setState('speaking', `${settings.botName || 'RoboAI'} đang trả lời...`);
    stopSpeakBtn.classList.remove('hidden');
  };

  speaker.onWordPulse = (strength) => {
    robot.pulseSpeak(strength);
  };

  speaker.onFinishSpeaking = () => {
    stopSpeakBtn.classList.add('hidden');
    if (!isBusy && !speech.isListening) {
      robot.setState('idle', 'Sẵn sàng trò chuyện cùng các em!');
      robot.flashHappy(1200);
      if (settings.handsFree) {
        setTimeout(() => {
          if (!isBusy && !speech.isListening && settings.handsFree) {
            toggleMic();
          }
        }, 650);
      }
    }
  };

  async function askGemini({ promptText = '', audioData = null }) {
    const trimmed = promptText.trim();
    if (!trimmed && !audioData) return;

    if (!serverHasKey && !settings.apiKey.trim()) {
      robot.setState('error', 'Cần nhập Gemini API Key để bắt đầu!');
      setCaption('Thông báo', '', 'Chưa có Gemini API Key. Hãy mở phần <strong>Cài đặt (⚙️)</strong> để nhập key nhé.');
      openSettingsModal();
      return;
    }

    if (activeAbortController) {
      activeAbortController.abort();
    }
    speaker.stop();
    isBusy = true;
    activeAbortController = new AbortController();

    const displayQuestion = trimmed || '🎙️ (Câu hỏi bằng giọng nói)';
    const userMsg = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: displayQuestion,
      timestamp: Date.now(),
    };
    history.push(userMsg);
    saveHistory();
    renderHistory();

    robot.setState('thinking', 'Đang suy nghĩ siêu tốc...');
    setCaption('Học sinh', 'student', escapeHtml(displayQuestion));
    latencyBadge.classList.add('hidden');

    // Placeholder cho câu trả lời AI đang stream
    const aiMsg = {
      id: `m_${Date.now()}`,
      role: 'model',
      text: '',
      timestamp: Date.now(),
      latencyMs: null,
    };
    history.push(aiMsg);
    renderHistory();
    const aiItemEl = historyList.querySelector(`[data-id="${aiMsg.id}"]`);
    const aiBubbleEl = aiItemEl?.querySelector('.chat-bubble');

    if (settings.ttsEnabled) {
      speaker.beginStream();
    }

    let firstTokenShown = false;

    try {
      const payloadMessages = history
        .slice(0, -1) // bỏ placeholder
        .filter((m) => !(audioData && m.id === userMsg.id))
        .slice(-10)
        .map((m) => ({ role: m.role, text: m.text }));

      const response = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: activeAbortController.signal,
        body: JSON.stringify({
          messages: payloadMessages,
          audioData,
          persona: settings.persona,
          gradeLevel: settings.gradeLevel,
          botName: settings.botName,
          language: settings.language,
          model: settings.model,
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
        }),
      });

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}));
        throw new Error(errJson.error || `Lỗi máy chủ (${response.status})`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let sseBuffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() || '';

        for (const evt of events) {
          const line = evt.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;

          const data = JSON.parse(line.slice(5).trim());
          if (data.type === 'error') {
            throw new Error(data.message || 'Lỗi từ Gemini API');
          }

          if (data.type === 'delta' && data.text) {
            if (!firstTokenShown) {
              firstTokenShown = true;
              aiMsg.latencyMs = data.firstTokenMs;
              latencyValue.textContent = String(data.firstTokenMs);
              latencyBadge.classList.remove('hidden');
              if (!settings.ttsEnabled) {
                robot.setState('speaking', `${settings.botName || 'RoboAI'} đang trả lời...`);
              }
            }

            aiMsg.text += data.text;
            if (aiBubbleEl) {
              aiBubbleEl.innerHTML = renderMarkdownLite(aiMsg.text);
              historyList.scrollTop = historyList.scrollHeight;
            }
            setCaption(settings.botName || 'RoboAI', 'ai', renderMarkdownLite(aiMsg.text));
            if (settings.ttsEnabled) {
              speaker.pushDelta(data.text);
            }
          }

          if (data.type === 'done') {
            aiMsg.latencyMs = aiMsg.latencyMs || data.firstTokenMs;
          }
        }
      }

      saveHistory();
      renderHistory();

      if (settings.ttsEnabled) {
        speaker.endStream();
      } else {
        setTimeout(() => {
          if (!isBusy) {
            robot.setState('idle', 'Sẵn sàng trò chuyện cùng các em!');
            robot.flashHappy(1200);
          }
        }, 1200);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      speaker.stop();
      history = history.filter((m) => m.id !== aiMsg.id);
      saveHistory();
      renderHistory();
      robot.setState('error', 'Ôi! Có chút trục trặc kỹ thuật.');
      setCaption('Lỗi', '', escapeHtml(err.message || 'Không thể kết nối tới Gemini.'));
    } finally {
      isBusy = false;
      activeAbortController = null;
    }
  }

  async function toggleMic() {
    if (speech.isListening) {
      speech.stopListening();
      setMicButtonUI(false);
      robot.detachMicStream();
      return;
    }

    if (isBusy && activeAbortController) {
      activeAbortController.abort();
      isBusy = false;
    }
    speaker.stop();
    stopSpeakBtn.classList.add('hidden');

    await speech.startListening({
      onStart: (stream) => {
        setMicButtonUI(true);
        robot.attachMicStream(stream);
        robot.setState('listening', 'Đang lắng nghe em nói...');
        setCaption(
          'Đang nghe',
          'student',
          '<span class="interim">Hãy nói câu hỏi của em vào micro...</span>'
        );
      },
      onInterim: (finalText, interimText) => {
        const html = `${escapeHtml(finalText)} <span class="interim">${escapeHtml(interimText)}</span>`.trim();
        setCaption('Học sinh', 'student', html || '<span class="interim">Đang nghe...</span>');
      },
      onFinal: (fullText) => {
        askGemini({ promptText: fullText });
      },
      onAudioRecorded: (audioData) => {
        askGemini({ audioData });
      },
      onError: (msg) => {
        robot.setState('error', msg);
        setCaption('Micro', '', escapeHtml(msg));
      },
      onEnd: () => {
        setMicButtonUI(false);
        robot.detachMicStream();
        if (!isBusy && !speaker.isSpeaking && robot.state === 'listening') {
          robot.setState('idle', 'Sẵn sàng trò chuyện cùng các em!');
        }
      },
    });
  }

  function openSettingsModal() {
    botNameInput.value = settings.botName;
    apiKeyInput.value = settings.apiKey;
    baseUrlInput.value = settings.baseUrl || '';
    modelInput.value = settings.model || '';
    languageSelect.value = settings.language;
    speechRateRange.value = String(settings.speechRate);
    speechRateVal.textContent = `${settings.speechRate}x`;
    populateVoicesDropdown();
    settingsModal.classList.remove('hidden');
  }

  function closeSettingsModal() {
    settingsModal.classList.add('hidden');
  }

  // Event Listeners
  micBtn.addEventListener('click', toggleMic);

  stopSpeakBtn.addEventListener('click', () => {
    speaker.stop();
    stopSpeakBtn.classList.add('hidden');
    robot.setState('idle', 'Sẵn sàng trò chuyện cùng các em!');
  });

  textAskForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = textInput.value.trim();
    if (!val) return;
    textInput.value = '';
    askGemini({ promptText: val });
  });

  chipBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = btn.dataset.question;
      if (q) askGemini({ promptText: q });
    });
  });

  personaSelect.addEventListener('change', () => {
    settings.persona = personaSelect.value;
    saveSettings();
  });

  gradeSelect.addEventListener('change', () => {
    settings.gradeLevel = gradeSelect.value;
    saveSettings();
  });

  topbarLangSelect?.addEventListener('change', () => {
    settings.language = topbarLangSelect.value;
    // Khi đổi ngôn ngữ nhanh, reset voiceURI thủ công để tự chọn giọng chuẩn theo ngôn ngữ mới
    settings.voiceURI = '';
    saveSettings();
    syncUIWithSettings();
    populateVoicesDropdown(settings.language);
  });

  languageSelect.addEventListener('change', () => {
    populateVoicesDropdown(languageSelect.value);
  });

  testVoiceBtn?.addEventListener('click', () => {
    const lang = languageSelect.value || settings.language;
    const tempRate = Number(speechRateRange.value) || settings.speechRate;
    speaker.setEnabled(true);
    speaker.setConfig({
      rate: tempRate,
      language: lang,
      voiceURI: voiceSelect.value,
    });
    const sample =
      lang === 'en-IN'
        ? 'Hello students! I am your AI teacher speaking in Indian English. Let us learn together!'
        : lang === 'en-US'
          ? 'Hello students! I am your AI assistant. Ask me anything you want!'
          : 'Xin chào các em! Thầy trợ lý Robot rất vui được học cùng các em hôm nay.';
    speaker.speakText(sample);
  });

  ttsToggleBtn.addEventListener('click', () => {
    settings.ttsEnabled = !settings.ttsEnabled;
    saveSettings();
    syncUIWithSettings();
  });

  handsFreeBtn.addEventListener('click', () => {
    settings.handsFree = !settings.handsFree;
    saveSettings();
    syncUIWithSettings();
  });

  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  });

  settingsBtn.addEventListener('click', openSettingsModal);
  closeSettingsBtn.addEventListener('click', closeSettingsModal);
  cancelSettingsBtn.addEventListener('click', closeSettingsModal);

  speechRateRange.addEventListener('input', () => {
    speechRateVal.textContent = `${speechRateRange.value}x`;
  });

  settingsForm.addEventListener('submit', (e) => {
    e.preventDefault();
    settings.botName = botNameInput.value.trim() || 'RoboAI Trợ Giảng';
    settings.apiKey = apiKeyInput.value.trim();
    settings.baseUrl = baseUrlInput.value.trim();
    settings.model = modelInput.value.trim();
    settings.language = languageSelect.value;
    settings.voiceURI = voiceSelect.value;
    settings.speechRate = Number(speechRateRange.value) || 1.05;
    saveSettings();
    syncUIWithSettings();
    renderHistory();
    closeSettingsModal();
    robot.flashHappy(1000);
  });

  clearHistoryBtn.addEventListener('click', () => {
    if (history.length === 0) return;
    history = [];
    saveHistory();
    renderHistory();
    latencyBadge.classList.add('hidden');
    setCaption('Gợi ý', '', 'Đã làm mới lịch sử. Các em đặt câu hỏi tiếp theo nhé!');
  });

  exportBtn.addEventListener('click', () => {
    if (history.length === 0) return;
    const lines = [`# Lịch sử hỏi đáp - ${settings.botName}\n`];
    for (const item of history) {
      const label = item.role === 'user' ? 'Học sinh' : settings.botName;
      lines.push(`### ${label} (${formatTime(item.timestamp)})`);
      lines.push(`${item.text}\n`);
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lich-su-hoi-dap-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Phím tắt Space để bật/tắt Mic (khi không gõ text)
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!settingsModal.classList.contains('hidden')) {
      if (e.key === 'Escape') closeSettingsModal();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      toggleMic();
    } else if (e.key === 'Escape') {
      speaker.stop();
      if (speech.isListening) toggleMic();
    }
  });

  window.addEventListener('tts-voices-updated', () => {
    populateVoicesDropdown(
      !settingsModal.classList.contains('hidden') ? languageSelect.value : settings.language
    );
  });

  async function init() {
    syncUIWithSettings();
    renderHistory();
    populateVoicesDropdown();

    try {
      const res = await fetch('/api/config');
      const cfg = await res.json();
      serverHasKey = Boolean(cfg.hasServerKey);
      const savedRaw = JSON.parse(localStorage.getItem(STORAGE_SETTINGS_KEY) || '{}');
      // Nếu trình duyệt lưu model mặc định cũ trước khi cấu hình router, tự đồng bộ theo .env
      if (cfg.defaultBaseUrl && !savedRaw.baseUrl) {
        settings.baseUrl = cfg.defaultBaseUrl;
        settings.model = cfg.defaultModel || settings.model;
        if (serverHasKey && savedRaw.apiKey) {
          settings.apiKey = '';
        }
        saveSettings();
        syncUIWithSettings();
      } else if (cfg.defaultModel && !settings.model) {
        settings.model = cfg.defaultModel;
        syncUIWithSettings();
      }
      serverKeyStatus.textContent = serverHasKey ? '✓ Đã cấu hình ở Server (.env)' : 'Chưa có ở Server';
      serverKeyStatus.className = `key-status ${serverHasKey ? 'ok' : 'missing'}`;

      if (!serverHasKey && !settings.apiKey) {
        setCaption(
          'Thiết lập',
          '',
          'Chào mừng! Hãy nhấn <strong>Cài đặt (⚙️)</strong> để nhập Gemini API Key hoặc cấu hình file <code>.env</code>.'
        );
      }
    } catch {
      serverKeyStatus.textContent = 'Không kiểm tra được server';
      serverKeyStatus.className = 'key-status missing';
    }
  }

  init();
})();
