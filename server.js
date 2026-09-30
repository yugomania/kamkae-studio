import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { spawn, exec } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

const OUTPUTS_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUTPUTS_DIR)) {
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
}

// In-memory executions store + file persistence
const activeExecutions = new Map();

// Helper to get or load execution
function getExecution(id) {
  if (activeExecutions.has(id)) {
    return activeExecutions.get(id);
  }
  const statusFile = path.join(OUTPUTS_DIR, id, 'status.json');
  if (fs.existsSync(statusFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      activeExecutions.set(id, data);
      return data;
    } catch (e) {
      console.error('Error reading status file:', e);
    }
  }
  return null;
}

// System Status API
app.get('/api/system-status', (req, res) => {
  res.json({
    status: 'online',
    credentials: {
      huggingface: !!process.env.HF_TOKEN,
      hfUsername: process.env.HF_USERNAME || 'yugomania',
      kaggle: !!process.env.KAGGLE_API_TOKEN,
      kaggleUsername: process.env.KAGGLE_USERNAME || 'ugochukwuodagu',
      nvidia: !!process.env.NVIDIA_API_KEY,
      nvidiaModel: process.env.NVIDIA_MODEL || 'moonshotai/kimi-k3',
      kieAi: !!process.env.KIE_API_KEY,
      firebase: !!process.env.FIREBASE_PROJECT_ID
    },
    kaggleGpu: 'T4 GPU Accelerator (NvidiaTeslaT4)'
  });
});

// Firebase Web Config for Client
app.get('/api/firebase-config', (req, res) => {
  res.json({
    enabled: !!process.env.FIREBASE_PROJECT_ID,
    config: {
      apiKey: process.env.FIREBASE_API_KEY || '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
      projectId: process.env.FIREBASE_PROJECT_ID || '',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: process.env.FIREBASE_APP_ID || ''
    }
  });
});

// Run Video Automation Execution
app.post('/api/execute', async (req, res) => {
  const {
    title = 'Untitled Faceless Video',
    script = '',
    animationStyle = 'Cinematic Dark Fantasy',
    voice = 'af_heart',
    aspectRatio = '16:9',
    mode = 'kaggle' // 'kaggle' or 'direct'
  } = req.body;

  if (!script || !script.trim()) {
    return res.status(400).json({ error: 'Script text is required.' });
  }

  const executionId = `exec_${Date.now()}_${uuidv4().substring(0, 6)}`;
  const workDir = path.join(OUTPUTS_DIR, executionId);
  fs.mkdirSync(workDir, { recursive: true });

  const jobConfig = {
    title,
    script,
    animation_style: animationStyle,
    voice,
    aspect_ratio: aspectRatio,
    execution_id: executionId,
    mode,
    firebase_config: process.env.FIREBASE_PROJECT_ID ? {
      projectId: process.env.FIREBASE_PROJECT_ID,
      apiKey: process.env.FIREBASE_API_KEY
    } : null
  };

  const configPath = path.join(workDir, 'job_config.json');
  fs.writeFileSync(configPath, JSON.stringify(jobConfig, null, 2));

  const executionState = {
    execution_id: executionId,
    title,
    script,
    animationStyle,
    voice,
    aspectRatio,
    mode,
    phase: 'QUEUED',
    progress: 0,
    status: 'running',
    message: mode === 'kaggle' ? 'Preparing Kaggle T4 GPU Kernel push...' : 'Starting local execution...',
    logs: [
      { timestamp: Date.now(), message: `Studio execution created: ${title}` }
    ],
    details: {},
    created_at: Date.now()
  };

  activeExecutions.set(executionId, executionState);

  // Launch worker
  if (mode === 'kaggle') {
    launchKaggleKernel(executionId, workDir, jobConfig);
  } else {
    launchDirectWorker(executionId, workDir, configPath);
  }

  res.json({
    success: true,
    executionId,
    status: 'running',
    message: 'Automation pipeline launched successfully.'
  });
});

// Launch Kaggle Kernel with T4 GPU
function launchKaggleKernel(executionId, workDir, jobConfig) {
  const state = activeExecutions.get(executionId);
  const kaggleDir = path.join(workDir, 'kaggle_run');
  fs.mkdirSync(kaggleDir, { recursive: true });

  const cleanId = executionId.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const kernelSlug = `kamkae-video-${cleanId}`.substring(0, 45);
  const kernelTitle = `Kamkae Video ${cleanId}`.substring(0, 45);

  // Read worker script and inject configuration and secrets for cloud execution
  const workerSrc = path.join(__dirname, 'kaggle_pipeline', 'worker.py');
  const baseCode = fs.readFileSync(workerSrc, 'utf8');

  const kaggleHeader = `
# AUTO-INJECTED CONFIGURATION FOR KAGGLE T4 CONTAINER
import os, sys, subprocess, json

# Standard JSON compatibility constants for Python
null = None
true = True
false = False

# Ensure essential dependencies in Kaggle environment
for _mod, _pkg in [("huggingface_hub", "huggingface_hub"), ("soundfile", "soundfile"), ("edge_tts", "edge-tts")]:
    try:
        __import__(_mod)
    except ImportError:
        subprocess.run([sys.executable, "-m", "pip", "install", "-q", _pkg])

# Inject Job Configuration safely via json.loads
EMBEDDED_CONFIG = json.loads(${JSON.stringify(JSON.stringify(jobConfig))})

# Inject API Secrets into cloud runtime
os.environ["HF_TOKEN"] = ${JSON.stringify(process.env.HF_TOKEN || '')};
os.environ["HF_USERNAME"] = ${JSON.stringify(process.env.HF_USERNAME || 'yugomania')};
os.environ["NVIDIA_API_KEY"] = ${JSON.stringify(process.env.NVIDIA_API_KEY || '')};
os.environ["KIE_API_KEY"] = ${JSON.stringify(process.env.KIE_API_KEY || '')};
`;

  fs.writeFileSync(path.join(kaggleDir, 'worker.py'), kaggleHeader + '\n' + baseCode);
  fs.writeFileSync(path.join(kaggleDir, 'job_config.json'), JSON.stringify(jobConfig, null, 2));

  // Write kernel metadata targeting T4 GPU
  const kernelMeta = {
    id: `${process.env.KAGGLE_USERNAME || 'ugochukwuodagu'}/${kernelSlug}`,
    title: kernelTitle,
    code_file: 'worker.py',
    language: 'python',
    kernel_type: 'script',
    is_private: true,
    enable_gpu: true,
    enable_tpu: false,
    enable_internet: true,
    machine_shape: 'NvidiaTeslaT4'
  };
  fs.writeFileSync(path.join(kaggleDir, 'kernel-metadata.json'), JSON.stringify(kernelMeta, null, 2));

  state.logs.push({
    timestamp: Date.now(),
    message: 'Pushing kernel to Kaggle with T4 GPU accelerator (NvidiaTeslaT4)...'
  });
  state.phase = 'KAGGLE_PUSH';
  state.progress = 5;

  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
    KAGGLE_API_TOKEN: process.env.KAGGLE_API_TOKEN
  };

  // Push kernel via Kaggle CLI
  exec(`kaggle kernels push -p "${kaggleDir}" --accelerator NvidiaTeslaT4`, { env }, (err, stdout, stderr) => {
    if (err) {
      console.warn('Kaggle CLI push warning/fallback:', stderr || stdout);
      state.logs.push({
        timestamp: Date.now(),
        message: `Kaggle Push notice: ${stdout || stderr}. Falling back to accelerated direct worker.`
      });
      // Fallback to local direct execution so user job never stalls
      launchDirectWorker(executionId, workDir, path.join(workDir, 'job_config.json'));
      return;
    }

    state.logs.push({
      timestamp: Date.now(),
      message: `Kaggle T4 Kernel version successfully pushed. Output: ${stdout.trim()}`
    });
    state.phase = 'KAGGLE_RUNNING';
    state.progress = 15;

    // Monitor Kaggle kernel status
    monitorKaggleExecution(executionId, kernelMeta.id, workDir);
  });
}

// Monitor running Kaggle kernel
function monitorKaggleExecution(executionId, kernelSlug, workDir) {
  const state = activeExecutions.get(executionId);
  if (!state) return;

  const env = {
    ...process.env,
    PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
    KAGGLE_API_TOKEN: process.env.KAGGLE_API_TOKEN
  };

  const interval = setInterval(() => {
    if (!activeExecutions.has(executionId) || state.status === 'cancelled') {
      clearInterval(interval);
      return;
    }

    exec(`kaggle kernels status "${kernelSlug}"`, { env }, (err, stdout, stderr) => {
      if (err) return;
      const statusText = stdout.trim();
      state.logs.push({ timestamp: Date.now(), message: `Kaggle Status: ${statusText}` });

      if (statusText.includes('complete')) {
        clearInterval(interval);
        exec(`kaggle kernels output "${kernelSlug}" -p "${workDir}"`, { env }, () => {
          const statusFile = path.join(workDir, 'status.json');
          if (fs.existsSync(statusFile)) {
            try {
              const resData = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
              state.details = resData.details || state.details;
            } catch (e) {}
          }
          state.phase = 'COMPLETED';
          state.progress = 100;
          state.status = 'completed';
          state.message = 'Kaggle T4 GPU execution finished successfully!';
        });
      } else if (statusText.includes('error') || statusText.includes('failed')) {
        clearInterval(interval);
        state.phase = 'FAILED';
        state.status = 'failed';
        state.message = `Kaggle kernel run failed: ${statusText}`;
        exec(`kaggle kernels output "${kernelSlug}" -p "${workDir}"`, { env }, () => {});
      }
    });
  }, 10000);
}

// Launch Direct Python Pipeline Worker
function launchDirectWorker(executionId, workDir, configPath) {
  const state = activeExecutions.get(executionId);
  const workerScript = path.join(__dirname, 'kaggle_pipeline', 'worker.py');

  const pyProcess = spawn('python3', [workerScript, configPath], {
    cwd: __dirname,
    env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` }
  });

  state.process = pyProcess;

  pyProcess.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('__STATUS_JSON__')) {
        try {
          const jsonStr = line.replace('__STATUS_JSON__', '');
          const statusObj = JSON.parse(jsonStr);
          state.phase = statusObj.phase;
          state.progress = statusObj.progress;
          state.message = statusObj.message;
          state.status = statusObj.status;
          state.details = { ...state.details, ...statusObj.details };
          state.logs.push({
            timestamp: Date.now(),
            message: `[${statusObj.phase}] ${statusObj.message}`
          });
        } catch (e) {
          console.error('Failed to parse status JSON:', e);
        }
      } else {
        state.logs.push({ timestamp: Date.now(), message: line.trim() });
      }
    }
  });

  pyProcess.stderr.on('data', (data) => {
    const errText = data.toString().trim();
    if (errText) {
      state.logs.push({ timestamp: Date.now(), message: `[stderr] ${errText}` });
    }
  });

  pyProcess.on('close', (code) => {
    if (state.status !== 'cancelled') {
      if (code === 0) {
        state.status = 'completed';
        state.progress = 100;
        state.phase = 'COMPLETED';
        state.message = 'Automation finished successfully!';
      } else {
        state.status = 'failed';
        state.phase = 'FAILED';
        state.message = `Worker process exited with code ${code}`;
      }
    }
  });
}

// Status & Progress Polling API
app.get('/api/executions/:id/status', (req, res) => {
  const execData = getExecution(req.params.id);
  if (!execData) {
    return res.status(404).json({ error: 'Execution not found.' });
  }

  // Sanitize process object from response
  const { process: p, ...safeData } = execData;
  res.json(safeData);
});

// Instant Cancel API
app.post('/api/executions/:id/cancel', (req, res) => {
  const { id } = req.params;
  const execData = activeExecutions.get(id);

  const workDir = path.join(OUTPUTS_DIR, id);
  const cancelFlag = path.join(workDir, 'cancel.flag');
  fs.writeFileSync(cancelFlag, 'cancelled');

  if (execData) {
    execData.status = 'cancelled';
    execData.phase = 'CANCELLED';
    execData.message = 'Execution cancelled instantly by user.';
    execData.logs.push({ timestamp: Date.now(), message: 'User clicked Instant Cancel. Aborting worker.' });

    // Kill local process if running
    if (execData.process && !execData.process.killed) {
      try {
        execData.process.kill('SIGKILL');
      } catch (e) {}
    }

    // Cancel Kaggle kernel if running on Kaggle
    if (execData.mode === 'kaggle') {
      const env = {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}`,
        KAGGLE_API_TOKEN: process.env.KAGGLE_API_TOKEN
      };
      const kernelSlug = `${process.env.KAGGLE_USERNAME || 'ugochukwuodagu'}/kamkae-video-${id.toLowerCase().replace(/_/g, '-')}`;
      exec(`kaggle kernels delete "${kernelSlug}" -y`, { env }, () => {});
    }
  }

  res.json({
    success: true,
    status: 'cancelled',
    message: 'Execution cancelled instantly.'
  });
});

// Video Library API (List past executions)
app.get('/api/executions', (req, res) => {
  const list = [];
  try {
    if (fs.existsSync(OUTPUTS_DIR)) {
      const dirs = fs.readdirSync(OUTPUTS_DIR);
      for (const d of dirs) {
        const statusFile = path.join(OUTPUTS_DIR, d, 'status.json');
        if (fs.existsSync(statusFile)) {
          try {
            const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
            list.push(data);
          } catch (e) {}
        }
      }
    }
  } catch (e) {
    console.error('Error listing executions:', e);
  }

  list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  res.json({ executions: list });
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`  🎬 KAMKAE STUDIO SERVER READY`);
  console.log(`  Local URL: http://localhost:${PORT}`);
  console.log(`  Kaggle T4 Accelerator & Hugging Face Hub Connected`);
  console.log(`======================================================\n`);
});
