// Kamkae Studio - Frontend Controller
document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const inputTitle = document.getElementById('input-title');
  const inputScript = document.getElementById('input-script');
  const sentenceCountBadge = document.getElementById('sentence-count-badge');
  const sentencePreviewList = document.getElementById('sentence-preview-list');
  const styleCards = document.querySelectorAll('.style-card');
  const aspectBtns = document.querySelectorAll('.aspect-btn');
  const selectVoice = document.getElementById('select-voice');
  const selectMode = document.getElementById('select-mode');
  const btnRun = document.getElementById('btn-run-automation');
  const btnCancel = document.getElementById('btn-cancel-execution');

  // Tabs
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  // Monitor Stepper & Logs
  const stepperStatusText = document.getElementById('stepper-status-text');
  const stepperPercentage = document.getElementById('stepper-percentage');
  const progressBarFill = document.getElementById('progress-bar-fill');
  const terminalLogs = document.getElementById('terminal-logs');
  const logClock = document.getElementById('log-clock');

  // Video Preview Elements
  const videoPlayer = document.getElementById('final-video-player');
  const videoPlaceholder = document.getElementById('video-placeholder-empty');
  const metaVideoTitle = document.getElementById('meta-video-title');
  const metaBadgeStyle = document.getElementById('meta-badge-style');
  const metaBadgeRes = document.getElementById('meta-badge-res');
  const metaBadgeScenes = document.getElementById('meta-badge-scenes');
  const btnLinkHf = document.getElementById('btn-link-hf');
  const btnDownloadMp4 = document.getElementById('btn-download-mp4');
  const btnCopyLink = document.getElementById('btn-copy-link');

  // Video Library
  const libraryGrid = document.getElementById('library-grid');

  // Auth Modal
  const btnUserAuth = document.getElementById('btn-user-auth');
  const modalAuth = document.getElementById('modal-auth');
  const modalClose = document.getElementById('modal-close');
  const authEmail = document.getElementById('auth-email');
  const authPassword = document.getElementById('auth-password');
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  const btnSignupSubmit = document.getElementById('btn-signup-submit');

  // State
  const API_BASE = window.KAMKAE_API_BASE || localStorage.getItem('kamkae_api_base') || '';
  let currentStyle = 'Cinematic Dark Fantasy';
  let currentAspect = '16:9';
  let activeExecutionId = null;
  let statusPollInterval = null;
  let loggedMessages = new Set();

  // Clock Update
  setInterval(() => {
    const d = new Date();
    logClock.textContent = d.toTimeString().split(' ')[0];
  }, 1000);

  // 1. Script Segmentation & Scene Detection
  function parseSentences(text) {
    if (!text || !text.trim()) return [];
    const lines = text.trim().split('\n').filter(l => l.trim().length > 0);
    const sentences = [];
    for (const line of lines) {
      const parts = line.split(/(?<=[.!?])\s+/);
      for (const p of parts) {
        if (p.trim()) sentences.append ? sentences.append(p.trim()) : sentences.push(p.trim());
      }
    }
    return sentences.length ? sentences : [text.trim()];
  }

  function updateSentencePreview() {
    const text = inputScript.value;
    const sentences = parseSentences(text);
    sentenceCountBadge.textContent = `${sentences.length} Scene${sentences.length === 1 ? '' : 's'} Detected`;

    sentencePreviewList.innerHTML = '';
    sentences.forEach((s, idx) => {
      const pill = document.createElement('span');
      pill.className = 'sentence-pill';
      pill.textContent = `Scene ${idx + 1}: ${s.length > 45 ? s.substring(0, 45) + '...' : s}`;
      sentencePreviewList.appendChild(pill);
    });
  }

  inputScript.addEventListener('input', updateSentencePreview);
  updateSentencePreview();

  // 2. Style Selection
  styleCards.forEach(card => {
    card.addEventListener('click', () => {
      styleCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      currentStyle = card.getAttribute('data-style');
    });
  });

  // 3. Aspect Ratio Toggle
  aspectBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      aspectBtns.forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      currentAspect = btn.getAttribute('data-aspect');
    });
  });

  // 4. Tab Navigation
  function switchTab(tabId) {
    tabBtns.forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
    });
    tabContents.forEach(c => {
      c.classList.toggle('active', c.id === tabId);
    });
  }

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      switchTab(btn.getAttribute('data-tab'));
    });
  });

  // 5. Add Terminal Log Line
  function appendLog(message, type = 'normal') {
    if (loggedMessages.has(message)) return;
    loggedMessages.add(message);

    const div = document.createElement('div');
    div.className = `log-line ${type}`;
    const timeStr = new Date().toTimeString().split(' ')[0];
    div.textContent = `[${timeStr}] ${message}`;
    terminalLogs.appendChild(div);
    terminalLogs.scrollTop = terminalLogs.scrollHeight;
  }

  // 6. Stepper State Manager
  function updateStepper(phase, progress) {
    stepperPercentage.textContent = `${progress}%`;
    progressBarFill.style.width = `${progress}%`;

    const steps = [
      { id: 'step-init', min: 1 },
      { id: 'step-kimi', min: 15 },
      { id: 'step-kie', min: 30 },
      { id: 'step-tts', min: 50 },
      { id: 'step-motion', min: 65 },
      { id: 'step-assembly', min: 80 },
      { id: 'step-upload', min: 90 },
      { id: 'step-done', min: 100 }
    ];

    steps.forEach((s, idx) => {
      const el = document.getElementById(s.id);
      if (!el) return;
      el.classList.remove('active', 'completed');
      if (progress >= s.min) {
        if (progress > s.min || progress === 100) {
          el.classList.add('completed');
        } else {
          el.classList.add('active');
        }
      }
    });
  }

  // 7. Run Automation Handler
  btnRun.addEventListener('click', async () => {
    const title = inputTitle.value.trim() || 'The Legend of Merlin';
    const script = inputScript.value.trim();

    if (!script) {
      alert('Please enter a script to generate scenes.');
      return;
    }

    btnRun.disabled = true;
    btnRun.style.display = 'none';
    btnCancel.style.display = 'inline-flex';

    switchTab('tab-monitor');
    loggedMessages.clear();
    terminalLogs.innerHTML = '';
    appendLog(`Initiating Kamkae Studio Pipeline for "${title}"...`, 'system');
    updateStepper('INITIALIZING', 5);
    stepperStatusText.textContent = 'Submitting Job...';

    try {
      const response = await fetch(`${API_BASE}/api/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          script,
          animationStyle: currentStyle,
          voice: selectVoice.value,
          aspectRatio: currentAspect,
          mode: selectMode.value
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Execution start failed');
      }

      activeExecutionId = data.executionId;
      appendLog(`Job registered with ID: ${activeExecutionId}`, 'system');
      startStatusPolling(activeExecutionId);

    } catch (err) {
      appendLog(`Execution Error: ${err.message}`, 'error');
      btnRun.disabled = false;
      btnRun.style.display = 'inline-flex';
      btnCancel.style.display = 'none';
      stepperStatusText.textContent = 'Execution Failed';
    }
  });

  // 8. Instant Cancel Handler
  btnCancel.addEventListener('click', async () => {
    if (!activeExecutionId) return;
    
    appendLog('Instant Cancel requested by user. Aborting...', 'warn');
    btnCancel.disabled = true;
    btnCancel.textContent = 'Cancelling...';

    try {
      const res = await fetch(`${API_BASE}/api/executions/${activeExecutionId}/cancel`, { method: 'POST' });
      const data = await res.json();
      appendLog('Kaggle session and worker execution aborted.', 'warn');
      stepperStatusText.textContent = 'Cancelled by User';
      cleanupExecution();
    } catch (e) {
      appendLog(`Cancel request note: ${e.message}`, 'error');
      cleanupExecution();
    }
  });

  function cleanupExecution() {
    if (statusPollInterval) clearInterval(statusPollInterval);
    btnRun.disabled = false;
    btnRun.style.display = 'inline-flex';
    btnCancel.style.display = 'none';
    btnCancel.disabled = false;
    btnCancel.innerHTML = '<span>🛑 Instant Cancel</span>';
  }

  // 9. Status Polling Loop
  function startStatusPolling(execId) {
    if (statusPollInterval) clearInterval(statusPollInterval);

    statusPollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/executions/${execId}/status`);
        if (!res.ok) return;

        const data = await res.json();
        stepperStatusText.textContent = data.message || data.phase;
        updateStepper(data.phase, data.progress || 0);

        if (Array.isArray(data.logs)) {
          data.logs.forEach(log => {
            appendLog(log.message || log);
          });
        }

        if (data.status === 'completed') {
          clearInterval(statusPollInterval);
          cleanupExecution();
          appendLog('Execution completed successfully!', 'success');
          loadFinalVideo(data);
          loadLibrary();
        } else if (data.status === 'failed' || data.status === 'cancelled') {
          clearInterval(statusPollInterval);
          cleanupExecution();
          appendLog(`Pipeline ended with status: ${data.status}`, 'warn');
        }
      } catch (err) {
        console.warn('Status poll warning:', err);
      }
    }, 2000);
  }

  // 10. Load Final Video to Preview
  function loadFinalVideo(data) {
    metaVideoTitle.textContent = data.title || 'Untitled Faceless Video';
    metaBadgeStyle.textContent = data.animationStyle || currentStyle;
    metaBadgeRes.textContent = data.aspectRatio === '9:16' ? '1080x1920 (9:16)' : '1920x1080 (16:9)';

    const sentences = parseSentences(data.script || '');
    metaBadgeScenes.textContent = `${sentences.length} Scenes`;

    const localVideoUrl = `${API_BASE}/outputs/${data.execution_id}/final_video.mp4`;
    const hfVideoUrl = data.details?.huggingface?.download_url;

    // Prefer local video URL for direct, fast, zero-CORS browser playback with full audio
    videoPlaceholder.style.display = 'none';
    videoPlayer.style.display = 'block';
    videoPlayer.muted = false;
    videoPlayer.volume = 1.0;
    videoPlayer.src = localVideoUrl;

    videoPlayer.onerror = () => {
      if (hfVideoUrl && videoPlayer.src !== hfVideoUrl) {
        console.log('Falling back to Hugging Face URL for playback');
        videoPlayer.src = hfVideoUrl;
        videoPlayer.load();
      }
    };

    videoPlayer.load();

    if (data.details && data.details.huggingface) {
      btnLinkHf.href = data.details.huggingface.view_url || '#';
      btnDownloadMp4.href = data.details.huggingface.download_url || localVideoUrl;
      btnCopyLink.onclick = () => {
        navigator.clipboard.writeText(data.details.huggingface.download_url);
        alert('Direct Hugging Face video link copied to clipboard!');
      };
    } else {
      btnDownloadMp4.href = localVideoUrl;
      btnCopyLink.onclick = () => {
        navigator.clipboard.writeText(window.location.origin + localVideoUrl);
        alert('Video URL copied to clipboard!');
      };
    }

    // Switch to preview tab after short delay
    setTimeout(() => {
      switchTab('tab-preview');
    }, 1200);
  }

  // 11. Video Library Loader
  async function loadLibrary() {
    try {
      const res = await fetch(`${API_BASE}/api/executions`);
      const data = await res.json();
      libraryGrid.innerHTML = '';

      if (!data.executions || data.executions.length === 0) {
        libraryGrid.innerHTML = '<p style="color: var(--text-dim); font-size: 0.85rem;">No past generations found.</p>';
        return;
      }

      data.executions.forEach(item => {
        const card = document.createElement('div');
        card.className = 'video-card';
        const dateStr = item.timestamp ? new Date(item.timestamp * 1000).toLocaleDateString() : 'Recent';
        
        card.innerHTML = `
          <div class="video-card-thumb">🎬</div>
          <div class="video-card-info">
            <div class="video-card-title">${item.details?.title || 'Faceless Video'}</div>
            <div class="video-card-date">${dateStr} • ${item.status}</div>
          </div>
        `;

        card.addEventListener('click', () => {
          loadFinalVideo(item);
          switchTab('tab-preview');
        });

        libraryGrid.appendChild(card);
      });
    } catch (e) {
      console.warn('Library load note:', e);
    }
  }

  loadLibrary();

  // 12. Auth Modal
  btnUserAuth.addEventListener('click', () => {
    modalAuth.style.display = 'flex';
  });

  modalClose.addEventListener('click', () => {
    modalAuth.style.display = 'none';
  });

  btnLoginSubmit.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    const pass = authPassword.value.trim();
    if (!email || !pass) return;

    try {
      const user = await window.KamkaeFirebase.signIn(email, pass);
      document.getElementById('user-display-name').textContent = user.displayName || email.split('@')[0];
      modalAuth.style.display = 'none';
      alert(`Signed in successfully as ${email}`);
    } catch (err) {
      alert(`Sign in error: ${err.message}`);
    }
  });

  btnSignupSubmit.addEventListener('click', async () => {
    const email = authEmail.value.trim();
    const pass = authPassword.value.trim();
    if (!email || !pass) return;

    try {
      const user = await window.KamkaeFirebase.signUp(email, pass);
      document.getElementById('user-display-name').textContent = user.displayName || email.split('@')[0];
      modalAuth.style.display = 'none';
      alert(`Account created successfully for ${email}`);
    } catch (err) {
      alert(`Sign up error: ${err.message}`);
    }
  });
});
