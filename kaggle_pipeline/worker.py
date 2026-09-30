#!/usr/bin/env python3
"""
Kamkae Studio - Faceless AI Video Automation Worker
Orchestrates:
1. Sentence Segmentation (at fullstops and linebreaks)
2. Prompt Expansion via NVIDIA NIM (Moonshot AI Kimi K3)
3. Image Generation via Kie.ai (Z-Image Model)
4. Voiceover Synthesis via Kokoro TTS / Edge-TTS
5. Moving Image & Audio Synchronization (FFmpeg Ken Burns motion)
6. Sequential Clip Concatenation (vid a + vid b = final video)
7. Hugging Face Dataset Publishing (yugomania/kamkae-studio-generated)
8. Real-time Status Sync & Instant Cancel Monitoring
"""

import os
import sys
import re
import json
import time
import shutil
import urllib.request
import urllib.error
import subprocess
from pathlib import Path

# Load environment variables
def load_env():
    env_file = Path(__file__).parent.parent / ".env"
    if env_file.exists():
        with open(env_file, "r") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip())

load_env()

HF_TOKEN = os.getenv("HF_TOKEN", "")
HF_USERNAME = os.getenv("HF_USERNAME", "yugomania")
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
KIE_API_KEY = os.getenv("KIE_API_KEY", "")
HF_DATASET_NAME = "kamkae-studio-generated"

# Status Logger
class ExecutionMonitor:
    def __init__(self, execution_id, work_dir, firebase_config=None):
        self.execution_id = execution_id
        self.work_dir = Path(work_dir)
        self.status_file = self.work_dir / "status.json"
        self.cancel_flag = self.work_dir / "cancel.flag"
        self.firebase_config = firebase_config

    def log(self, phase, progress, message, details=None):
        payload = {
            "execution_id": self.execution_id,
            "phase": phase,
            "progress": progress,
            "message": message,
            "details": details or {},
            "timestamp": time.time(),
            "status": "cancelled" if phase == "CANCELLED" else ("failed" if phase == "FAILED" else ("completed" if phase == "COMPLETED" else "running"))
        }
        # Print JSON line for process streaming
        print(f"__STATUS_JSON__{json.dumps(payload)}", flush=True)

        # Write to status.json
        try:
            with open(self.status_file, "w") as f:
                json.dump(payload, f, indent=2)
        except Exception:
            pass

        # Optional Firestore sync if credentials configured
        if self.firebase_config:
            self._update_firestore(payload)

    def is_cancelled(self):
        # 1. Local cancel flag
        if self.cancel_flag.exists():
            return True
        # 2. Check status.json
        if self.status_file.exists():
            try:
                with open(self.status_file, "r") as f:
                    data = json.load(f)
                    if data.get("cancelled", False) or data.get("status") == "cancelled":
                        return True
            except Exception:
                pass
        return False

    def _update_firestore(self, payload):
        try:
            project_id = self.firebase_config.get("projectId")
            if not project_id:
                return
            url = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents/executions/{self.execution_id}"
            fields = {k: {"stringValue": str(v)} for k, v in payload.items()}
            req = urllib.request.Request(url, data=json.dumps({"fields": fields}).encode("utf-8"), headers={"Content-Type": "application/json"}, method="PATCH")
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass


# 1. Sentence Segmenter
def segment_script_into_sentences(script_text):
    """
    Splits script into individual sentences at full stops, question marks,
    exclamation marks, or distinct line breaks.
    """
    # Clean text
    clean = script_text.strip()
    # Normalize line breaks to sentences if lines don't end in punctuation
    lines = [line.strip() for line in clean.split("\n") if line.strip()]
    sentences = []
    
    for line in lines:
        parts = re.split(r'(?<=[.!?])\s+', line)
        for part in parts:
            part = part.strip()
            if part:
                # Remove trailing full stop for prompt/voice clarity if needed
                sentences.append(part)
                
    if not sentences:
        sentences = [clean]
    return sentences


# 2. Prompt Expansion via NVIDIA NIM (Moonshot AI Kimi K3)
def expand_prompt_kimi_k3(sentence, animation_style, max_retries=2):
    """
    Expands a sentence into a rich, visual text-to-image prompt using
    NVIDIA NIM API with moonshotai/kimi-k3.
    """
    url = "https://integrate.api.nvidia.com/v1/chat/completions"
    system_prompt = (
        f"You are a master art director creating scene descriptions for a cinematic video. "
        f"Convert the given sentence into a highly detailed, descriptive, visual text-to-image prompt. "
        f"The visual style MUST strictly be: {animation_style}. "
        f"Describe composition, lighting, atmosphere, colors, camera angle, and artistic details. "
        f"Output ONLY the prompt in one paragraph. Do NOT add preamble, quotes, or conversational text."
    )
    
    payload = {
        "model": "moonshotai/kimi-k3",
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Sentence: \"{sentence}\""}
        ],
        "temperature": 0.6,
        "max_tokens": 120
    }

    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY}",
        "Content-Type": "application/json"
    }

    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers)
            with urllib.request.urlopen(req, timeout=25) as response:
                result = json.loads(response.read().decode("utf-8"))
                prompt = result["choices"][0]["message"]["content"].strip()
                # Clean up quotes if model returned them
                prompt = prompt.strip('"\n ')
                return prompt
        except Exception as e:
            if attempt < max_retries - 1:
                time.sleep(2)
            else:
                # Fallback to structured cinematic visual template if API busy
                return (
                    f"A stunning cinematic illustration in {animation_style} style depicting {sentence}. "
                    f"Intricate details, dramatic atmospheric lighting, 8k resolution, masterpiece composition, vibrant color palette."
                )


# 3. Image Generation via Kie.ai Z-Image
def generate_image_kie_ai(prompt, aspect_ratio="16:9", out_path="scene.png", max_wait_sec=60):
    """
    Sends image generation task to Kie.ai Z-Image model and polls for completion.
    """
    create_url = "https://api.kie.ai/api/v1/jobs/createTask"
    headers = {
        "Authorization": f"Bearer {KIE_API_KEY}",
        "Content-Type": "application/json"
    }
    payload = {
        "model": "z-image",
        "input": {
            "prompt": prompt,
            "aspect_ratio": aspect_ratio
        }
    }

    # 1. Create Task
    req = urllib.request.Request(create_url, data=json.dumps(payload).encode("utf-8"), headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        res_data = json.loads(resp.read().decode("utf-8"))
    
    if res_data.get("code") != 200 or not res_data.get("data", {}).get("taskId"):
        raise RuntimeError(f"Kie.ai createTask failed: {res_data}")

    task_id = res_data["data"]["taskId"]

    # 2. Poll Task Result
    poll_url = f"https://api.kie.ai/api/v1/jobs/recordInfo?taskId={task_id}"
    start_time = time.time()
    
    while time.time() - start_time < max_wait_sec:
        poll_req = urllib.request.Request(poll_url, headers=headers)
        with urllib.request.urlopen(poll_req, timeout=15) as poll_resp:
            poll_data = json.loads(poll_resp.read().decode("utf-8"))

        state = poll_data.get("data", {}).get("state")
        if state == "success":
            result_list = poll_data.get("data", {}).get("result", [])
            if not result_list:
                # Check alternative result fields
                result_url = poll_data.get("data", {}).get("imageUrl") or poll_data.get("data", {}).get("output")
            else:
                result_url = result_list[0] if isinstance(result_list, list) else result_list
                
            if not result_url:
                raise RuntimeError(f"No image URL returned from Kie.ai: {poll_data}")

            # Download Image
            urllib.request.urlretrieve(result_url, out_path)
            return out_path
        elif state == "fail":
            raise RuntimeError(f"Kie.ai image generation failed: {poll_data}")

        time.sleep(3)

    raise TimeoutError(f"Kie.ai image generation timed out after {max_wait_sec}s for taskId {task_id}")


# 4. Voiceover Synthesis (Kokoro TTS with Edge-TTS Fallback)
def generate_voiceover(text, voice="af_heart", out_wav="voice.wav"):
    """
    Synthesizes voiceover for the sentence using Kokoro TTS, falling back to
    edge-tts if Kokoro local models are not yet downloaded in the environment.
    """
    # Try Kokoro first
    try:
        from kokoro import KPipeline
        import soundfile as sf
        pipeline = KPipeline(lang_code='a')
        generator = pipeline(text, voice=voice, speed=1.0)
        all_audio = []
        sample_rate = 24000
        for _, _, audio in generator:
            all_audio.append(audio)
        if all_audio:
            import numpy as np
            full_audio = np.concatenate(all_audio)
            sf.write(out_wav, full_audio, sample_rate)
            return out_wav
    except Exception:
        pass

    # High-quality fallback: edge-tts
    try:
        # Map Kokoro voice names to high quality neural voices
        edge_voice = "en-US-ChristopherNeural" if "m" in voice else "en-US-JennyNeural"
        cmd = ["edge-tts", "--voice", edge_voice, "--text", text, "--write-media", out_wav]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode == 0 and os.path.exists(out_wav):
            return out_wav
    except Exception:
        pass

    # Minimal fallback: eSpeak / ffmpeg synthetic tone if in isolated offline container
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi", "-i", "sine=frequency=1000:duration=3",
        "-c:a", "pcm_s16le", out_wav
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out_wav


# Helper: Get audio duration
def get_audio_duration(audio_path):
    cmd = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    try:
        return float(res.stdout.strip())
    except Exception:
        return 3.0


# 5. Motion Video Clip per Sentence (FFmpeg Pan/Zoom Ken Burns)
def create_sentence_clip(image_path, audio_path, out_clip_path, aspect_ratio="16:9"):
    """
    Creates a dynamic moving video clip for Sentence X by stitching Image X with Audio X
    using subtle zoom/pan motion effect scaled to exact audio duration.
    """
    duration = get_audio_duration(audio_path)
    # Ensure a small padding so audio doesn't cut off abruptly
    duration = max(duration + 0.3, 1.5)
    fps = 25
    total_frames = int(duration * fps)

    if aspect_ratio == "9:16":
        width, height = 1080, 1920
    else:
        width, height = 1920, 1080

    # Ken Burns slow zoom effect
    vf = (
        f"scale={width*2}:{height*2},"
        f"zoompan=z='min(zoom+0.0012,1.25)':d={total_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={width}x{height}:fps={fps},"
        f"format=yuv420p"
    )

    cmd = [
        "ffmpeg", "-y",
        "-loop", "1",
        "-i", str(image_path),
        "-i", str(audio_path),
        "-c:v", "libx264",
        "-preset", "fast",
        "-tune", "stillimage",
        "-vf", vf,
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-t", f"{duration:.2f}",
        str(out_clip_path)
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out_clip_path


# 6. Sequential Assembly
def concatenate_clips(clip_paths, out_final_path):
    """
    Sequentially concatenates: vid a + vid b = final video
    """
    list_file = Path(out_final_path).parent / "clips_concat.txt"
    with open(list_file, "w") as f:
        for clip in clip_paths:
            f.write(f"file '{Path(clip).resolve()}'\n")

    cmd = [
        "ffmpeg", "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_file),
        "-c", "copy",
        str(out_final_path)
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out_final_path


# 7. Push Final Video to Hugging Face Dataset
def push_to_huggingface_dataset(video_path, execution_id, title):
    """
    Creates/verifies Hugging Face dataset repository under user yugomania,
    uploads the final video, and returns direct preview and download URLs.
    """
    from huggingface_hub import HfApi
    api = HfApi(token=HF_TOKEN)
    repo_id = f"{HF_USERNAME}/{HF_DATASET_NAME}"

    # Ensure dataset repository exists
    try:
        api.create_repo(repo_id=repo_id, repo_type="dataset", exist_ok=True, private=False)
    except Exception as e:
        print(f"Dataset repo note: {e}")

    # Generate safe filename
    slug = re.sub(r'[^a-zA-Z0-9_\-]', '_', title.lower())[:30]
    remote_path = f"videos/{execution_id}_{slug}.mp4"

    # Upload video
    api.upload_file(
        path_or_fileobj=str(video_path),
        path_in_repo=remote_path,
        repo_id=repo_id,
        repo_type="dataset"
    )

    resolve_url = f"https://huggingface.co/datasets/{repo_id}/resolve/main/{remote_path}"
    view_url = f"https://huggingface.co/datasets/{repo_id}/blob/main/{remote_path}"
    
    return {
        "repo_id": repo_id,
        "remote_path": remote_path,
        "view_url": view_url,
        "download_url": resolve_url
    }


# Main Runner Pipeline
def run_pipeline(config_path=None):
    if "EMBEDDED_CONFIG" in globals() and globals()["EMBEDDED_CONFIG"]:
        cfg = globals()["EMBEDDED_CONFIG"]
    elif config_path and os.path.exists(config_path):
        with open(config_path, "r") as f:
            cfg = json.load(f)
    else:
        cfg = {
            "title": "The Legend of Merlin",
            "script": "In the land of myth.\nIn the time of magic.\nThe destiny of a great kingdom rests on the shoulders of a young boy.\nHis name: Merlin.",
            "animation_style": "Cinematic Dark Fantasy",
            "voice": "af_heart",
            "aspect_ratio": "16:9",
            "execution_id": f"exec_{int(time.time())}"
        }

    title = cfg.get("title", "Untitled Faceless Video")
    script = cfg.get("script", "")
    animation_style = cfg.get("animation_style", "Cinematic Dark Fantasy")
    voice = cfg.get("voice", "af_heart")
    aspect_ratio = cfg.get("aspect_ratio", "16:9")
    execution_id = cfg.get("execution_id", f"exec_{int(time.time())}")
    firebase_config = cfg.get("firebase_config")

    work_dir = Path("./outputs") / execution_id
    work_dir.mkdir(parents=True, exist_ok=True)

    monitor = ExecutionMonitor(execution_id, work_dir, firebase_config)

    try:
        monitor.log("INITIALIZING", 5, "Initializing Kamkae Video Pipeline on T4 GPU...", {
            "title": title,
            "animation_style": animation_style,
            "aspect_ratio": aspect_ratio
        })

        if monitor.is_cancelled():
            monitor.log("CANCELLED", 0, "Execution cancelled by user.")
            return

        # Phase 1: Sentence Segmentation
        sentences = segment_script_into_sentences(script)
        monitor.log("SEGMENTED", 15, f"Broken script into {len(sentences)} individual sentence scenes.", {
            "sentences": sentences
        })

        clips = []
        total_scenes = len(sentences)

        for i, sentence in enumerate(sentences):
            if monitor.is_cancelled():
                monitor.log("CANCELLED", 0, "Execution cancelled by user.")
                return

            scene_num = i + 1
            scene_progress_base = 15 + int((i / total_scenes) * 60)

            # Step 2: Prompt Expansion via Kimi K3
            monitor.log("PROMPT_ENGINEERING", scene_progress_base, f"Generating visual prompt for sentence {scene_num}/{total_scenes} with Kimi K3...", {
                "sentence": sentence
            })
            visual_prompt = expand_prompt_kimi_k3(sentence, animation_style)
            
            # Step 3: Image Generation via Kie.ai Z-Image
            monitor.log("IMAGE_GENERATION", scene_progress_base + 5, f"Generating scene image {scene_num}/{total_scenes} via Kie.ai Z-Image...", {
                "prompt": visual_prompt
            })
            img_path = work_dir / f"scene_{i}.png"
            generate_image_kie_ai(visual_prompt, aspect_ratio=aspect_ratio, out_path=str(img_path))

            # Step 4: Voiceover Synthesis via Kokoro TTS
            monitor.log("TTS_SYNTHESIS", scene_progress_base + 10, f"Synthesizing Kokoro voiceover for sentence {scene_num}/{total_scenes}...", {
                "sentence": sentence,
                "voice": voice
            })
            audio_path = work_dir / f"audio_{i}.wav"
            generate_voiceover(sentence, voice=voice, out_wav=str(audio_path))

            # Step 5: Audio + Image Stitching (Sentence X === Image x + Audio x = Vid x)
            monitor.log("CLIP_STITCHING", scene_progress_base + 15, f"Stitching sentence video clip {scene_num}/{total_scenes} with motion...", {
                "scene": scene_num
            })
            clip_path = work_dir / f"vid_{i}.mp4"
            create_sentence_clip(img_path, audio_path, clip_path, aspect_ratio=aspect_ratio)
            clips.append(str(clip_path))

        # Step 6: Sequential Assembly (vid a + vid b = final video)
        if monitor.is_cancelled():
            monitor.log("CANCELLED", 0, "Execution cancelled by user.")
            return

        monitor.log("ASSEMBLING", 80, f"Sequentially joining {len(clips)} sentence clips into final video...")
        final_video_path = work_dir / "final_video.mp4"
        concatenate_clips(clips, str(final_video_path))

        # Step 7: Push to Hugging Face Dataset
        monitor.log("UPLOADING", 90, "Uploading final video to Hugging Face dataset repository...")
        hf_result = push_to_huggingface_dataset(final_video_path, execution_id, title)

        # Step 8: Completion
        monitor.log("COMPLETED", 100, "Faceless video automation successfully completed!", {
            "title": title,
            "final_video": str(final_video_path),
            "huggingface": hf_result,
            "view_url": hf_result["view_url"],
            "download_url": hf_result["download_url"]
        })

    except Exception as e:
        monitor.log("FAILED", 0, f"Pipeline error: {str(e)}", {"error": str(e)})
        raise

if __name__ == "__main__":
    cfg_arg = sys.argv[1] if len(sys.argv) > 1 else None
    run_pipeline(cfg_arg)
