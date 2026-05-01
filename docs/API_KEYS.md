# API Keys

jafo uses two paid APIs. Both have free tiers / generous trial credits — you can run for weeks before owing anything.

## Groq (Whisper transcription)

1. Sign up at [console.groq.com](https://console.groq.com)
2. Go to API Keys → Create API Key
3. Copy the key (starts with `gsk_...`)
4. Paste into `~/jafo/.env` as `GROQ_API_KEY=gsk_...`

**Cost:** `whisper-large-v3-turbo` is $0.04 per hour of audio.
At ~24 minutes of audio per day (300 calls × 5 sec average), that's **~$0.50/month**.

## Anthropic (Claude Haiku enrichment)

1. Sign up at [console.anthropic.com](https://console.anthropic.com)
2. Settings → API Keys → Create Key
3. Copy the key (starts with `sk-ant-...`)
4. Paste into `~/jafo/.env` as `ANTHROPIC_API_KEY=sk-ant-...`

**Cost:** Haiku 4.5 is ~$0.80/M input tokens, $4/M output tokens.
Each call: ~600 input + 200 output tokens. At 300 calls/day:
- Input: ~5.4M tokens/month → ~$4
- Output: ~1.8M tokens/month → ~$7
- Subtotal: **~$11/month** (and many will be filtered to "radio_chatter" by the shortcut, dropping the real cost lower)

## After adding keys

Edit `.env`:
```bash
nano ~/jafo/.env
```

Restart the workers:
```bash
sudo systemctl restart jafo-transcriber jafo-enricher
```

Watch the logs to confirm:
```bash
sudo journalctl -u jafo-transcriber -f
sudo journalctl -u jafo-enricher -f
```

The first transcript should appear within 30 seconds of the next captured call.

## If you don't add keys

The system still works — you just won't get transcripts or structured incidents. The capture pipeline runs fine, calls are stored as Opus, and the web UI shows them with placeholder text ("Awaiting transcription..."). You can add keys at any time and the workers will catch up on the backlog.

## Cost protection

Both providers let you set hard spending limits in their dashboards. Recommended:
- Groq: $5/month limit
- Anthropic: $20/month limit

These are generous ceilings — at this volume you'll never hit them — but they protect you from runaway costs if something goes wrong (e.g. a misconfigured talkgroup whitelist letting through 10x the expected traffic).
