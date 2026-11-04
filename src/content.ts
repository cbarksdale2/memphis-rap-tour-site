// The whole site's editable content is ONE JSON document. Every save writes a new row in `versions`;
// `settings.draft_version` is what the admin edits and previews, `settings.published_version` is what
// visitors see. Publish moves the published pointer; restore copies an old version and publishes it.
import { now } from "./http";

export type BlockType = "hero" | "text" | "image_text" | "stops" | "reviews" | "faq" | "cta" | "gallery" | "signup" | "request";

export interface Section {
  id: string;
  type: BlockType;
  hidden: boolean;
  data: Record<string, string>;
}

export interface Page {
  slug: string;
  path: string;
  nav_label: string;
  in_nav: boolean;
  title: string;
  description: string;
  h1: string;
  intro: string;
  sections: Section[];
}

export interface Ticket {
  price_text: string;
  price_amount: string;
  currency: string;
  duration_text: string;
  duration_iso: string;
  schedule_text: string;
  schedule_long: string;
  book_url: string;
  private_price_text: string;
  private_price_amount: string;
  meeting_point: string;
  street: string;
  locality: string;
  region: string;
  postal_code: string;
  email: string;
  policy_text?: string;
}

export interface SiteInfo {
  name: string;
  owner: string;
  instagram: string;
  tiktok: string;
  rating_text: string;
  rating_url: string;
  footer_location: string;
  disclaimer: string;
  consent_text: string;
}

export interface Faq { id: string; q: string; a: string; hidden: boolean }
export interface Review { id: string; quote: string; author: string; date: string; url: string; hidden: boolean }
export interface Stop { name: string }

export interface Content {
  ticket: Ticket;
  site: SiteInfo;
  stops: Stop[];
  faqs: Faq[];
  reviews: Review[];
  pages: Page[];
}

export interface BlockField { k: string; t: "line" | "text" | "check" | "number" | "link" | "image" | "images" | "select"; l: string; options?: string[]; hint?: string }

/** Block types: what the admin can add, and the fields each one has. */
export const BLOCKS: Record<BlockType, { label: string; about: string; fields: BlockField[] }> = {
  hero: {
    label: "Top of page",
    about: "The big heading, the opening line, the ticket facts and the Book button.",
    fields: [
      { k: "label", t: "line", l: "Small line above the heading" },
      { k: "show_facts", t: "check", l: "Show when, how long, where to meet and the ticket price" },
      { k: "primary_text", t: "line", l: "Book button words" },
      { k: "secondary_text", t: "line", l: "Second button words (leave empty for none)" },
      { k: "secondary_href", t: "link", l: "Second button goes to" },
      { k: "image", t: "image", l: "Photo" },
      { k: "show_rating", t: "check", l: "Show the Tripadvisor rating line" },
    ],
  },
  text: {
    label: "Text",
    about: "A heading and some text. Start lines with - for a list.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Text" },
    ],
  },
  image_text: {
    label: "Photo and text",
    about: "A photo beside a heading and some text.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Text" },
      { k: "image", t: "image", l: "Photo" },
      { k: "link_text", t: "line", l: "Link words (leave empty for none)" },
      { k: "link_href", t: "link", l: "Link goes to" },
    ],
  },
  stops: {
    label: "Tour stops",
    about: "The stops in order, as a tracklist. The stops themselves are on Tour info.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Line above the stops" },
      { k: "note", t: "line", l: "Small note under the stops" },
    ],
  },
  reviews: {
    label: "Reviews",
    about: "Short review quotes. The quotes themselves are on Reviews.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Line above the quotes" },
      { k: "limit", t: "number", l: "How many to show before \"Show more\" (0 = all)" },
    ],
  },
  faq: {
    label: "Questions (FAQ)",
    about: "The questions and answers. The questions themselves are on Questions.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "limit", t: "number", l: "How many questions to show (0 = all)" },
    ],
  },
  cta: {
    label: "Call to action",
    about: "A band with a heading, a price line and one button.",
    fields: [
      { k: "label", t: "line", l: "Small line above the heading" },
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Text" },
      { k: "price", t: "line", l: "Price line (leave empty for none)" },
      { k: "subtext", t: "line", l: "Small line under the price" },
      { k: "button_text", t: "line", l: "Button words" },
      { k: "button_href", t: "link", l: "Button goes to" },
      { k: "style", t: "select", l: "Colour", options: ["dark", "gold"] },
    ],
  },
  gallery: {
    label: "Photo gallery",
    about: "A grid of photos.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "images", t: "images", l: "Photos" },
    ],
  },
  request: {
    label: "Private tour request form",
    about: "A form groups use to ask for a private tour. Requests show up in the admin.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Text" },
    ],
  },
  signup: {
    label: "Email sign-up",
    about: "The form people use to join the email list.",
    fields: [
      { k: "heading", t: "line", l: "Heading" },
      { k: "body", t: "text", l: "Text" },
    ],
  },
};

export const BLOCK_TYPES = Object.keys(BLOCKS) as BlockType[];

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1000;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

const TA = "https://www.tripadvisor.com/AttractionProductReview-g55197-d33472036-Memphis_Rap_and_Hip_Hop_Tour-Memphis_Tennessee.html";
const BOOK = "https://app.acuityscheduling.com/schedule.php?owner=35599844";

function s(id: string, type: BlockType, data: Record<string, string>): Section {
  return { id, type, hidden: false, data };
}

const WHAT_HAPPENS =
  "- **A guided bus ride.** A narrated tour about how rap and hip hop shaped Memphis, with the music on.\n" +
  "- **The stories behind the names.** Your guide covers the lives and careers of Memphis rappers, DJs and producers.\n" +
  "- **Photo stops.** Planned stops at the murals and landmarks that grew the Memphis rap scene.\n" +
  "- **Local food.** Bites from local food spots on the route.\n" +
  "- **Air-conditioned bus.** Wheelchair and stroller accessible. Wear comfortable shoes, since you get on and off at each stop.";

/** The first content, from the mock-up Carlos approved on 3 Nov 2026. Gaps he has not answered are left off. */
export function seedContent(): Content {
  return {
    ticket: {
      price_text: "$70 per person",
      price_amount: "70",
      currency: "USD",
      duration_text: "3 hours",
      duration_iso: "PT3H",
      schedule_text: "Fri & Sat · 2:00 pm Central",
      schedule_long: "Fridays and Saturdays at 2:00 pm Central",
      book_url: BOOK,
      private_price_text: "From $600",
      private_price_amount: "600",
      meeting_point: "Beale St & S B.B. King Blvd, outside Patio Bar",
      street: "Beale St & S B.B. King Blvd",
      locality: "Memphis",
      region: "TN",
      postal_code: "38103",
      email: "team@memphisraptour.com",
      policy_text: "Refund and cancellation policy coming soon. Questions before you book? Email team@memphisraptour.com.",
    },
    site: {
      name: "Memphis Rap Tour",
      owner: "Carlos Barksdale",
      instagram: "https://www.instagram.com/memphisraptour/",
      tiktok: "https://www.tiktok.com/@memphis.rap.tour",
      rating_text: "5.0 · 20 reviews on Tripadvisor (as of 3 Nov 2026)",
      rating_url: TA,
      footer_location: "Memphis, TN · Starts and ends downtown on Beale Street",
      disclaimer:
        "The Memphis Rap & Hip Hop Tour is an independently operated tour and is not affiliated with, endorsed by, or sponsored by any of the artists, estates, record labels, or businesses mentioned during the tour.",
      consent_text: "Yes, email me tour dates and news from Memphis Rap Tour. I can unsubscribe any time.",
    },
    stops: [
      "Beale Street", "Orpheum Theatre", "Young Dolph Mural", "Makeda's Cookies",
      "Orange Mound Neighborhood", "Gangsta Boo Mural", "North Memphis", "Downtown Rapper Mural",
    ].map((name) => ({ name })),
    faqs: [
      { id: "f1", q: "Is there a hip hop tour in Memphis?", a: "Yes. Memphis Rap Tour is a guided bus tour about Memphis rap and hip hop history. It runs {schedule_long} from Beale Street and B.B. King Boulevard downtown, with landmark stops, photo stops at murals and local food along the way.", hidden: false },
      { id: "f2", q: "What stops does the tour make?", a: "The tour makes {stop_count} stops, in this order: {stops}. Your guide tells the stories of the Memphis rappers, DJs and producers behind each place.", hidden: false },
      { id: "f3", q: "Where does the tour start and end?", a: "Meet at Beale Street and South B.B. King Boulevard, Memphis, TN 38103, on the southeast side of the block outside Patio Bar. The bus brings you back to the same spot at the end.", hidden: false },
      { id: "f4", q: "How long is the tour, and when does it run?", a: "The tour runs {duration}, {schedule_long}. Tickets are {price} and you book a seat online.", hidden: false },
      { id: "f5", q: "Is it good for kids and teens?", a: "Families have brought teens and children as young as 7, according to Tripadvisor reviews. All ages can ride, and infants sit on a lap.", hidden: false },
      { id: "f6", q: "Is the bus wheelchair accessible?", a: "Yes. The bus is air-conditioned and wheelchair and stroller accessible, and service animals are welcome. You get on and off at each stop, so wear comfortable shoes.", hidden: false },
      { id: "f7", q: "Can we book a private tour?", a: "Yes. A private buy-out of the bus starts at {private_price_amount_text}. Email {email} with your date and group size.", hidden: false },
    ],
    reviews: [
      { id: "r1", quote: "An excellent way to learn more about the deep history of Memphis rap legends.", author: "Requill P.", date: "Dec 2025", url: TA, hidden: false },
      { id: "r2", quote: "Our teens were so engaged… It was a fun way to see Memphis and learn a lot about hip hop.", author: "Amy A.", date: "Jan 2026", url: TA, hidden: false },
      { id: "r3", quote: "You will be educated, empowered, and entertained at the same time.", author: "Karla R.", date: "Nov 2025", url: TA, hidden: false },
      { id: "r4", quote: "If you are a fan of hip hop and rap music, this tour is for you.", author: "Tywanda W.", date: "Dec 2025", url: TA, hidden: false },
      { id: "r5", quote: "She was great with our kids, 9 & 7 year old boys!", author: "Erin W.", date: "Dec 2025", url: TA, hidden: false },
      { id: "r6", quote: "As a Memphian, art, and music lover this captured everything in one trip.", author: "A traveller", date: "Jul 2026", url: TA, hidden: false },
    ],
    pages: [
      {
        slug: "home", path: "/", nav_label: "Home", in_nav: false,
        title: "Memphis Rap & Hip Hop Bus Tour | Memphis Rap Tour",
        description: "A 3-hour guided bus tour of Memphis rap and hip hop history: 8 stops from Beale Street to Orange Mound and North Memphis. Fridays and Saturdays, $70.",
        h1: "Come ride with us, *Mane.*",
        intro: "Memphis Rap Tour is a guided bus tour of the neighborhoods, venues and landmarks behind Memphis rap and hip hop. Your guide tells the stories of the city's rappers, DJs and producers, with photo stops at the murals and bites from local food spots on the way.",
        sections: [
          s("home-hero", "hero", { label: "M-Town · Rap & hip hop bus tour", show_facts: "1", primary_text: "Book a seat on the bus ›", secondary_text: "Private tour for your group ›", secondary_href: "/private-tours", image: "mural", show_rating: "1" }),
          s("home-stops", "stops", { heading: "Where does the Memphis rap tour go?", body: "The bus leaves from Beale Street and makes {stop_count} stops across Memphis, from the Orpheum to Orange Mound and North Memphis, ending at a downtown mural.", note: "Stops in order, as set by Memphis Rap Tour." }),
          s("home-expect", "text", { heading: "What happens on the tour?", body: WHAT_HAPPENS }),
          s("home-reviews", "reviews", { heading: "What do riders say?", body: "All 20 of our Tripadvisor reviews are 5 stars (as of 3 Nov 2026).", limit: "3" }),
          s("home-private", "cta", { label: "Private tours", heading: "Take the whole bus for your group", body: "Birthdays, reunions, work trips, a crew in town for a show: book the bus just for you.", price: "{private_price}", subtext: "For a private buy-out. Email us with your date and how many are riding.", button_text: "Email {email}", button_href: "mailto:{email}", style: "dark" }),
          s("home-faq", "faq", { heading: "Questions people ask", limit: "0" }),
          s("home-signup", "signup", { heading: "Get new tour dates by email", body: "New dates, private tour openings and Memphis rap news from the team." }),
          s("home-about", "image_text", { heading: "Who runs the tour?", body: "Memphis Rap Tour is a local Memphis company owned by Carlos Barksdale.", image: "bus", link_text: "More about us ›", link_href: "/about" }),
        ],
      },
      {
        slug: "route", path: "/memphis-hip-hop-tour", nav_label: "The route", in_nav: true,
        title: "Memphis Hip Hop Bus Tour: Route, Stops & Times",
        description: "The Memphis Rap Tour route: 8 stops in order from Beale Street, the meeting point outside Patio Bar, the 3-hour length and the Friday and Saturday start times.",
        h1: "The Memphis hip hop bus tour: route, stops and times",
        intro: "The Memphis Rap Tour is a {duration} guided bus tour that leaves Beale Street {schedule_long} and makes {stop_count} stops, from the Orpheum Theatre to Orange Mound and North Memphis. It ends back where it started, outside Patio Bar on Beale Street.",
        sections: [
          s("route-hero", "hero", { label: "Tour details", show_facts: "1", primary_text: "Book a seat ›", secondary_text: "", secondary_href: "", image: "", show_rating: "" }),
          s("route-stops", "stops", { heading: "What are the stops on the tour?", body: "The bus makes {stop_count} stops, in this order.", note: "Stops in order, as set by Memphis Rap Tour." }),
          s("route-meet", "text", { heading: "Where do we meet?", body: "Meet at {meeting_point}, Memphis, TN 38103, on the southeast side of the block. The bus brings you back to the same spot at the end.\n\n[Get directions ›](https://www.google.com/maps/search/?api=1&query=Beale+St+and+S+B.B.+King+Blvd+Memphis+TN+38103)" }),
          s("route-expect", "text", { heading: "What happens on the tour?", body: WHAT_HAPPENS }),
          s("route-cta", "cta", { label: "Ready to ride?", heading: "Book a seat on the bus", body: "{schedule_long}. {duration}. {price}.", price: "", subtext: "", button_text: "Book a seat ›", button_href: "{book_url}", style: "gold" }),
        ],
      },
      {
        slug: "book", path: "/book", nav_label: "Book", in_nav: false,
        title: "Book the Memphis Rap Tour: Tickets & Dates",
        description: "Book a seat on the Memphis Rap Tour: $70 per person, 3 hours, Fridays and Saturdays at 2:00 pm Central from Beale Street. Pick your date on our booking page.",
        h1: "Book a seat on the Memphis Rap Tour",
        intro: "Booking the Memphis Rap Tour takes a minute: tickets are {price}, the tour runs {duration}, and it leaves Beale Street {schedule_long}. Pick your date on our booking page.",
        sections: [
          s("book-hero", "hero", { label: "Tickets", show_facts: "1", primary_text: "Pick a date and book ›", secondary_text: "Private tour for your group ›", secondary_href: "/private-tours", image: "", show_rating: "1" }),
          s("book-how", "text", { heading: "How do I book?", body: "1. Tap \"Pick a date and book\".\n2. Choose a Friday or Saturday tour.\n3. Enter your details and pay on our booking page.\n\nQuestions before you book? Email [{email}](mailto:{email})." }),
          s("book-private", "cta", { label: "Private tours", heading: "Want the whole bus?", body: "Private buy-outs for birthdays, reunions, work trips and groups.", price: "{private_price}", subtext: "Email us with your date and how many are riding.", button_text: "Email {email}", button_href: "mailto:{email}", style: "dark" }),
        ],
      },
      {
        slug: "reviews", path: "/reviews", nav_label: "Reviews", in_nav: true,
        title: "Memphis Rap Tour Reviews from Riders",
        description: "What riders say about the Memphis Rap Tour: 5.0 from 20 reviews on Tripadvisor, with short quotes from families, fans and Memphians.",
        h1: "Memphis Rap Tour reviews",
        intro: "Memphis Rap Tour has a 5.0 rating from 20 reviews on Tripadvisor (as of 3 Nov 2026). Riders mention the history, the guides, and how engaged their teens and kids were.",
        sections: [
          s("reviews-list", "reviews", { heading: "What do riders say?", body: "Short quotes from Tripadvisor. Tap a name to read the full review there.", limit: "0" }),
          s("reviews-cta", "cta", { label: "Ready to ride?", heading: "Book a seat on the bus", body: "{schedule_long}. {duration}. {price}.", price: "", subtext: "", button_text: "Book a seat ›", button_href: "{book_url}", style: "gold" }),
        ],
      },
      {
        slug: "private", path: "/private-tours", nav_label: "Private tours", in_nav: true,
        title: "Private Hip Hop Bus Tour in Memphis",
        description: "Book the whole Memphis Rap Tour bus for your group: private buy-outs from $600 for birthdays, reunions, work trips and crews in town. Email team@memphisraptour.com.",
        h1: "Private hip hop bus tours in Memphis",
        intro: "A private Memphis Rap Tour is a buy-out of the whole bus for your group, starting at {private_price_amount_text}. You get the same guided tour of Memphis rap and hip hop history, just for the people you bring.",
        sections: [
          s("private-who", "text", { heading: "Who is a private tour for?", body: "- Birthdays and reunions\n- Work trips and team outings\n- A crew in town for a show\n- Any group that wants the bus to themselves" }),
          s("private-how", "text", { heading: "How do I book a private tour?", body: "1. Send the form below, or email [{email}](mailto:{email}).\n2. Tell us your date and how many are riding.\n3. We reply with the price and the details." }),
          s("private-form", "request", { heading: "Ask for a private tour", body: "Tell us when and how many. We reply by email." }),
          s("private-cta", "cta", { label: "Private tours", heading: "Take the whole bus for your group", body: "", price: "{private_price}", subtext: "For a private buy-out.", button_text: "Email {email}", button_href: "mailto:{email}", style: "dark" }),
          // Hidden: Acuity offers no gift certificates (catalog read 3 Nov 2026). Carlos can show it once one exists.
          { id: "private-gift", type: "cta", hidden: true, data: { label: "Gift a tour", heading: "Give a seat on the bus", body: "A Memphis Rap Tour gift for the hip hop fan in your life.", price: "", subtext: "", button_text: "Buy a gift ›", button_href: "", style: "gold" } },
        ],
      },
      {
        slug: "faq", path: "/faq", nav_label: "FAQ", in_nav: true,
        title: "Memphis Rap Tour FAQ: Times, Meeting Point, Kids",
        description: "Answers about the Memphis Rap Tour: where it starts, how long it runs, the stops, kids and teens, wheelchair access and private tours.",
        h1: "Memphis Rap Tour: questions people ask",
        intro: "Memphis Rap Tour is a {duration} guided hip hop bus tour that leaves Beale Street {schedule_long}. Here are short answers to the questions riders ask most.",
        sections: [
          s("faq-list", "faq", { heading: "Frequently asked questions", limit: "0" }),
          s("faq-signup", "signup", { heading: "Get new tour dates by email", body: "New dates, private tour openings and Memphis rap news from the team." }),
          s("faq-cta", "cta", { label: "Still wondering?", heading: "Email the team", body: "We answer questions about dates, groups and access.", price: "", subtext: "", button_text: "Email {email}", button_href: "mailto:{email}", style: "gold" }),
        ],
      },
      {
        slug: "about", path: "/about", nav_label: "About", in_nav: true,
        title: "About Memphis Rap Tour",
        description: "Who runs Memphis Rap Tour: a local Memphis company owned by Carlos Barksdale, running a guided bus tour of Memphis rap and hip hop history from Beale Street.",
        h1: "About Memphis Rap Tour",
        intro: "Memphis Rap Tour is a local Memphis company owned by Carlos Barksdale. It runs a guided bus tour of the neighborhoods, venues and landmarks behind Memphis rap and hip hop, starting and ending on Beale Street.",
        sections: [
          s("about-who", "image_text", { heading: "Who runs the tour?", body: "Memphis Rap Tour is owned by Carlos Barksdale and run by a Memphis team. Tours leave Beale Street {schedule_long}.", image: "bus", link_text: "", link_href: "" }),
          s("about-contact", "text", { heading: "How do I reach the team?", body: "Email [{email}](mailto:{email}). You can also find us on [Instagram @memphisraptour](https://www.instagram.com/memphisraptour/) and [TikTok @memphis.rap.tour](https://www.tiktok.com/@memphis.rap.tour)." }),
          s("about-cta", "cta", { label: "Ready to ride?", heading: "Book a seat on the bus", body: "{schedule_long}. {duration}. {price}.", price: "", subtext: "", button_text: "Book a seat ›", button_href: "{book_url}", style: "gold" }),
        ],
      },
      {
        slug: "privacy", path: "/privacy", nav_label: "Privacy", in_nav: false,
        title: "Privacy | Memphis Rap Tour",
        description: "What the Memphis Rap Tour website collects, why, and how to unsubscribe from the email list.",
        h1: "Privacy",
        intro: "This page says what the Memphis Rap Tour website collects and why. In short: if you join the email list, we keep your email address and first name to send tour news, and you can unsubscribe any time.",
        sections: [
          s("privacy-list", "text", { heading: "What do we collect when you join the email list?", body: "- Your email address\n- Your first name, if you give it\n- The page you signed up on, the date, and the words of the box you ticked" }),
          s("privacy-why", "text", { heading: "Why do we keep it?", body: "To send Memphis Rap Tour news: new tour dates, private tour openings and Memphis rap news from the team." }),
          s("privacy-unsub", "text", { heading: "How do I unsubscribe?", body: "Use the unsubscribe link you get when you sign up, or email [{email}](mailto:{email}) and ask to be removed." }),
          s("privacy-visits", "text", { heading: "Do you track visits?", body: "The site counts page visits and taps on Book buttons per day, to see what works. It sets no cookies for visitors. To stop spam sign-ups, it keeps a scrambled (hashed) form of your connection's address for up to two days, then deletes it." }),
          s("privacy-booking", "text", { heading: "What about bookings?", body: "Tickets are booked on our booking page, run by Acuity Scheduling. What you enter there is handled by Acuity." }),
          s("privacy-contact", "text", { heading: "Who do I contact?", body: "Email [{email}](mailto:{email})." }),
        ],
      },
    ],
  };
}

/** Photos that ship with the site (Carlos's own, from the current site). */
export const SEED_IMAGES = [
  { id: "mural", storage: "asset:/photos/mural.jpg", content_type: "image/jpeg", width: 900, height: 1200, alt: "A rider poses with both hands pointing in front of a large painted mural of a woman's face on a brick wall in Memphis" },
  { id: "bus", storage: "asset:/photos/bus.jpg", content_type: "image/jpeg", width: 800, height: 800, alt: "Riders laughing and clapping in their seats while the guide stands in the aisle of the tour bus" },
];

// ---------- storage ----------

export interface Pointers { draft: number; published: number }

export async function ensureSeed(db: D1Database): Promise<void> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'published_version'").first<{ value: string }>();
  if (row) return;
  const t = now();
  const ins = await db
    .prepare("INSERT INTO versions (created_at, user_id, kind, note, content) VALUES (?, NULL, 'seed', 'First version, from the approved mock-up', ?) RETURNING id")
    .bind(t, JSON.stringify(seedContent()))
    .first<{ id: number }>();
  const id = String(ins!.id);
  const stmts = [
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('published_version', ?)").bind(id),
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('draft_version', ?)").bind(id),
    ...SEED_IMAGES.map((im) =>
      db
        .prepare("INSERT OR IGNORE INTO images (id, storage, content_type, bytes, width, height, alt, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)")
        .bind(im.id, im.storage, im.content_type, im.width, im.height, im.alt, t, t),
    ),
  ];
  await db.batch(stmts);
}

export async function pointers(db: D1Database): Promise<Pointers> {
  await ensureSeed(db);
  const rows = await db.prepare("SELECT key, value FROM settings WHERE key IN ('draft_version','published_version')").all<{ key: string; value: string }>();
  const m = Object.fromEntries(rows.results.map((r) => [r.key, Number(r.value)]));
  return { draft: m.draft_version, published: m.published_version };
}

export async function loadVersion(db: D1Database, id: number): Promise<{ content: Content; created_at: number } | null> {
  const row = await db.prepare("SELECT content, created_at FROM versions WHERE id = ?").bind(id).first<{ content: string; created_at: number }>();
  return row ? { content: JSON.parse(row.content) as Content, created_at: row.created_at } : null;
}

export async function loadDraft(db: D1Database): Promise<{ id: number; content: Content; created_at: number }> {
  const p = await pointers(db);
  const v = await loadVersion(db, p.draft);
  return { id: p.draft, ...v! };
}

/**
 * Apply a change to the latest draft and store it as a new version. The pointer only moves if nobody
 * else saved in between (compare-and-set); on a clash the change is re-applied to the newer draft once.
 * `mutate` returns an error message to refuse the change.
 */
export async function saveDraft(db: D1Database, userId: number | null, note: string, mutate: (c: Content) => string | void): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const draft = await loadDraft(db);
    const err = mutate(draft.content);
    if (err) return { ok: false, error: err };
    const ins = await db
      .prepare("INSERT INTO versions (created_at, user_id, kind, note, content) VALUES (?, ?, 'save', ?, ?) RETURNING id")
      .bind(now(), userId, note.slice(0, 200), JSON.stringify(draft.content))
      .first<{ id: number }>();
    const moved = await db
      .prepare("UPDATE settings SET value = ? WHERE key = 'draft_version' AND value = ?")
      .bind(String(ins!.id), String(draft.id))
      .run();
    if (moved.meta.changes === 1) return { ok: true, id: ins!.id };
  }
  return { ok: false, error: "Someone else was saving at the same moment. Nothing was lost; try again." };
}

export async function publishDraft(db: D1Database): Promise<number> {
  const p = await pointers(db);
  await db.prepare("UPDATE settings SET value = ? WHERE key = 'published_version'").bind(String(p.draft)).run();
  return p.draft;
}

/** Copy an old version to a new one and make it both the draft and the live site. */
export async function restoreVersion(db: D1Database, userId: number, versionId: number): Promise<number | null> {
  const v = await db.prepare("SELECT content, created_at FROM versions WHERE id = ?").bind(versionId).first<{ content: string; created_at: number }>();
  if (!v) return null;
  const ins = await db
    .prepare("INSERT INTO versions (created_at, user_id, kind, note, content) VALUES (?, ?, 'restore', ?, ?) RETURNING id")
    .bind(now(), userId, `Restored the version from save #${versionId}`, v.content)
    .first<{ id: number }>();
  const id = String(ins!.id);
  await db.batch([
    db.prepare("UPDATE settings SET value = ? WHERE key = 'draft_version'").bind(id),
    db.prepare("UPDATE settings SET value = ? WHERE key = 'published_version'").bind(id),
  ]);
  return ins!.id;
}

export function findPage(c: Content, slug: string): Page | undefined {
  return c.pages.find((p) => p.slug === slug);
}

export function findSection(c: Content, id: string): { page: Page; section: Section; index: number } | null {
  for (const page of c.pages) {
    const index = page.sections.findIndex((x) => x.id === id);
    if (index >= 0) return { page, section: page.sections[index], index };
  }
  return null;
}

export function defaultBlockData(type: BlockType): Record<string, string> {
  const d: Record<string, string> = {};
  for (const f of BLOCKS[type].fields) d[f.k] = "";
  if (type === "cta") Object.assign(d, { style: "gold", button_text: "Book a seat ›", button_href: "{book_url}", heading: "Book a seat on the bus" });
  if (type === "text") d.heading = "New section";
  if (type === "faq" || type === "reviews") d.limit = "0";
  if (type === "hero") Object.assign(d, { show_facts: "1", primary_text: "Book a seat ›" });
  return d;
}
