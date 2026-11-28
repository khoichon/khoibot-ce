const say = (at, text) => ({ at, say: text });

const TWISTS = {
    "but he refused.": [say(3, "(he is still refusing)")],
    "but nobody came.": [say(4, "...nobody came. again.")],
    "what if i just... don't?": [{ at: 10, edit: "what if i just... do?" }, { at: 13, edit: "__original" }],
    "nah": [{ at: 2, voice: "naaah" }],
    "why should i": [{ listen: /because/i, within: 60, say: "that's not a reason." }],
    "the censors are gonna kill me!": [{ at: 5, remove: true }, say(6, "see?")],
    "you do not have enough energy to do this action": [say(2, "energy: 0/10"), say(20, "energy: 3/10. still not enough.")],
    "khoichon will murder me": [say(3, "khoichon has been notified")],
    "not today.": [say(20, "...tomorrow?"), say(22, "no")],
    "ask me again never.": [say(30, "it's been 30 seconds. still never.")],
    "i'd rather not.": [say(3, "i'd rather watch paint dry.")],
    "that's a you problem.": [{ at: 2, tag: "@user, problem." }],
    "error 418: i'm not doing it": [say(3, "i'm a teapot")],
    "maybe in another life": [{ at: 2, video: true }],
    "the stars are not aligned": [say(4, "(checked the stars again)"), say(8, "still not aligned")],
    "i left it in my other pants": [say(3, "(checked, they're not there either)")],
    "i would, but i'm busy doing nothing": [say(5, "still doing nothing. very busy.")],
    "your request was lost in the mail": [say(10, "update: it is now in a different country")],
    "i asked khoichon and he said no": [say(3, "(he sent a \u{1F44E})")],
    "ask nicely": [{ listen: /\b(please|pls|plz)\b/i, within: 60, say: "closer, but no." }],
    "the bot has left the chat": [say(3, "the bot has rejoined the chat")],
    "sorry, wrong number": [say(4, "(hangs up)")],
    "error 450: blocked by khoichon parental control": [say(3, "reason: too many fun commands")],
    "error 540: temporarily disabled": [say(20, "temporarily enabled for 0 seconds")],
    "error 401: unauthorised": [say(3, "credentials: not provided, not wanted")],
    "error 403: forbidden": [say(3, "forbidden. really.")],
    "error 406: not acceptable": [say(3, "acceptable alternatives: none")],
    "error 404: motivation not found": [say(3, "searching..."), say(6, "still not found")],
    "error 408: request timed out waiting for me to care": [say(8, "(still waiting for me to care)")],
    "error 410: this command is gone": [{ at: 5, remove: true }],
    "error 429: too many requests, go away": [{ cooldown: 30 }],
    "error 451: unavailable for legal reasons": [say(4, "legal team notified (it's a hamster)")],
    "error 500: i'm not feeling well": [say(3, "(coughs)"), say(8, "feeling better. still not doing it.")],
    "error 503: service unavailable": [say(3, "retrying in 3... 2... 1... still unavailable")],
    "error 504: gateway timeout, try again never": [say(5, "gateway timeout. again.")],
    "error 511: network authentication required": [say(3, "hint: the password is not please")],
    "i'm going to pretend i didn't see that": [say(4, "(still pretending)")],
    "request denied, please try denying yourself": [say(4, "self-denial: not detected")],
    "access denied. nice try though": [say(3, "(10/10 for effort)")],
    "the answer is no and the question is also no": [say(3, "the follow-up question is also no")],
    "this feature is behind a very large paywall": [say(4, "price: 1 tryhard coin (not accepted)")],
    "i don't get paid enough for this": [say(4, "payment received: 0. refund requested.")],
    "that's above my pay grade, and i'm not paid": [say(4, "(pay grade: unpaid intern)")],
    "you're not on the list": [say(3, "(checked the list twice, still no)")],
    "error 405: method not allowed": [say(3, "allowed methods: carrier pigeon")],
    "error 409: conflict of interest": [say(3, "(my interest is not helping)")],
    "error 412: precondition failed, you didn't say please": [{ listen: /\bplease\b/i, within: 60, say: "too late." }],
    "error 423: locked": [say(3, "unlock fee: 1 hug")],
    "error 426: upgrade required, try being cooler": [say(3, "cool level: 3/10, need 7")],
    "error 502: bad gateway, bad everything": [say(3, "(everything is bad)")],
    "error 505: version not supported, try a different universe": [say(3, "supported universes: 0")],
    "error 507: insufficient storage for your nonsense": [say(4, "nonsense storage: 100% full")],
    "error 511: please log in to your personality": [say(3, "login failed: personality not found")],
    "i'm not mad, just disappointed in this request": [say(5, "...mostly disappointed")],
    "that's not in my job description": [say(3, "job description: reply no")],
    "i've been advised not to": [say(3, "advisor: a rubber duck")],
    "ask again after i've had coffee": [say(20, "coffee break over. still no.")],
    "you're gonna have to take that up with khoichon": [say(3, "his office hours: never")],
    "it's not a bug, it's me refusing": [say(3, "(it's a feature)")],
    "denied. please enjoy your day anyway": [say(5, "have a nice day")],
    "i tried, i just didn't want to": [say(3, "(i did not try)")]
};

const pair = (line, twist) => ({ line, steps: [say(3, twist)] });

const WINS = [
    pair("...fine. you got lucky. don't tell anyone.", "(this message will not be repeated)"),
    pair("a one in a thousand chance and you hit it. the menu is yours.", "go buy a lottery ticket"),
    pair("okay wow.", "i can't believe this"),
    pair("the stars aligned. the menu is on.", "this will not happen again"),
    pair("access granted. i did not see that coming.", "neither did you, admit it"),
    pair("you win. here's your menu. please be gentle with it.", "...it's a good menu"),
    pair("i rolled a 1 and you rolled a 1000.", "(the dice are fair, i checked)"),
    pair("against all odds, it worked.", "i'd like to speak to the manager of luck")
];

const PITY = [
    pair("okay okay. 50 tries. i felt bad.", "(don't make this a habit)"),
    pair("50 tries. fine, you've earned it.", "(nobody tell khoichon)"),
    pair("i give up. you win.", "(this is not a precedent)")
];

const STREAK = {
    5: "that's 5 tries. bold.",
    10: "10 tries. the odds are 1 in 1000, just so you know.",
    20: "20 tries. persistence is a virtue, i guess.",
    35: "35 tries. i'm starting to respect this.",
    49: "49 tries. one more and i give in. no pressure."
};

const ROLE_POOLS = {
    trusted: [
        pair("even you? i expected better.", "(trusted people should know)"),
        pair("you're trusted. i'm not that trusting about this.", "(trust is earned, not for this)"),
        pair("trusted users still don't get this.", "(rules are rules)"),
        pair("khoichon trusts you. i don't, for this.", "(nothing personal)"),
        pair("nope. being trusted doesn't cover this.", "(read the fine print)")
    ],
    admin: [
        pair("nice admin badge. still no.", "(badges don't work here)"),
        pair("admins can kick people, not this.", "(different department)"),
        pair("you run this group, not me. no.", "(i report to khoichon)"),
        pair("admin or not, the answer is no.", "(especially not)"),
        pair("being an admin doesn't unlock this.", "(try being the bot)")
    ],
    member: [
        pair("you're not even an admin.", "(start there)"),
        pair("nice try, member.", "(promotion pending forever)"),
        pair("regular members don't get to ask.", "(it's in the rules)"),
        pair("ask an admin to ask me. then no.", "(it's a process)"),
        pair("you don't have the rank for this.", "(rank: unranked)")
    ]
};

const FAKE_FOLLOW_UPS = [
    "just kidding.",
    "i lied. it's still off.",
    "gotcha. it's still off.",
    "did you really think it'd be that easy?"
];

const HOLIDAYS = {
    newyear: ["happy new year. still no.", "new year, same answer."],
    cny: ["恭喜发财. the answer is still no.", "happy chinese new year. no ang pao for this command."],
    harirayaputhasa: ["selamat hari raya puasa. the answer is still no.", "selamat hari raya. no menu, but happy raya."],
    harirayahaji: ["selamat hari raya haji. the answer is still no.", "happy hari raya haji. no menu today."],
    goodfriday: ["it's good friday and the answer is still no.", "a quiet day. the answer is still no."],
    easter: ["happy easter. still no.", "the easter bunny said no too."],
    labour: ["it's labour day. i'm off. no.", "even bots get labour day off."],
    vesak: ["happy vesak day. the answer is still no.", "may you be at peace. still no menu."],
    nationalday: ["happy national day. the menu is not part of the parade.", "majulah singapura. still no."],
    deepavali: ["happy deepavali. the answer is still no.", "may the light win. the menu does not."],
    christmas: ["merry christmas. no menu for you.", "santa said no too."]
};

const DEFAULT_DATES = [
    "01-01=newyear", "01-05=labour", "09-08=nationalday", "25-12=christmas",
    "06-02-2027=cny", "07-02-2027=cny", "08-02-2027=cny",
    "10-03-2027=harirayaputhasa", "26-03-2027=goodfriday", "28-03-2027=easter",
    "17-05-2027=harirayahaji", "20-05-2027=vesak", "28-10-2027=deepavali"
].join(",");

module.exports = { TWISTS, WINS, PITY, STREAK, ROLE_POOLS, FAKE_FOLLOW_UPS, HOLIDAYS, DEFAULT_DATES };
