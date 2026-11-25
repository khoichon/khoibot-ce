// the !help menu. it only shows up in chats where !mod enablehelpmeu is true,
// otherwise !help keeps doing the old txte. the menu is split into categories, !help lists them
// and !help <category> lists the commands inside one.
//
// every category (and every command) has a level so people only see what they can actually use:
//   "all"     everyone can see
//   "admin"   group admins and trusted users only 
//   "trusted" trusted users only 

const DASH = "\u2010";

const CATEGORIES = [
    {
        name: "ai",
        level: "all",
        commands: [
            { name: "ai", level: "all" },
            { name: "summarise", level: "all" },
        ],
    },
    {
        name: "games",
        level: "all",
        commands: [
            { name: "blackjack", level: "all" },
            { name: "slots", level: "all" },
            { name: "chess", level: "all" },
            { name: "ttt", level: "all" },
            { name: "connect4", level: "all" },
            { name: "rps", level: "all" },
            { name: "wordle", level: "all" },
            { name: "wordchain", level: "all" },
            { name: "numguess", level: "all" },
            { name: "anagram", level: "all" },
            { name: "decrypt", level: "all" },
            { name: "math", level: "all" },
            { name: "hotpotato", level: "all" },
            { name: "minesweeper", level: "all" },
            { name: "crossword", level: "all" },
            { name: "pass", level: "all" },
            { name: "tournament", level: "all" },
            { name: "hangman", level: "all" },
            { name: "trivia", level: "all" },
        ],
    },
    {
        name: "utils",
        level: "all",
        commands: [
            { name: "translate", level: "all" },
            { name: "tts", level: "all" },
            { name: "ttscss", level: "all" },
            { name: "edit", level: "all" },
            { name: "coin", level: "all" },
            { name: "roll", level: "all" },
            { name: "joke", level: "all" },
            { name: "fact", level: "all" },
            { name: "quote", level: "all" },
            { name: "roast", level: "all" },
            { name: "compliment", level: "all" },
            { name: "cat", level: "all" },
            { name: "dog", level: "all" },
            { name: "meme", level: "all" },
            { name: "scp", level: "all" },
            { name: "define", level: "all" },
            { name: "wiki", level: "all" },
            { name: "weather", level: "all" },
            { name: "toimage", level: "all" },
            { name: "togif", level: "all" },
            { name: "tomp3", level: "all" },
            { name: "removebg", level: "all" },
            { name: "plane", level: "all" },
            { name: "plot", level: "all" },
            { name: "pfp", level: "all" },
            { name: "whoami", level: "all" },
            { name: "docs", level: "all" },
            { name: "credits", level: "all" },
            { name: "up", level: "all" },
            { name: "down", level: "all" },
            { name: "drunkify", level: "all" },
            { name: "sticker", level: "all" },
            { name: "animsticker", level: "all" },
            { name: "image", level: "all" },
            { name: "pokemon", level: "all" },
            { name: "qr", level: "all" },
            { name: "flight", level: "all" },
            { name: "song", level: "all" },
        ],
    },
    {
        name: "web",
        level: "all",
        commands: [
            { name: "websearch", level: "all" },
            { name: "news", level: "all" },
            { name: "youtube", level: "all" },
            { name: "reddit", level: "all" },
            { name: "hn", level: "all" },
            { name: "gif", level: "all" },
            { name: "read", level: "all" },
            { name: "tldr", level: "all" },
            { name: "expand", level: "all" },
            { name: "redirects", level: "all" },
            { name: "screenshot", level: "all" },
            { name: "archive", level: "all" },
            { name: "isup", level: "all" },
            { name: "pinghost", level: "all" },
            { name: "dns", level: "all" },
            { name: "whois", level: "all" },
            { name: "ip", level: "all" },
            { name: "github", level: "all" },
            { name: "ytinfo", level: "all" },
            { name: "video", level: "all" },
        ],
    },
    {
        name: "moderation",
        level: "admin",
        commands: [
            { name: "warn", level: "admin" },
            { name: "slowmode", level: "admin" },
            { name: "warnings", level: "admin" },
            { name: "unwarn", level: "admin" },
            { name: "ban", level: "admin" },
            { name: "unban", level: "admin" },
            { name: "mute", level: "admin" },
            { name: "unmute", level: "admin" },
            { name: "automute", level: "admin" },
            { name: "autounmute", level: "admin" },
            { name: "execute", level: "admin" },
            { name: "deletemessages", level: "admin" },
            { name: "tag", level: "admin" },
            { name: "mod", level: "admin" },
        ],
    },
    {
        name: "trusted",
        level: "trusted",
        commands: [
            { name: "special", level: "trusted" },
            { name: "blacklist", level: "trusted" },
            { name: "antiban", level: "trusted" },
            { name: "messagedelay", level: "trusted" },
            { name: "messagecooldown", level: "trusted" },
            { name: "bot", level: "trusted" },
        ],
    },
];

// the longer explanation shown by !help <command>. usage lines are written without the prefix,
// buildHelp adds whatever prefix the bot is using. a command with no entry here just says which category it's in
const DETAILS = {
    ai: {
        about: "Chats with the AI. It follows the group's conversation, and can also draw pictures and write short stories. If web search is on for the bot, the start of your question may be sent to its search server.",
        usage: ["ai <prompt>", "ai witt (reply to a picture)", "ai <prompt> -voice [uk, es, fr, ja...]", "ai imagine <description>", "ai story <idea>", "ai personality preset <name>"],
    },
    summarise: {
        about: "Summarises some text, a message you reply to, or the last few messages in the group.",
        usage: ["summarise <text>", "summarise <number>", "summarise (as a reply to a message)"],
    },
    blackjack: {
        about: "A round of blackjack against the bot. Reply hit or stand. Needs casino games turned on in the group.",
        usage: ["blackjack", "blackjack cancel"],
    },
    slots: {
        about: "Your normal slots game.",
        usage: ["slots"],
    },
    chess: {
        about: "Chess against another person or the bot. Send moves as plain messages like e4 or Nf3.",
        usage: ["chess", "chess join", "chess ai [easy|medium|hard]", "chess resign", "chess cancel"],
    },
    ttt: {
        about: "Tic-tac-toe against another person or the bot. Send a square from 1 to 9 to play.",
        usage: ["ttt", "ttt join", "ttt ai", "ttt cancel"],
    },
    connect4: {
        about: "Connect four in a row against another person or the bot. Send a column from 1 to 7 to drop a piece.",
        usage: ["connect4", "connect4 join", "connect4 ai", "connect4 cancel"],
    },
    rps: {
        about: "Rock paper scissors against the bot.",
        usage: ["rps <rock|paper|scissors>"],
    },
    wordle: {
        about: "A shared 5 letter wordle for the whole group, with 6 guesses.",
        usage: ["wordle", "wordle <word>", "wordle hint", "wordle cancel"],
    },
    wordchain: {
        about: "Take turns saying a word that starts with the last letter of the one before.",
        usage: ["wordchain", "wordchain cancel"],
    },
    minesweeper: {
        about: "Clear the board without hitting a mine, or flag every mine correctly. Anyone can play. Send dig b3 to open a square and flag b3 to mark one.",
        usage: ["minesweeper [easy|medium|hard]", "minesweeper cancel"],
    },
    crossword: {
        about: "A small crossword for the whole group. Answer by number, like 1 across word or 3d word.",
        usage: ["crossword", "crossword hint", "crossword cancel"],
    },
    numguess: {
        about: "Guess the number. The bot says higher or lower.",
        usage: ["numguess [max]", "numguess hint"],
    },
    anagram: {
        about: "Unscramble the word before anyone else does.",
        usage: ["anagram", "anagram hint", "anagram skip"],
    },
    decrypt: {
        about: "A word game for the group, with up to 2 hints per game.",
        usage: ["decrypt", "decrypt hint"],
    },
    math: {
        about: "An arithmetic and algebra game with a time limit, longer for the harder levels. Leave the level out and it picks one at random.",
        usage: ["math [easy|medium|hard|impossible|asian]", "math cancel"],
    },
    hotpotato: {
        about: "Pass the potato on before the fuse runs out. Whoever is holding it when it blows up loses.",
        usage: ["hotpotato", "hotpotato cancel"],
    },
    pass: {
        about: "Passes the hot potato to someone, or back if you don't mention anyone.",
        usage: ["pass @user", "pass"],
    },
    tournament: {
        about: "Runs a decrypt or math tournament for the group.",
        usage: ["tournament create [points]", "tournament join", "tournament start [decrypt|math]", "tournament status", "tournament cancel"],
    },
    translate: {
        about: "Translates some text into the language you pick.",
        usage: ["translate <language> <text>", "translate <language> (as a reply to a message)"],
    },
    tts: {
        about: "Draws text on a sticker. Run it on its own to see the fonts and options.",
        usage: ["tts [font] <text>", "tts (as a reply to a message)"],
    },
    ttscss: {
        about: "Draws text on a sticker with your own css, so it can look however you want. Run it on its own for an example. You can save a default style for yourself.",
        usage: ["ttscss <text> | <css>", "ttscss <text> [-css <css>] [-bg <background>] [-clr <color>] [-size <number>]", "ttscss save <flags>", "ttscss reset", "ttscss show"]
    },
    edit: {
        about: "Edits an image or sticker with crop, cut, draw and text. Run it on its own for the full help.",
        usage: ["edit grid", "edit"],
    },
    coin: {
        about: "Flips a coin.",
        usage: ["coin"],
    },
    roll: {
        about: "Rolls dice.",
        usage: ["roll [sides]", "roll <count>d<sides>"],
    },
    joke: {
        about: "Sends a random joke.",
        usage: ["joke"],
    },
    fact: {
        about: "Sends a random fact.",
        usage: ["fact"],
    },
    quote: {
        about: "Quotes some text and mentions you.",
        usage: ["quote <text>", "quote (as a reply to a message)"],
    },
    roast: {
        about: "A short, friendly roast. About you if you leave it blank.",
        usage: ["roast @user", "roast <text>", "roast"],
    },
    compliment: {
        about: "A short compliment. About you if you leave it blank.",
        usage: ["compliment @user", "compliment <text>", "compliment"],
    },
    define: {
        about: "Looks up the definition of a word.",
        usage: ["define <word>"],
    },
    wiki: {
        about: "Sends a Wikipedia summary.",
        usage: ["wiki <query>"],
    },
    sticker: {
        about: "Turns an image into a sticker.",
        usage: ["sticker"],
    },
    animsticker: {
        about: "Turns a video or gif into an animated sticker.",
        usage: ["animsticker", "animsticker add", "animsticker done"],
    },
    weather: {
        about: "Shows the weather for a place. Add forecast 7 for the next 7 days, or forecast 24 for the next 24 hours.",
        usage: ["weather <location>", "weather forecast 7 <location>", "weather forecast 24 <location>"],
    },
    plot: {
        about: "Plots a maths expression and sends the graph.",
        usage: ["plot <expression>"],
    },
    whoami: {
        about: "Shows your phone number, your LID and the group ID.",
        usage: ["whoami"],
    },
    docs: {
        about: "Sends a link to the khoibot docs.",
        usage: ["docs"],
    },
    credits: {
        about: "Shows who gets the credit for the minesweeper and connect 4 games, and for youtube.",
        usage: ["credits"],
    },
    up: {
        about: ":eyes: ",
        usage: ["up"],
    },
    down: {
        about: ":eyes: ",
        usage: ["down"],
    },
    drunkify: {
        about: "Turns your text into slurred drunk talk.",
        usage: ["drunkify <text>"],
    },
    cat: {
        about: "Sends a random cat photo.",
        usage: ["cat"],
    },
    dog: {
        about: "Sends a random dog photo.",
        usage: ["dog"],
    },
    meme: {
        about: "Sends a random meme.",
        usage: ["meme"],
    },
    plane: {
        about: "Searches for plane photos.",
        usage: ["plane [keywords]"],
    },
    pfp: {
        about: "Looks up someone's profile picture.",
        usage: ["pfp <number>"],
    },
    websearch: {
        about: "Searches the web and sends the top results.",
        usage: ["websearch <query>"],
    },
    news: {
        about: "Searches the news and sends the top headlines. Leave it blank for world news.",
        usage: ["news [topic]"],
    },
    youtube: {
        about: "Finds YouTube videos and sends the links.",
        usage: ["youtube <query>"],
    },
    reddit: {
        about: "Searches Reddit and sends the top posts.",
        usage: ["reddit <query>"],
    },
    hn: {
        about: "Sends the Hacker News front page, or searches the stories if you give it something to look for.",
        usage: ["hn [query]"],
    },
    gif: {
        about: "Finds a gif and sends it. If the bot can't convert it, you get the link instead.",
        usage: ["gif <query>"],
    },
    read: {
        about: "Reads a web page and sends back the text from it.",
        usage: ["read <link>"],
    },
    tldr: {
        about: "Summarises a web page for you.",
        usage: ["tldr <link>"],
    },
    expand: {
        about: "Follows a short link and tells you where it goes.",
        usage: ["expand <link>"],
    },
    redirects: {
        about: "Shows every hop/transfers a link takes before it lands.",
        usage: ["redirects <link>"],
    },
    screenshot: {
        about: "Takes a screenshot of a web page and sends it.",
        usage: ["screenshot <link>"],
    },
    archive: {
        about: "Looks for the closest saved copy of a page on the Wayback Machine.",
        usage: ["archive <link>"],
    },
    isup: {
        about: "Checks if a site is up and how fast it answers.",
        usage: ["isup <site>"],
    },
    pinghost: {
        about: "Times a connection to a host on port 443, then 80.",
        usage: ["pinghost <host>"],
    },
    dns: {
        about: "Looks up the dns records for a domain. A is the default.",
        usage: ["dns <domain> [A|AAAA|MX|NS|TXT|CNAME|SOA]"],
    },
    whois: {
        about: "Looks up who registered a domain and when.",
        usage: ["whois <domain>"],
    },
    ip: {
        about: "Shows roughly where an ip address or a domain is and who runs it.",
        usage: ["ip <address or domain>"],
    },
    github: {
        about: "Shows a GitHub user or a repo.",
        usage: ["github <user>", "github <user>/<repo>"],
    },
    image: {
        about: "Searches for an image and sends it.",
        usage: ["image <query>"],
    },
    pokemon: {
        about: "Shows a pokemon, by name or number.",
        usage: ["pokemon <name or number>"],
    },
    qr: {
        about: "Makes a qr code from some text or a link.",
        usage: ["qr <text or link>"],
    },
    flight: {
        about: "Shows the usual route for a flight number, not the live status.",
        usage: ["flight <flight number>"],
    },
    song: {
        about: "Sends a song as an mp3 (15 minutes and 25 MB max). Give it some words and it sends the top youtube match, or a youtube link. A mod can turn it off with !mod downloadmedia.",
        usage: ["song <youtube link or search>"],
    },
    warn: {
        about: "Gives someone a warning.",
        usage: ["warn <@user|number> <reason>"],
    },
    warnings: {
        about: "Lists the warnings in the group, or one person's.",
        usage: ["warnings", "warnings <@user|number>"],
    },
    unwarn: {
        about: "Takes a warning off someone. Add all to clear them.",
        usage: ["unwarn <@user|number> [all]", "unwarn <@user|number> warnnumber <number>"],
    },
    ban: {
        about: "Makes the bot ignore someone in this group, for a set time if you want.",
        usage: ["ban [@user|number] [duration]"],
    },
    unban: {
        about: "Lets the bot listen to someone again.",
        usage: ["unban [@user|number]"],
    },
    mute: {
        about: "Locks the group so only admins can talk, for a set time if you want.",
        usage: ["mute [duration]"],
    },
    unmute: {
        about: "Unlocks the group.",
        usage: ["unmute"],
    },
    automute: {
        about: "Mutes the group on a schedule.",
        usage: ["automute <once|all> <HH:MM>", "automute off"],
    },
    autounmute: {
        about: "Unmutes the group on a schedule.",
        usage: ["autounmute <once|all> <HH:MM>", "autounmute off"],
    },
    execute: {
        about: "Kicks someone out of the group.",
        usage: ["execute <@user|number>"],
    },
    deletemessages: {
        about: "Deletes the last few messages in the group, whoever sent them. The bot has to be an admin.",
        usage: ["deletemessages <1-50>"],
    },
    mod: {
        about: "Changes the settings for this group.",
        usage: ["mod <setting> <value>"],
    },
    special: {
        about: "Trusted extras, like adding someone to the group or force banning a number.",
        usage: ["special addmember <number>", "special forceban <add|remove|list> [number]", "special sendmessage <group id|name> <message>", "special resetaimodel [model]"],
    },
    blacklist: {
        about: "Trusted only. A blacklisted number gets removed as soon as they join a group the bot is admin in.",
        usage: ["blacklist list", "blacklist add <number>", "blacklist remove <number>"],
    },
    antiban: {
        about: "Shows the anti-ban status and lets you change the rate limits.",
        usage: ["antiban", "antiban banrisk", "antiban reset"],
    },
    messagedelay: {
        about: "Changes how long the bot waits before sending a message.",
        usage: ["messagedelay set <min> <max>", "messagedelay reset"],
    },
    messagecooldown: {
        about: "Changes how long people wait between commands.",
        usage: ["messagecooldown <normal> <heavy>", "messagecooldown <on|off>"],
    },
    bot: {
        about: "Stops or resumes all sending from the bot.",
        usage: ["bot on", "bot off"],
    },
    ytinfo: {
        about: "Shows the title, channel, length and views of a youtube link.",
        usage: ["ytinfo <youtube link>"],
    },
    video: {
        about: "Sends a youtube video as an mp4 (10 minutes and 40 MB max, 480p at most). Give it a link, or some words and it sends the top match. A mod can turn it off with !mod downloadmedia.",
        usage: ["video <youtube link or search>"],
    },
    toimage: {
        about: "Turns a sticker into a normal picture.",
        usage: ["toimage (reply to a sticker)"],
    },
    togif: {
        about: "Turns an animated sticker or a short video into a gif.",
        usage: ["togif (reply to an animated sticker or video)"],
    },
    tomp3: {
        about: "Pulls the sound out of a video or voice note as an mp3.",
        usage: ["tomp3 (reply to a video or voice note)"],
    },
    removebg: {
        about: "Cuts the background out of a picture. It comes back as a file so the background stays see through.",
        usage: ["removebg (reply to a picture)"],
    },
    slowmode: {
        about: "Makes people wait a bit between messages in this group.",
        usage: ["slowmode <seconds>", "slowmode off", "slowmode"],
    },
    hangman: {
        about: "Guess the word one letter at a time. Six wrong guesses and you lose.",
        usage: ["hangman", "hangman cancel"],
    },
    trivia: {
        about: "A multiple choice question. Answer with A to D, a wrong answer puts you out.",
        usage: ["trivia"],
    },
};

// the text for !help <command>, or null when there's no write up for it yet
function commandDetails(name, prefix) {
    const details = DETAILS[name];
    if (!details) return null;

    const usage = details.usage.map((line) => `${DASH} ${prefix}${line}`);
    return `*${prefix}${name}*\n\n${details.about}\n\nUsage:\n${usage.join("\n")}`;
}

// trusted people can see everything, admins can see admin and all, everyone else just "all"
function canSee(level, { trusted, groupAdmin }) {
    if (level === "all") return true;
    if (level === "admin") return Boolean(trusted || groupAdmin);
    return Boolean(trusted);
}

function visibleCategories(who) {
    return CATEGORIES.filter((category) => canSee(category.level, who));
}

function categoryList(who, prefix) {
    const lines = visibleCategories(who).map((category) => `${DASH} ${category.name}`);
    return `${lines.join("\n")}\n\n_Use ${prefix}help <category> to see what's in one._`;
}


// how many single character edits it takes to turn one word into the other, so typos still get caught
function editDistance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = row[j];
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + cost);
            diagonal = above;
        }
    }
    return row[b.length];
}

function suggestions(query, who, prefix) {
    if (!query) return [];

    const typoLimit = query.length <= 4 ? 1 : 2;
    const options = [];
    for (const category of visibleCategories(who)) {
        options.push({ name: category.name, text: `${prefix}help ${category.name}` });
        for (const command of category.commands) {
            if (canSee(command.level, who)) {
                options.push({ name: command.name, text: `${prefix}${command.name}` });
            }
        }
    }

    const scored = [];
    for (const option of options) {
        const distance = editDistance(query, option.name);
        let rank = null;
        if (option.name.startsWith(query)) rank = 0;
        else if (option.name.includes(query)) rank = 1;
        else if (distance <= typoLimit) rank = 2;
        if (rank !== null) scored.push({ ...option, rank, distance });
    }

    scored.sort((a, b) => a.rank - b.rank || a.distance - b.distance);
    return [...new Set(scored.map((option) => option.text))].slice(0, 3);
}

function buildHelp(argument, who, prefix = "!") {
    const wanted = String(argument || "").trim().toLowerCase();

    if (!wanted) {
        return `*Help menu*\n\n${categoryList(who, prefix)}`;
    }

    const category = visibleCategories(who).find((item) => item.name === wanted);
    if (!category) {
        // people type !help ttt or !help messagecool, so look for a command before giving up
        const query = wanted.startsWith(prefix) ? wanted.slice(prefix.length) : wanted;
        const owner = visibleCategories(who).find((item) => item.commands.some((command) => command.name === query && canSee(command.level, who)));
        if (owner) {
            return commandDetails(query, prefix) || `${prefix}${query} is in the *${owner.name}* category, use ${prefix}help ${owner.name} to see the rest.`;
        }

        const maybe = suggestions(query, who, prefix);
        if (maybe.length) {
            return `Did you mean ${maybe.join(" or ")}?`;
        }

        return `There's no category called "${wanted}".\n\n${categoryList(who, prefix)}`;
    }

    const names = category.commands
        .filter((command) => canSee(command.level, who))
        .map((command) => `${DASH} ${prefix}${command.name}`);

    return `*${category.name}*\n\n${names.join("\n")}`;
}

module.exports = { buildHelp };
