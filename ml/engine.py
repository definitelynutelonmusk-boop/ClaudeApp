#!/usr/bin/env python3
"""Local image AI engine for Style Trainer.

Runs entirely on your own computer: no API, no content filter.

  python engine.py check
      Print what hardware will be used, as JSON.

  python engine.py train --images-list FILE --out DIR --trigger WORD [--steps N]
      Fine-tune a LoRA on your pictures. Prints JSON progress lines.

  python engine.py serve
      Image generation worker. Reads one JSON request per line on stdin and
      answers with one JSON line on stdout. Keeps the model loaded between requests.

Settings come from environment variables:
  BASE_MODEL       Hugging Face repo id, local folder, or a single .safetensors
                   checkpoint (SD 1.5 or SDXL). Default: SDXL base 1.0.
  BASE_MODEL_ARCH  "sdxl" or "sd15". Only needed for single-file checkpoints
                   if the guess from the file size is wrong.
  LOW_VRAM         "1" to keep parts of the model in normal RAM while generating
                   (slower, but works on smaller graphics cards).
"""
import argparse
import contextlib
import json
import os
import random
import sys
import time
import traceback

# Our JSON messages go on stdout. Everything the AI libraries print goes to stderr.
_PROTOCOL_OUT = sys.stdout
sys.stdout = sys.stderr

BASE_MODEL = os.environ.get("BASE_MODEL") or "stabilityai/stable-diffusion-xl-base-1.0"
BASE_MODEL_ARCH = os.environ.get("BASE_MODEL_ARCH", "").lower()
LOW_VRAM = os.environ.get("LOW_VRAM") == "1"
LORA_FILE = "pytorch_lora_weights.safetensors"

ASPECTS = {"1:1": (1, 1), "16:9": (16, 9), "9:16": (9, 16), "4:3": (4, 3), "3:4": (3, 4)}


def emit(obj):
    _PROTOCOL_OUT.write(json.dumps(obj) + "\n")
    _PROTOCOL_OUT.flush()


def pick_device():
    import torch

    if torch.cuda.is_available():
        return "cuda", (torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16)
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return "mps", torch.float16
    return "cpu", torch.float32


def load_pipeline(dtype):
    """Load the base model with the safety checker (content filter) removed."""
    import torch
    from diffusers import DiffusionPipeline, StableDiffusionPipeline, StableDiffusionXLPipeline

    if os.path.isfile(BASE_MODEL):
        arch = BASE_MODEL_ARCH or ("sdxl" if os.path.getsize(BASE_MODEL) > 5 * 1024**3 else "sd15")
        cls = StableDiffusionXLPipeline if arch == "sdxl" else StableDiffusionPipeline
        pipe = cls.from_single_file(BASE_MODEL, torch_dtype=dtype)
    else:
        kwargs = dict(torch_dtype=dtype, safety_checker=None, requires_safety_checker=False)
        try:
            pipe = DiffusionPipeline.from_pretrained(
                BASE_MODEL, variant="fp16" if dtype != torch.float32 else None, **kwargs
            )
        except Exception as e:  # model has no fp16 files: use the normal ones
            if "variant" not in str(e).lower():
                raise
            pipe = DiffusionPipeline.from_pretrained(BASE_MODEL, **kwargs)

    if not isinstance(pipe, (StableDiffusionPipeline, StableDiffusionXLPipeline)):
        raise RuntimeError(f"BASE_MODEL must be a Stable Diffusion 1.5 or SDXL model, got {type(pipe).__name__}")

    # No content filter.
    if hasattr(pipe, "safety_checker"):
        pipe.safety_checker = None
        pipe.feature_extractor = None
        pipe.register_to_config(requires_safety_checker=False)
    return pipe


def is_sdxl(pipe):
    from diffusers import StableDiffusionXLPipeline

    return isinstance(pipe, StableDiffusionXLPipeline)


def friendly_error(e):
    msg = str(e)
    if "out of memory" in msg.lower() or type(e).__name__ == "OutOfMemoryError":
        return (
            "Your graphics card ran out of memory. Try setting LOW_VRAM=1, making fewer pictures at once, "
            "or using a smaller model (Stable Diffusion 1.5)."
        )
    return msg or type(e).__name__


# ---------------------------------------------------------------- check


def cmd_check(_args):
    import diffusers
    import peft  # noqa: F401  (needed for LoRA)
    import torch

    device, _ = pick_device()
    info = {
        "ok": True,
        "device": device,
        "torch": torch.__version__,
        "diffusers": diffusers.__version__,
        "baseModel": BASE_MODEL,
    }
    if device == "cuda":
        props = torch.cuda.get_device_properties(0)
        info["gpu"] = props.name
        info["vramGb"] = round(props.total_memory / 1024**3, 1)
    elif device == "mps":
        info["gpu"] = "Apple Silicon"
    emit(info)


# ---------------------------------------------------------------- train


def cmd_train(args):
    import numpy as np
    import torch
    import torch.nn.functional as F
    from diffusers import DDPMScheduler
    from diffusers.training_utils import cast_training_params
    from diffusers.utils import convert_state_dict_to_diffusers
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
    from PIL import Image, ImageOps

    random.seed(args.seed)
    torch.manual_seed(args.seed)

    device, dtype = pick_device()
    if device != "cuda":
        dtype = torch.float32  # mixed precision training is only reliable on NVIDIA cards

    emit({"event": "status", "message": "Loading the base model (the first time downloads several GB)…"})
    pipe = load_pipeline(dtype)
    sdxl = is_sdxl(pipe)
    res = args.resolution or (1024 if sdxl else 512)

    with open(args.images_list) as f:
        paths = json.load(f)
    if not paths:
        raise RuntimeError("No pictures to train on")

    # 1. Turn every picture (and its mirror image) into latents once. The VAE runs in
    #    fp32 because the SDXL VAE produces garbage in fp16.
    emit({"event": "status", "message": f"Preparing {len(paths)} pictures…"})
    vae = pipe.vae.to(device, dtype=torch.float32)
    latents_cache = []
    with torch.no_grad():
        for path in paths:
            img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
            img = ImageOps.fit(img, (res, res), Image.LANCZOS)  # resize + centre crop
            for flip in (False, True):
                im = ImageOps.mirror(img) if flip else img
                pixels = torch.from_numpy(np.asarray(im).copy()).permute(2, 0, 1).float() / 127.5 - 1
                dist = vae.encode(pixels[None].to(device)).latent_dist
                latents_cache.append((dist.sample() * vae.config.scaling_factor).cpu())
    vae.to("cpu")

    # 2. Encode the trigger word once.
    pipe.text_encoder.to(device)
    if sdxl:
        pipe.text_encoder_2.to(device)
    with torch.no_grad():
        enc = pipe.encode_prompt(
            prompt=args.trigger, device=device, num_images_per_prompt=1, do_classifier_free_guidance=False
        )
    prompt_embeds = enc[0].to(device)
    pooled = enc[2].to(device) if sdxl else None
    pipe.text_encoder.to("cpu")
    if sdxl:
        pipe.text_encoder_2.to("cpu")
    if device == "cuda":
        torch.cuda.empty_cache()

    # 3. Attach a small trainable LoRA to the frozen UNet.
    unet = pipe.unet.to(device)
    unet.requires_grad_(False)
    unet.add_adapter(
        LoraConfig(
            r=args.rank,
            lora_alpha=args.rank,
            init_lora_weights="gaussian",
            target_modules=["to_k", "to_q", "to_v", "to_out.0"],
        )
    )
    if dtype != torch.float32:
        cast_training_params(unet, dtype=torch.float32)  # LoRA weights train in fp32
    unet.enable_gradient_checkpointing()
    unet.train()
    params = [p for p in unet.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=args.lr, weight_decay=1e-2)
    noise_scheduler = DDPMScheduler.from_config(pipe.scheduler.config)
    scaler = torch.amp.GradScaler("cuda") if dtype == torch.float16 else None
    autocast = (
        (lambda: torch.autocast(device_type="cuda", dtype=dtype)) if device == "cuda" else contextlib.nullcontext
    )
    added_cond = None
    if sdxl:
        time_ids = torch.tensor([[res, res, 0, 0, res, res]], device=device, dtype=prompt_embeds.dtype)
        added_cond = {"text_embeds": pooled, "time_ids": time_ids}

    # 4. Train.
    start = last_report = time.time()
    for step in range(1, args.steps + 1):
        latents = random.choice(latents_cache).to(device)
        noise = torch.randn_like(latents)
        t = torch.randint(0, noise_scheduler.config.num_train_timesteps, (1,), device=device).long()
        noisy = noise_scheduler.add_noise(latents, noise, t)
        if noise_scheduler.config.prediction_type == "v_prediction":
            target = noise_scheduler.get_velocity(latents, noise, t)
        else:
            target = noise

        with autocast():
            kwargs = {"added_cond_kwargs": added_cond} if sdxl else {}
            pred = unet(noisy, t, prompt_embeds, return_dict=False, **kwargs)[0]
        loss = F.mse_loss(pred.float(), target.float())

        if scaler:
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(optimizer)
            scaler.update()
        else:
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            optimizer.step()
        optimizer.zero_grad(set_to_none=True)

        now = time.time()
        if now - last_report > 2 or step == args.steps:
            last_report = now
            per_step = (now - start) / step
            emit({
                "event": "progress",
                "step": step,
                "total": args.steps,
                "loss": round(loss.item(), 4),
                "secondsLeft": round(per_step * (args.steps - step)),
            })

    # 5. Save just the LoRA (a few dozen MB).
    emit({"event": "status", "message": "Saving…"})
    os.makedirs(args.out, exist_ok=True)
    lora_state = convert_state_dict_to_diffusers(get_peft_model_state_dict(unet))
    type(pipe).save_lora_weights(args.out, unet_lora_layers=lora_state, safe_serialization=True)
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump(
            {"baseModel": BASE_MODEL, "arch": "sdxl" if sdxl else "sd15", "trigger": args.trigger,
             "steps": args.steps, "resolution": res, "rank": args.rank, "images": len(paths)},
            f,
            indent=2,
        )
    emit({"event": "done"})


# ---------------------------------------------------------------- serve


def image_size(aspect, sdxl):
    w, h = ASPECTS.get(aspect, (1, 1))
    area = (1024 if sdxl else 512) ** 2
    width = (area * w / h) ** 0.5
    height = width * h / w
    return int(round(width / 64) * 64), int(round(height / 64) * 64)


def cmd_serve(_args):
    import torch

    device, dtype = pick_device()
    pipe = None
    loaded_lora = None

    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        try:
            if pipe is None:
                pipe = load_pipeline(dtype)
                low_vram = LOW_VRAM or (
                    device == "cuda" and torch.cuda.get_device_properties(0).total_memory < 10 * 1024**3
                )
                if low_vram and device == "cuda":
                    pipe.enable_model_cpu_offload()
                else:
                    pipe.to(device)
                pipe.set_progress_bar_config(disable=True)

            lora = req.get("lora")
            if lora != loaded_lora:
                if loaded_lora:
                    pipe.unload_lora_weights()
                    loaded_lora = None
                if lora:
                    pipe.load_lora_weights(lora, weight_name=LORA_FILE)
                loaded_lora = lora

            sdxl = is_sdxl(pipe)
            width, height = image_size(req.get("aspect", "1:1"), sdxl)
            seed = req.get("seed", random.randrange(2**31))
            files = []
            # One picture at a time keeps memory use low.
            for i, out_path in enumerate(req["outPaths"]):
                image = pipe(
                    prompt=req["prompt"],
                    negative_prompt=req.get("negativePrompt") or None,
                    width=width,
                    height=height,
                    num_inference_steps=int(req.get("steps", 30)),
                    guidance_scale=float(req.get("guidance", 7.0 if sdxl else 7.5)),
                    generator=torch.Generator("cpu").manual_seed(seed + i),
                ).images[0]
                image.save(out_path)
                files.append(out_path)
            emit({"id": req["id"], "ok": True, "files": files, "seed": seed})
        except Exception as e:  # report the error and keep serving
            traceback.print_exc()
            if device == "cuda":
                torch.cuda.empty_cache()
            emit({"id": req.get("id"), "ok": False, "error": friendly_error(e)})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("serve")
    t = sub.add_parser("train")
    t.add_argument("--images-list", required=True, help="JSON file with a list of image paths")
    t.add_argument("--out", required=True, help="folder to save the LoRA in")
    t.add_argument("--trigger", required=True, help="made-up word the model links to your pictures")
    t.add_argument("--steps", type=int, default=1000)
    t.add_argument("--rank", type=int, default=16)
    t.add_argument("--lr", type=float, default=1e-4)
    t.add_argument("--resolution", type=int, default=0, help="default: 1024 for SDXL, 512 for SD 1.5")
    t.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    try:
        {"check": cmd_check, "train": cmd_train, "serve": cmd_serve}[args.cmd](args)
    except Exception as e:
        traceback.print_exc()
        emit({"event": "error", "ok": False, "error": friendly_error(e)})
        sys.exit(1)


if __name__ == "__main__":
    main()
