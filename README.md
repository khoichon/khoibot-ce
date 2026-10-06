# khoibotv4 - Community Edition

## Setup instructions

1. Go to `detoxify/` and uvicorn the API shown there. (Optional, for moderation) (configurable in `moderation.js`)
2. Clone [This repository](https://github.com/roowus/Jetphotos-API) and run it, port should be 8787 (configurable in `index.js`)
3. Optionally, have Ollama running. By default, uses `qwen3:8b`. Feel free to change this (configurable in `aitools.js`)
   (Optional) If you have a desktop running Ollama, set `USE_DESKTOP_AI=1` and `DESKTOP_AI_HOST=http://<desktop ip>:11434`. It tries the desktop first and falls back to the local Ollama if the desktop is off. Off by default. `DESKTOP_AI_MODEL` and `LOCAL_AI_MODEL` set the model used on each side (both default to `qwen3:8b`). The desktop model does not think by default, set `DESKTOP_AI_THINK=1` to turn it back on.
4. Just run the code. Do not use `npm run dev` (use `npm start` instead). Doing so will clash with my existing development environment.

## Storage

The bot's persisted data (trusted users, enabled groups, per-group settings) lives in one config document that can be stored in any supported backend. Pick one with `STORAGE_BACKEND` and `STORAGE_URL` in `.env`:

| Backend | `STORAGE_BACKEND` | `STORAGE_URL` example | Driver |
|---|---|---|---|
| JSON file (default) | `file` | *(none needed; optional path or `file:///...`)* | built-in |
| MySQL | `mysql` | `mysql://user:pass@localhost:3306/khoibot` | `mysql2` |
| MariaDB | `mariadb` | `mariadb://user:pass@localhost:3306/khoibot` | `mysql2` |
| Redis | `redis` | `redis://localhost:6379/0` (`rediss://` for TLS) | `ioredis` |
| Postgres | `postgres` | `postgres://user:pass@host:5432/postgres` | `pg` |
| Supabase | `supabase` | connection string from *Project Settings → Database* | `pg` |

The SQL backends create their table automatically on startup; no manual schema setup. Redis keys live under a `khoibot:v1` prefix (configurable with `STORAGE_REDIS_PREFIX`).

### Moving data between backends

`npm run migrate` (or `node storage/migrate.js`) transfers the config between any two backends, verifying the copy afterwards:

```
node storage/migrate.js --from file --to mysql --to-url mysql://user:pass@localhost:3306/khoibot --yes
node storage/migrate.js --from redis --from-url redis://localhost:6379/0 --to supabase --to-url postgres://...
```

`--from` defaults to `file`; omitted URLs fall back to `STORAGE_URL`. The destination is fully **replaced**, so a non-empty one asks for confirmation (or pass `--yes`). `--dry-run` previews the transfer without writing. A plain file backup: `node storage/migrate.js --from file --to file --to-url backup.json --yes`.

## Group games

- `!decrypt` starts a word game.
- `!math` starts an arithmetic game.
- `!tournament create [points]` creates a tournament; the creator is entered automatically.
- Players join with `!tournament join`. The creator starts it with `!tournament start [decrypt|math]` (defaults to `decrypt`).
- Use `!tournament status` to view scores or `!tournament cancel` to end the tournament.

### Extra games (opt-in)

Set `ENABLE_EXTRA_GAMES=1` in `.env` to turn these on. They are off by default, and with the flag off the bot behaves as before. The games live in `games.js`, together with decrypt, math and tournaments. Like the other games they respect the per-group games setting, and only one game runs in a group at a time.

- `!coin` flips a coin.
- `!roll [sides]` or `!roll <count>d<sides>` rolls dice (1-20 dice, 2-1000 sides).
- `!rps <rock|paper|scissors>` plays rock paper scissors against the bot (`r`, `p` and `s` work too).
- `!ttt` opens a tic-tac-toe lobby, a second player joins with `!ttt join`, then players send a square number from 1 to 9. `!ttt cancel` ends it.
- `!numguess [max]` picks a number (1-100 by default) and everyone guesses by sending plain numbers. The bot answers higher or lower.
- `!wordle` starts a shared 5-letter wordle with 6 guesses. Guess with `!wordle <word>`. Guesses are not checked against a dictionary.
- `!anagram` scrambles a word and the first person to send it unscrambled wins. `!anagram skip` gives up.

Wordle and anagram get their words from the same random word API as decrypt. Every extra game has a time limit: tic-tac-toe 3 minutes (the lobby closes after 1 minute if nobody joins), wordle 3 minutes and anagram 90 seconds. Number guessing ends after 90 seconds in total, or after 45 seconds without a guess.

*meow*