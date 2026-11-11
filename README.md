# Style Trainer

Teach an AI what you like, then make new pictures with it. **Everything runs on your own computer.**
There's no account, no API key, no cost per picture, and no content filter. Your pictures never leave your machine.

1. **Upload good pictures** of what you want: a person, a pet, an object, or an art style. 10–20 works best.
2. **Train.** The app fine-tunes an open Stable Diffusion model (a LoRA) on your pictures.
3. **Type a prompt.** You get new pictures based on what it learned, e.g. *"sitting on a beach at sunset, oil painting"*.
4. **Rate each picture out of 10.** The app shows your average score and how your ratings are spread out, and can sort the gallery by best or worst.
   Pictures you rate **8 or higher** can be added back to the training set. Retrain to make the model even better.

## What you need

- **[Node.js](https://nodejs.org) 20.12+** and **[Python](https://www.python.org/downloads/) 3.10+**
- **A graphics card** (strongly recommended). For example, an RTX 3060 12GB with 32 GB of RAM runs the default SDXL model fine: about 30–45 minutes to train and 10–15 seconds per picture.
  - **NVIDIA with 12 GB+ memory** (e.g. RTX 3060 12GB, 4070, 3090, 4090) for the default SDXL model.
  - **NVIDIA with 8 GB** works with Stable Diffusion 1.5 (see [Choosing the model](#choosing-the-model)).
  - **Apple Silicon Mac** (M1/M2/M3/M4) works but is slower. 16 GB+ unified memory recommended.
  - **No graphics card:** it still runs on the processor, but training takes many hours.
- **About 15 GB of free disk space** for the AI libraries and the model.

## Install and run

```bash
npm install
npm run setup     # installs PyTorch + the AI libraries into .venv (takes a while, several GB)
npm start
```

Open http://localhost:3000. The badge in the top right shows which graphics card the AI is using.

The **first training run or picture downloads the base model** (about 7 GB for SDXL), so it takes longer.
After that everything works offline.

**Timing (rough, on an RTX 4090):** training with 1000 steps takes about 15–20 minutes. Each picture takes a few seconds.
Slower cards take proportionally longer.

## Use it on your phone

Your computer does the AI work and your phone is the screen.

1. Start the app on your computer with `npm start`.
2. Make sure your phone is on the **same Wi-Fi** as the computer.
3. Scan the **QR code** printed in the terminal with your phone's camera, or click **📱 Open on phone** in the app on your computer.
   You can also type the address it shows, like `http://192.168.1.20:3000`, into your phone's browser.
4. **Windows:** the first time, Windows Firewall asks whether to allow Node.js. Tick **Private networks** and click **Allow**.
   If you missed it, search Start for "Allow an app through Windows Firewall" and tick Node.js under Private.
5. In your phone's browser menu, choose **Add to Home screen** so it opens like an app.

Your computer has to stay on with the app running. If your phone locks while pictures are being made, they still finish and show up in the Gallery.

**Lock it with a password** so others on your Wi-Fi can't use it. Add this to `.env` and restart:

```
APP_PASSWORD=pick-something
```

### Away from home (optional)

Install [Tailscale](https://tailscale.com) (free) on your computer and your phone and sign in to the same account.
The app then shows a second address (starting `100.`) that works from anywhere, even on mobile data, and stays private to your devices.

For a proper home-screen app with HTTPS, run `tailscale serve --bg 3000` on the computer and open the `https://…ts.net` address it gives you on your phone.

### Try it without the AI

```bash
npm run demo
```

Demo mode skips the AI. Training finishes in seconds and pictures are placeholder art, so you can try the app before installing anything big.

## Choosing the model

By default the app starts from **Stable Diffusion XL** (`stabilityai/stable-diffusion-xl-base-1.0`).
You can use any **SDXL** or **Stable Diffusion 1.5** model instead, including uncensored community fine-tunes.
Copy `.env.example` to `.env` and set `BASE_MODEL` to one of:

- a Hugging Face repo id, e.g. `stable-diffusion-v1-5/stable-diffusion-v1-5`
- a single checkpoint file you downloaded, e.g. `BASE_MODEL=C:\models\my-model.safetensors`
  (add `BASE_MODEL_ARCH=sdxl` or `sd15` if the app guesses the type wrong)

Trained models only work with the base model they were trained on. If you change `BASE_MODEL`, retrain.

**No content filter:** the Stable Diffusion safety checker is removed and nothing is sent to an online service.
What you make is your responsibility. Only train on pictures you have the right to use, and don't make pictures of real people without their consent.

### Settings (`.env`)

| Setting | Default | What it does |
| --- | --- | --- |
| `BASE_MODEL` | SDXL base 1.0 | The model to start from (see above). |
| `BASE_MODEL_ARCH` | auto | `sdxl` or `sd15`, only for single-file checkpoints. |
| `TRAINING_STEPS` | `1000` | More steps learn your pictures more strongly but take longer. |
| `GENERATION_STEPS` | `30` | More steps add detail but each picture is slower. |
| `LOW_VRAM` | auto | `1` keeps parts of the model in normal memory while making pictures. Turns on automatically for cards under 10 GB. |
| `PYTHON` | `.venv` | Which Python to use. |
| `APP_PASSWORD` | | Password needed to open the app. Recommended when using your phone. |
| `PORT` | `3000` | Port for the web server. |
| `DEMO_MODE` | | `1` = fake images, no AI. |
| `DATA_DIR` | `./data` | Where your pictures, trained models and ratings are saved. |

### Windows and newer NVIDIA cards

On Windows, `npm run setup` installs the CUDA 12.4 build of PyTorch. For RTX 50-series cards, run
`set TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128` (PowerShell: `$env:TORCH_INDEX_URL="..."`) first.

## Tips for good results

- Use clear, sharp pictures. Avoid blurry, tiny or heavily filtered ones.
- Vary the pictures: different angles, backgrounds and lighting. If every picture has the same background, the AI will learn the background too.
- For a **subject** (your dog), every picture should show that subject. For a **style** (your drawings), use pictures of different things in that style.
- Each model has a made-up trigger word (like `STYAB12`). The app adds it to your prompt automatically so the AI knows to use what it learned.
- If results look too much like your training pictures, lower `TRAINING_STEPS`. If they don't look enough like them, raise it or add more pictures.

## How it works

- `server.js`: Express server and API (models, uploads, training, generation, ratings).
- `ml/engine.py`: the local AI. `train` fine-tunes a LoRA on the UNet with PyTorch + diffusers + PEFT. `serve` keeps the model loaded and makes pictures.
- `lib/local.js`: runs `engine.py` from Node and passes progress and errors to the page. Only one model trains at a time, and the image worker is paused during training to free graphics memory.
- `lib/demo.js`: the fake engine used in demo mode.
- `lib/auth.js`: the optional password. `lib/network.js`: finds the addresses your phone can use.
- `lib/store.js`: saves everything to `data/db.json`. Pictures and trained LoRAs are saved in `data/projects/<id>/`.
- `public/`: the web page (plain HTML, CSS and JavaScript).

Run the tests with `npm test`.
