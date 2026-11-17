# khoibotv4 - Community Edition

## Getting it running

1. (Optional, for moderation) Go to `detoxify/` and uvicorn the API there. The address can be changed in `moderation.js`. It loads the multilingual Detoxify model by default. Set `BADWORD_MODEL=textdetox` to use the textdetox model instead, which handles Chinese and Japanese better but needs more memory and is a little slower.
2. Clone [This repository](https://github.com/roowus/Jetphotos-API) and run it. It should be on port 8787, which can be changed in `index.js`.
3. (Optional) Run Ollama for the AI features. It uses `qwen3:8b` by default, and you can swap that in `aitools.js`. If you have a desktop running Ollama, set `USE_DESKTOP_AI=1` and `DESKTOP_AI_HOST=http://<desktop ip>:11434`, and it'll try the desktop first and fall back to the local one when the desktop is off. `DESKTOP_AI_MODEL`, `LOCAL_AI_MODEL` and `DESKTOP_AI_THINK` tune that side of things.
4. Just run the code with `npm start`. Please don't use `npm run dev`, it clashes with my own development setup.

Most of what's below is optional. Each feature has a flag in `.env` and stays off until you set it to `1`, apart from a few of the logging ones that work the other way round. `.env.example` lists the lot, along with the numbers you can tweak.

## Storage

Trusted users, enabled groups and per-group settings all live in one config document. It's a plain JSON file by default, but it can be in a database instead. Pick one with `STORAGE_BACKEND` and `STORAGE_URL` in `.env`:

| Backend | `STORAGE_BACKEND` | `STORAGE_URL` example | Driver |
|---|---|---|---|
| JSON file (default) | `file` | not needed, or a path | built-in |
| MySQL / MariaDB | `mysql`, `mariadb` | `mysql://user:pass@localhost:3306/khoibot` | `mysql2` |
| Redis | `redis` | `redis://localhost:6379/0` (`rediss://` for TLS) | `ioredis` |
| Postgres / Supabase | `postgres`, `supabase` | `postgres://user:pass@host:5432/postgres` (Supabase gives you one under *Project Settings → Database*) | `pg` |

The SQL backends make their own table on startup, so there's no schema to set up, and Redis keys go under the `khoibot:v1` prefix (`STORAGE_REDIS_PREFIX` changes it). `npm run migrate` (or `node storage/migrate.js`) copies the config between any two backends and checks it afterwards:

```
node storage/migrate.js --from file --to mysql --to-url mysql://user:pass@localhost:3306/khoibot --yes
node storage/migrate.js --from redis --from-url redis://localhost:6379/0 --to supabase --to-url postgres://...
```

`--from` defaults to `file`, and a missing URL falls back to `STORAGE_URL`. The destination gets completely replaced, so the script asks first unless you pass `--yes`, and `--dry-run` shows what would happen without writing. A plain backup is just a file to file copy.

## Link blocker

Turn it on in a group with `!mod disablelinking true`, and the bot deletes every message that contains a link. A link is anything that looks like a website, such as `apple.com` or `www.apple.com/page`, and the bot does a DNS lookup to check that the domain really exists, so something like `index.js` is left alone. If the DNS servers don't answer, anything that looks like a website gets deleted anyway. The bot needs to be a group admin to delete messages, and it says so in the log when it isn't. After each deletion it replies with a short notice, and `!mod disablelinkingnosay true` does the same thing without the bot saying anything in the chat.

By default every link is blocked. `!mod linkwhitelist add <domain>` makes exceptions that are never blocked, and `!mod linkblocklist add <domain>` switches to blocking only the domains on that list, with the whitelist still winning. Both lists also take `remove` and `clear`, and run on their own they show the list. Subdomains count as the main domain, so `apple.com` also covers `music.apple.com`. Group admins and trusted users can post links unless you turn that off with `!mod linkexempt false`, although their own `!mod` commands always go through.

## Summaries

- `!summarise <text>` summarises some text, and replying to a message with `!summarise` summarises that message. `!summarise <number>` summarises the last that many messages in a group, up to 200. The bot only knows about messages sent while it was running, and it keeps them in `chatlog-state.json` so a restart doesn't wipe them. Commands aren't saved.

## Image generation

- `!ai imagine <description>` draws a picture and sends it back with the description as the caption. The bot can't do this itself, since a Raspberry Pi would take ages, so it asks Stable Diffusion WebUI running on your desktop, which has to be started with the `--api` flag. Put `ENABLE_AI_IMAGINE=1` and `DESKTOP_IMAGINE_HOST` in `.env`. `IMAGINE_STEPS`, `IMAGINE_WIDTH` and `IMAGINE_HEIGHT` are optional.
- Options go after the description, for example `!ai imagine a cat astronaut -style anime -size wide`. The styles are anime, photo, watercolor, pixel, oil, sketch, cartoon and 3d. The sizes are wide, tall and square, and square uses the default from `.env`. The caption shows what was picked.
- It is off in every chat to begin with. A trusted user turns it on or off for a chat with `!ai imagine toggle`, and the choice is saved. Only one picture is made at a time, descriptions can be up to 300 characters, and the bot says so if the desktop is switched off.
- The bot adds a negative prompt that steers away from nudity and gore, but that is only a nudge and not a real filter, so only turn it on in chats you trust.

## Stories

- `!ai story <idea>` writes a short story with a twist, for example `!ai story <prompt>`. It uses the same model as `!ai` chat, so with `USE_DESKTOP_AI=1` it runs on the desktop and otherwise on the Pi. The idea can be up to 200 characters, and the story doesn't touch the chat memory.

## Choosing the AI model

`!ai model <name>` picks which model a chat uses, and `!ai <name> <prompt>` uses one for a single prompt. `!ai model default` goes back to the model from `DESKTOP_AI_MODEL` and `LOCAL_AI_MODEL`. The names and models come from `AI_MODELS` in `.env`, written as `name=desktop model|local model` with commas between names, for example `AI_MODELS=qwen=qwen3:14b|qwen3:1.7b,llama=llama3.1:8b|llama3.2:1b`. The first model is used when the desktop answers and the second when the Pi does. If you give only one model it is used for both. Every model has to be pulled with `ollama pull` on the machine that will use it. (important!!!) The names `model`, `default`, `reset`, `personality`, `story` and `imagine` are taken. Without `AI_MODELS` the bot offers qwen, llama and gemma.

A group admin can switch the AI off for one chat with `!mod toggleai false`, and back on with `!mod toggleai true`. `!mod toggleai` on its own flips whatever it is now. It covers `!ai` and all of its subcommands, and it is on by default.

The bot also tells the model who is asking and, in a group, roughly what the last few messages were about, so `!ai` can follow the conversation instead of answering each question cold.

## Personality presets

`!ai personality preset <name>` sets a ready made personality for the chat, for example `!ai personality preset pirate`. `!ai personality preset` lists the names, which are auntie, caveman, detective, drunk, edgy, grandma, kdrama, pirate, rapper, robot, shakespeare, singlish, tigermum and yoda. A preset is saved and cleared the same way as a custom personality, with `!ai personality reset`. The edgy preset swears and makes crude jokes, so only use it in chats where that is fine. *cough* The drunk preset garbles every answer in code, and sometimes the bot just burps instead of answering.

`!mod drunkmode true` makes every text reply the bot sends in that chat come out drunk, and `!mod drunkmode false` sobers it up again. `!mod drunkmode` on its own flips it. `!drunkify <text>` does the same garbling to any text you give it.

## Games

- `!decrypt` starts a word game and `!math [easy|medium|hard|impossible|asian]` an arithmetic and algebra one (the difficulty is random if you leave it out, and impossible and asian only happen  up when you ask for it). Both are saved in `games-state.json`, so a restart doesn't wipe them.
- `!math cancel` ends the game, and only whoever started it or a trusted user can do that. There is a cooldown between `!math` games in a group, 20 seconds by default, and you can change it with `MATH_COOLDOWN_SECONDS` in `.env` (0 turns it off). A game also ends by itself if nobody gets it in time: 60 seconds for easy, 90 for medium, 2 minutes for hard, 3 for impossible and 5 for asian. >:D
- Hints are limited to 2 per game. The first one only works after a short wait from when the game starts, and each one after that waits a bit since the last hint. Both waits are 30 seconds by default, and you can change them with `HINT_START_DELAY_SECONDS` and `HINT_COOLDOWN_SECONDS` in `.env` (0 turns a wait off).
- `!tournament create [points]` opens a tournament and enters you automatically. Others join with `!tournament join`, and the creator starts it with `!tournament start [decrypt|math]` (decrypt is the default). `!tournament status` shows the scores and `!tournament cancel` ends it.

### Extra games (opt-in)

These live in `games.js` too and need `ENABLE_EXTRA_GAMES=1`. Like the games above they follow the per-group games setting, and tic-tac-toe, chess, blackjack and hot potato only hold up the people playing them. Every other game holds up the whole group, and so do tournaments, and a group can't run two of the same game at once.

- `!coin` flips a coin, `!roll [sides]` or `!roll <count>d<sides>` rolls dice, and `!rps <rock|paper|scissors>` plays against the bot (`r`, `p` and `s` work too).
- `!ttt` opens a tic-tac-toe lobby. A second player joins with `!ttt join`, and then you take turns sending a square from 1 to 9. `!ttt cancel` ends it.
- `!numguess [max]` picks a number (up to 100 by default) and everyone guesses by sending plain numbers, with the bot saying higher or lower. `!wordle` starts a shared 5 letter wordle with 6 guesses, and `!anagram` scrambles a word for the first person to unscramble. All three take `hint`, and anagram takes `skip`.
- `!hotpotato` starts a hot potato with a random fuse of 20 to 40 seconds. Pass it on with `!pass @user` (plain `!pass` hands it back). Whoever's holding it when it blows up loses, and `!hotpotato cancel` ends it early.
- `!blackjack` deals a round of blackjack against the bot to whoever started it, who then replies `hit` or `stand`. The dealer stands on 17. `!slots` spins three reels once and tells you how you did, and `!wordchain` has everyone take turns saying a word that starts with the last letter of the one before, with no repeats and no going twice in a row. It ends when the group goes quiet for a minute. Blackjack and wordchain both take `cancel`, and neither is saved across a restart. Blackjack and slots count as casino games, so they also need `!mod casinoenabled true` in that group (it's off by default, and `gamesenabled` still has to be on).
- `!chess` opens a chess lobby and `!chess join` takes the other side, with colours picked at random. `!chess ai [easy|medium|hard] [white|black]` plays the bot instead, and in a DM `!chess` starts a game against the bot straight away. Moves are plain messages like `e4` or `Nf3`, and the board comes back as a picture after every move. `!chess board` sends it again, `!chess resign` gives up, `!chess draw` offers a draw (the bot accepts when it isn't ahead on material) and `!chess cancel` ends the game. A lobby nobody joins closes after 2 minutes, and a game nobody moves in after 10. Set `STOCKFISH_PATH` in `.env` to let Stockfish pick the bot's moves, otherwise a small built-in engine plays.

Wordle and anagram pull their words from the same random word API as decrypt, and every word gets checked against a dictionary first. With the desktop AI on, hints reword that dictionary definition. Wordle, anagram and numguess are saved like the games above, so they survive a restart. The rest time out on their own, 3 minutes at the most.

## Extra commands (opt-in)

Everything here lives in `extras.js` and is switched on with `ENABLE_EXTRA_COMMANDS=1`. The small ones first:

- `!fact` and `!joke` send a random one, `!define <word>` looks up a definition, and `!wiki <query>` sends a Wikipedia summary.
- `!roast` and `!compliment` write a short, friendly roast or compliment with the AI, and use some built-in lines when it cannot be reached. They take a mention, a reply or any text you type (up to 100 characters), like `!roast @user` or `!compliment my cat`. With nothing after them they are about whoever sent the command.
- `!translate <language> <text>` translates the text, where the language is a name like `french` or a code like `fr`, and `!quote <text>` quotes it and mentions you. Both of those work as a reply to a message instead.

Stickers and images, which is most of what gets used:

- `!tts [font] <text>` draws the text on a sticker, or reply to a message with it. Options are `-bg <colour>`, `-clr <colour>`, `-size <number>`, `-anim <style>` and `-var <axis=value,...>`. Colours can be a hex code, a basic name, or two separated by a comma for a gradient. Run `!tts` on its own to see the fonts. Animation styles are `wave`, `bounce`, `glitch`, `typewriter`, `neon`, `spin` and `appear`. Text is drawn with fontkit, so run `npm install` after pulling.
- `!sticker` turns an image into a sticker (reply to it, or use it as the caption), and `!animsticker` does the same for a video or gif. That one needs `ffmpeg` on the machine (`sudo apt install ffmpeg`), cuts videos to 8 seconds, and refuses anything over 20 MB. `!animsticker add` collects 2 to 8 images for a slideshow and `!animsticker done` builds it. Only one animated sticker gets made at a time, the Pi can't cope with two.
- `!edit` edits an image or sticker. Points are `x,y` on a 512x512 sticker with (0,0) at the top left, and several points are joined with `;`. The operations are `crop`, `cut`, `draw` and `text`, and you can chain them with `|`, for example `!edit crop 10,10;500,10;250,500 | text 256,470 hi`. `!edit grid` sends the picture back with a grid so you can find your points, and `!edit` alone shows the full help.

The rest are for managing a group. Trusted users and group admins only, and the bot needs to be an admin for most of them.

- `!mute [duration]` and `!unmute` lock the group so only admins can talk. A duration like `2h`, `120min` or `1h30min` unmutes it again on its own (anything from 1 minute to 30 days).
- `!ban [@user | number] [duration]` and `!unban` make the bot ignore someone in that group. You can mention them, reply to them, or give a phone number, and the duration works like it does for `!mute`. Trusted users can't be banned.
- `!execute <@user | number>` kicks someone out of the group, but it can not remove other admins. Trusted users can also add someone with `!special addmember <number>`, which works in the group you run it in (country code first, like `!special addmember 6591234567`).
- `!automute <once|all> <HH:MM>` and `!autounmute` mute and unmute the group on a schedule, where `once` runs one time and `all` runs every day. `!automute off` cancels it, and running the command with nothing after it shows the schedule. Times follow `EXTRA_TIMEZONE` (Asia/Singapore by default), and the schedules are kept in `extras-state.json`, though one only fires if the bot is running at that exact minute.
- `!warn <@user | number> [reason]` gives someone a warning (you can also reply to them, and put a number before the reason to give that many at once, like `!warn @user 2 spamming`), `!unwarn <@user | number>` takes the newest one off (add `all` to clear them all), and `!warnings` lists everyone with warnings, or `!warnings <@user | number>` shows one person with the reason for each warning. Trusted users and group admins can't be warned. What happens is set per group with `!mod`: `warntoggle` turns the commands on or off (on by default), `warnlimit` is how many warnings it takes (1 to 20, 3 by default), `warnaction` is `notify` (the default, the bot only says so), `kick`, or `ban [duration]` (a time like `2h`, or `0` or nothing for a ban with no end), which can be mixed freely (like `!mod warnaction kick ban 2h`), and `warnexpiry` makes warnings run out after that many days (0 means they never expire). Warnings are kept in `extras-state.json`.

The bot can also warn people by itself when their messages keep getting deleted for cursing. `!mod warncurses <number>` is how many deleted messages it takes (0 turns it off), and `!mod warncursestime <minutes>` is how long the count lasts (1 to 60). The count is per person, starts at their first deleted message, and goes back to 0 when the time is up. Once it goes past the number they get a warning, and then another for each further deleted message in the same window. It works like `!warn`, so it counts toward `warnlimit` and trusted users and admins are skipped. It needs `ENABLE_EXTRA_COMMANDS=1` and the bot has to be a group admin, since it only counts messages it really deleted. The starting numbers for every group come from `WARN_CURSES_DEFAULT` and `WARN_CURSES_TIME_DEFAULT` in `.env` (5 and 5 if they aren't set), and the counts are forgotten when the bot restarts.

`!mod warntrusted <true/false>` decides whether trusted users and group admins can be warned at all. It is on by default, and even then a warning never kicks or bans them. Setting it to false means warnings skip them entirely.

`!mod menudeletetime <0 or 15-60>` makes the bot delete its own menu again after that many seconds, so long menus don't sit in the chat. 0 leaves the menu alone.

`!mod enablehelpmenu <true|false>` turns the help menu on for a chat. It's off by default, and while it's off `!help` just does its old jokee. With it on, `!help` lists the categories and `!help <category>` lists the commands in one. The categories are ai, games, utils, moderation and trusted, and people only see the categories and commands they're allowed to use.

## Welcome messages

`!mod welcomeMsgEnabled true` greets people when they join, and `!mod welcomeMsg <text>` sets what it says. `[user]` in the text is replaced with a mention of the person who joined.

When two or more people are added in one go the bot sends a single combined message with `[user]` replaced by "new members" instead of tagging each person, so adding a dozen people doesn't flood the group.

## Bad word filter

`!mod antibadword true` turns the filter on for a group. Every ordinary message is scored by a local moderation service and anything that comes back toxic is deleted, as long as the bot is an admin. Commands starting with `!` are skipped. `!mod antibadwordnosay true` does the same but never says anything in the chat, and `!mod antibadwordreport true` adds a line telling people to contact an admin if they think it was a mistake.

`!mod badwordlog <silent|info|debug>` sets how much the bot says when it deletes something. `silent` just asks them to be nice, `info` adds the toxicity score, and `debug` lists every score the model returned.

The service lives in `detoxify/` and runs on its own, so auto deploy does not restart it. `BADWORD_MODEL` picks the model: `detoxify` is the default and lighter, `textdetox` is better at Chinese and Japanese but wants more RAM, and `auto` loads both and picks per message: normal Latin text goes to the English detoxify model, which copes much better with slang, and anything in another script goes to textdetox. Short messages are held to a higher bar than long ones, because the multilingual models flag one or two words far too easily, and `BADWORD_SHORT_THRESHOLD` (0.98 by default) sets that bar.

### Pictures (opt-in)

With `BADWORD_VISION=1` set for both the moderation service and the bot, the two settings above also cover images, stickers, view-once media and the preview frame of videos and GIFs. Each picture is checked for explicit content, and any text inside it is read and scored like a normal message, so a rude meme is caught even with no caption. A flagged picture is deleted and counts towards a warning, exactly like a flagged message.

`BADWORD_NSFW_THRESHOLD` (0.85 by default) sets how sure the model has to be before a picture counts as explicit. Verdicts are remembered per picture, so the same sticker sent twice doesn't bother the service twice, and if the service is down or busy the media is simply left alone.

## Trusted only mode

`!mod trustedonly true` makes the bot ignore everyone in that group except trusted users and group admins. It is off by default, it only applies in groups, and the group still has to be switched on for the bot to answer at all. Moderation (the badword check and the link blocker) keeps running for everyone, and `!mod trustedonly false` lets everybody back in.

## Direct messages

Commands are off in DMs by default, so the bot ignores everyone except trusted users. A trusted user turns them on for one person with `!mod dmtoggle <number>`, from any chat. Use the full number with the country code, like `6591234567`. Running it again turns them off. If a DM stays silent after you switch it on, WhatsApp may be showing that chat under a hidden ID instead of the phone number.

## Force banned numbers

A phone number can be force banned so that it can never use the bot, in any chat, including private messages. Commands and game answers from that number are ignored without any reply. Moderation such as the anti-badword filter still applies to them in groups. Trusted users can't be force banned.

There are two ways to set the numbers. The first is the `FORCE_BANNED` variable in `.env`, with the numbers separated by commas. Each number needs the country code and digits only, for example `FORCE_BANNED=6512345678,6587654321`. This is read when the bot starts and it works even when the extra commands are turned off.

The second is from chat, using `!special forceban` (trusted users only):

- `!special forceban add <number>` force bans a number.
- `!special forceban remove <number>` removes a number that was added from chat.
- `!special forceban list` shows every force banned number.

Numbers added from chat are saved in `extras-state.json`. Numbers from `.env` can only be removed by editing `FORCE_BANNED` there. Matching is done by phone number, so it can miss someone whose number WhatsApp doesn't share with the bot.

## Anti-ban protections (opt-in)

`ENABLE_ANTIBAN=1` switches on the protections below. They're in `antiban.js`, and every number here can be changed in `.env`.

- Before each message the bot shows the typing indicator and waits a random 1 to 3 seconds. It sends at most 20 messages a minute and 300 an hour, and a message that waits more than 2 minutes for room gets dropped.
- Each person has to wait 3 seconds between commands, or 10 between heavy ones, and anything sent too soon is ignored. `!plot`, `!pfp`, `!whoami` and `!animsticker` have their own longer cooldowns. Trusted users are exempt from the general cooldown. On top of that, `!pfp` lookups are capped at 30 an hour across everyone, and `!plot` takes at most 10 expressions and 500 characters, because a huge plot can freeze the bot.
- `!slots` and `!blackjack` share one cooldown, and trusted users set it with `!antiban casinocooldown <seconds>`. It defaults to 5 seconds and accepts 0 to 60.
- Messages older than 60 seconds are ignored, so a reconnect doesn't set off a flood of replies. The bot also waits longer after every failed reconnect, up to 5 minutes. If the connection closes mid-send it just carries on.

Trusted users can change things on the fly, and the changes are kept in `antiban-state.json`:

- `!antiban` shows the status, `!antiban banrisk` shows just the ban risk, and `!antiban perminute <n>`, `!antiban perhour <n>` and `!antiban reset` change the rate limits.
- `!messagedelay set <min> <max>` changes the delay, `set 0 0` turns it off, and `!messagedelay reset` restores the default. `!messagecooldown <normal> <heavy>` changes the cooldowns, and `!messagecooldown on` or `off` switches them. `!plot`, `!pfp`, `!whoami` and `!animsticker` each take `setcooldown <seconds>` of their own.
- `!bot on` and `!bot off` stop or resume all sending, and while it's off, commands from other users are ignored.

### Anti-ban plus (opt-in)

Three more protections, on top of the ones above. Needs `ENABLE_ANTIBAN_PLUS=1` as well as `ENABLE_ANTIBAN=1`, since it builds on them.

- If the bot repeats the same text in the same chat within 10 minutes, it makes small changes so the two messages are never identical. Messages with mentions or links are left alone.
- Disconnects, 403s and failed sends raise a ban risk score from 0 to 100, based on the last hour. At 30 the bot slows to half speed, at 60 only replies to commands go out, and at 85 nothing goes out. The score cools down by itself, and `!antiban` shows it.
- Each chat gets its own queue, with replies to commands going first. A message that fails to send is retried up to 2 times, unless the connection closed or WhatsApp answered with a 403.

## Better console logging (opt-in)

If you'd like tidier console output, set `ENABLE_BETTER_LOGGING=1`. Each line gets a timestamp, a level and a tag, like `[03/10/26 14:05:09] [INFO] [conn] Opened connection.`, and incoming messages look like `[03/10/26 14:05:09] +6591234567 (Maxwell) <GRP: group name> hello`, with `<DM>` for direct messages. Long messages are shortened, and errors show the first three lines of the stack trace. Colours only show up when the output goes to a terminal. Under PM2, set `FORCE_COLOR=1` to keep them in the logs, or `NO_COLOR=1` to turn them off. You can also hide parts of each line by setting any of these to `0`: `ENABLE_SHOW_PH` (shows the LID instead of the phone number), `ENABLE_SHOW_GRP` (hides the group name), `ENABLE_SHOW_NAME` (hides the name in brackets) and `ENABLE_SHOW_MESSAGE` (hides the message text).

## Auto deploy (opt-in)

With `ENABLE_AUTO_DEPLOY=1` the bot updates itself. Every 2 minutes, or whatever `AUTO_DEPLOY_MINUTES` says, it checks GitHub for new commits. When there are some, it pulls them, runs `npm install` if the dependencies changed, saves any running games, runs `pm2 save` and exits (that save is skipped when the bot isn't under PM2, and if it fails the bot just logs it and restarts anyway). PM2 brings it straight back up, so a push to `main` goes live without anyone touching the Pi. Setting it up takes three things: a `git pull` by hand with credentials that don't prompt, `git branch --set-upstream-to=origin/main main` so the bot knows which branch to follow, and the flag in `.env` followed by `pm2 restart khoibot`. Worth remembering that a broken push goes live too, so check things before pushing. If a pull fails, usually because of local edits on the Pi, the bot logs one error and skips that commit until a newer one arrives.

*meow*
*meow meowww*
