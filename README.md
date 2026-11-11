# Style Trainer

Teach an AI what you like, then make new pictures with it.

1. **Upload good pictures** of what you want: a person, a pet, an object, or an art style. 10–20 works best.
2. **Train.** The AI fine-tunes an image model (FLUX + LoRA) on your pictures.
3. **Type a prompt.** You get new pictures based on what it learned, e.g. *"sitting on a beach at sunset, oil painting"*.
4. **Rate each picture out of 10.** The app shows your average score and how your ratings are spread out, and can sort the gallery by best or worst.
   Pictures you rate **8 or higher** can be added back to the training set. Retrain to make the model even better.

## Run it

You need [Node.js](https://nodejs.org) 20.12 or newer.

```bash
npm install
npm start
```

Then open http://localhost:3000.

### Demo mode (free)

If you don't set an API token, the app runs in **demo mode**. Training finishes in a few seconds and the "generated" pictures are placeholder art.
Use it to try out the app before you pay for anything.

### Real AI pictures

Training an image model needs a powerful GPU, so this app rents one from [Replicate](https://replicate.com):

1. Create a Replicate account and get an API token at https://replicate.com/account/api-tokens.
2. Copy `.env.example` to `.env` and paste your token:
   ```
   REPLICATE_API_TOKEN=r8_your_token_here
   ```
3. Restart with `npm start`. The badge in the top right should say **Connected to Replicate**.

**Cost (approximate, check Replicate's pricing):** a training run usually takes 15–30 minutes and costs a couple of dollars.
Each generated picture costs a few cents. Your trained models are saved as **private** models on your Replicate account.

#### Settings (`.env`)

| Setting | Default | What it does |
| --- | --- | --- |
| `REPLICATE_API_TOKEN` | *(empty)* | Your Replicate token. Empty = demo mode. |
| `REPLICATE_TRAINER` | `ostris/flux-dev-lora-trainer` | The model used for training. |
| `TRAINING_STEPS` | `1000` | More steps learn your pictures more strongly but take longer and cost more. |
| `PORT` | `3000` | Port for the web server. |
| `DEMO_MODE` | | Set to `1` to force demo mode even with a token. |
| `DATA_DIR` | `./data` | Where your pictures, generated images and ratings are saved. |

## Tips for good results

- Use clear, sharp pictures. Avoid blurry, tiny or heavily filtered ones.
- Vary the pictures: different angles, backgrounds and lighting. If every picture has the same background, the AI will learn the background too.
- For a **subject** (your dog), every picture should show that subject. For a **style** (your drawings), use pictures of different things in that style.
- Each model has a made-up trigger word (like `STYAB12`). The app adds it to your prompt automatically so the AI knows to use what it learned.

## How it works

- `server.js`: Express server and API (models, uploads, training, generation, ratings).
- `lib/replicate.js`: zips your pictures, uploads them to Replicate, starts a FLUX LoRA training run, then generates images with the trained version.
- `lib/demo.js`: the fake provider used in demo mode.
- `lib/store.js`: saves everything to `data/db.json`. Images are saved in `data/projects/<id>/`.
- `public/`: the web page (plain HTML, CSS and JavaScript).

Run the tests with `npm test`.
