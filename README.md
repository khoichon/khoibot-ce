# khoibotv4 - Community Edition

## Setup instructions

1. Go to `detoxify/` and uvicorn the API shown there. (Optional, for moderation) (configurable in `moderation.js`)
2. Clone [This repository](https://github.com/roowus/Jetphotos-API) and run it, port should be 8787 (configurable in `index.js`)
3. Optionally, have Ollama running. By default, uses `qwen3:8b`. Feel free to change this (configurable in `aitools.js`)

4. Set the same `BADWORD_API_KEY` in the process environments of the bot and moderation API.
5. Start the bot with `npm start`. The bot creates local `bot-config.json` and stores WhatsApp pairing state in `auth/`; both are ignored by Git. After removing `auth/`, pair the bot again.

## Features

Refer to [the documentation](https://khoichon.dev/khoibot-docs) for more information.

*meow*