/**
 * Emoji Picture categories and the question each one asks ("Kaunsa khel?" for Sport, and so on).
 * The question is only fair when the answer really is that kind of thing, so a puzzle whose answer
 * doesn't fit its category is refused: AI output, library rows when they are served, the review bank
 * and the built-in deck all go through `categoryMismatch`. Pure code, no network.
 */

export const EMOJI_CATEGORIES = ["Movie", "Food", "Place", "Festival", "Phrase", "Cartoon", "Sport", "Song", "Person", "Thing"] as const;
export type EmojiCategory = (typeof EMOJI_CATEGORIES)[number];

/** What the answer box asks, per category. */
export const EMOJI_ASK: Record<EmojiCategory, string> = {
  Movie: "Kaunsi film?",
  Food: "Kya khana hai?",
  Place: "Kaunsi jagah?",
  Festival: "Kaunsa tyohaar?",
  Phrase: "Kaunsa muhavara?",
  Cartoon: "Kaunsa cartoon?",
  Sport: "Kaunsa khel?",
  Song: "Kaunsa gaana?",
  Person: "Kaun hai yeh?",
  Thing: "Kya hai yeh?",
};

export function isEmojiCategory(v: string): v is EmojiCategory {
  return (EMOJI_CATEGORIES as readonly string[]).includes(v);
}

function norm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Sports and games ("khel"). A Sport answer must be one of these, not a player, team or tournament. */
const SPORTS = new Set(
  [
    "cricket", "football", "soccer", "hockey", "field hockey", "ice hockey", "kabaddi", "kho kho", "badminton", "tennis",
    "table tennis", "ping pong", "chess", "shatranj", "carrom", "ludo", "snakes and ladders", "saanp seedhi", "snakes ladders",
    "wrestling", "kushti", "boxing", "archery", "javelin", "javelin throw", "shot put", "discus", "discus throw", "high jump",
    "long jump", "pole vault", "athletics", "running", "sprint", "marathon", "relay", "hurdles", "swimming", "diving", "golf",
    "polo", "basketball", "volleyball", "beach volleyball", "handball", "netball", "cycling", "shooting", "weightlifting",
    "gymnastics", "judo", "karate", "taekwondo", "kung fu", "fencing", "squash", "snooker", "billiards", "pool", "bowling",
    "formula 1", "formula one", "f1", "car racing", "motor racing", "horse racing", "rowing", "kayaking", "sailing", "surfing",
    "skating", "skateboarding", "ice skating", "skiing", "rugby", "baseball", "softball", "gilli danda", "mallakhamb",
    "kite flying", "patang", "pitthu", "pithoo", "lagori", "stapu", "hopscotch", "langdi", "kalaripayattu", "yoga", "darts",
    "tug of war", "rassa kashi", "rock climbing", "triathlon", "esports",
  ].map(norm),
);

/** Words that mean the answer is a scheme, event or news item, not a saying. */
const NOT_A_SAYING = /\b(scheme|yojana|mission|summit|project|policy|election|covid|corona|pandemic|isolation|lockdown|launch|world cup|cup|league|olympics?|award|budget)\b/;

/**
 * Null when the answer fits the category, otherwise a short reason. Only checks that can be done
 * reliably in code are made: Sport answers must name a sport or game, and Phrase answers must read
 * like a saying (two or more words, no numbers, not a scheme or event).
 */
export function categoryMismatch(category: string, answer: string): string | null {
  if (!isEmojiCategory(category)) return "unknown category";
  const a = norm(answer);
  if (!a) return "empty answer";
  if (category === "Sport" && !SPORTS.has(a)) return "Sport answer is not the name of a sport";
  if (category === "Phrase") {
    if (a.split(" ").length < 2) return "Phrase answer is a single word";
    if (/\d/.test(a)) return "Phrase answer has a number";
    if (NOT_A_SAYING.test(a)) return "Phrase answer is a scheme or event";
  }
  return null;
}
