// A loopback fixture server for the Feed: a blog (with a page that links to
// its feed), a YouTube-style Atom channel, a podcast, a JSON Feed, a broken
// source, a page without a feed that changes on demand (KI-43), and a Google
// Books stand-in for followed authors, three news sites, a personal blog and an HN-style feed (KI-105). Dates are relative to now so items are always fresh, and
// artwork is generated locally: no test ever touches the live network.
//
//   node apps/desktop/test/feed-fixtures.ts    prints the base URL and waits
import { createServer, type Server } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { artworkSpecs, generateArtwork } = (await import(resolve(root, "scripts/seed-desktop.mjs"))) as {
  artworkSpecs: () => { width: number; height: number; palette: number[][]; pattern: string; seed: number }[];
  generateArtwork: (spec: unknown) => Buffer;
};

const HOUR = 3600_000;
const when = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
const rfc822 = (hoursAgo: number) => when(hoursAgo).toUTCString();
const iso = (hoursAgo: number) => when(hoursAgo).toISOString();
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const BLOG_TITLES = ["Tools that shape thinking", "On mending", "Small software"];

function blog(base: string) {
  const posts = [
    {
      slug: "tools",
      title: BLOG_TITLES[0],
      hours: 2,
      image: `${base}/art/1.png`,
      body: "<p>Every tool is an argument about what matters.</p><p>The pencil argues for slowness; the search box argues that everything is findable. A writer’s tools argue with each other, and the essay is what survives the argument.</p><script>alert('never')</script>",
    },
    { slug: "mending", title: BLOG_TITLES[1], hours: 30, image: `${base}/art/2.png`, body: "<p>Repair is a design material. Kintsugi makes the break the most beautiful part of the bowl.</p>" },
    { slug: "small", title: BLOG_TITLES[2], hours: 80, image: null, body: "<p>Software for one person can be strange and specific and wonderful.</p>" },
  ];
  const items = posts
    .map(
      (p) => `<item>
  <title>${escape(p.title)}</title>
  <link>${base}/quiet/posts/${p.slug}</link>
  <guid>${base}/quiet/posts/${p.slug}</guid>
  <dc:creator>Ada Writer</dc:creator>
  <pubDate>${rfc822(p.hours)}</pubDate>
  <description>${escape(p.body.replace(/<[^>]+>/g, " ").slice(0, 90))}</description>
  <content:encoded><![CDATA[${p.image ? `<p><img src="${p.image}"></p>` : ""}${p.body}]]></content:encoded>
</item>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>The Quiet Blog</title><link>${base}/quiet/</link><description>Essays on tools and attention</description>
${items}
</channel></rss>`;
}

function channel(base: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <id>yt:channel:fixture</id>
  <title>Slow Craft</title>
  <link rel="alternate" href="${base}/craft"/>
  <entry>
    <id>yt:video:dovetails</id>
    <title>Hand-cut dovetails, slowly</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123def45"/>
    <author><name>Slow Craft</name></author>
    <published>${iso(5)}</published>
    <updated>${iso(5)}</updated>
    <media:group>
      <media:title>Hand-cut dovetails, slowly</media:title>
      <media:content url="https://www.youtube.com/v/abc123def45?version=3" type="application/x-shockwave-flash" width="640" height="390"/>
      <media:thumbnail url="${base}/art/3.png" width="480" height="270"/>
      <media:description>An hour of quiet joinery, no music. Golden seams where the joints meet.</media:description>
    </media:group>
  </entry>
</feed>`;
}

function podcast(base: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Repair Hour</title><link>${base}/pod</link>
<item><title>Episode 12: Mending</title><guid isPermaLink="false">repair-12</guid><link>${base}/pod/12</link>
<pubDate>${rfc822(50)}</pubDate><description>Why broken things are interesting.</description>
<enclosure url="${base}/pod/12.mp3" length="1234" type="audio/mpeg"/></item>
</channel></rss>`;
}

function notes(base: string) {
  return JSON.stringify({
    version: "https://jsonfeed.org/version/1.1",
    title: "Field Notes",
    home_page_url: `${base}/notes/`,
    items: [{ id: "attention", url: `${base}/notes/attention`, title: "Attention is a garden", content_html: "<p>Attention is a garden.</p><p>Tend it.</p>", date_published: iso(1) }],
  });
}

/** KI-32's ranking fixture: a mixed newsletter, some close to the seeded clips (kintsugi, gold, repair, sleep), some far. */
export const WORKSHOP = [
  { slug: "gold", title: "Golden seams: kintsugi repair at home", author: "Mira Kane", hours: 9, body: "Kintsugi repair with gold lacquer: the broken bowl, the golden joinery, the seam that shows the repair." },
  { slug: "rest", title: "Why we sleep less in winter", author: "Sam Ode", hours: 4, body: "Sleep, rest and the long dark evenings: insomnia, naps and why bedtime drifts." },
  { slug: "football", title: "Transfer window: strikers and derby fixtures", author: "Lee Ball", hours: 1, body: "The league leaders chase a striker before the derby; goalkeeper fixtures and transfer fees." },
  { slug: "markets", title: "Quarterly earnings and dividend stocks", author: "Ann Fund", hours: 2, body: "Earnings season, dividend stocks, bond yields and a nervous market." },
  { slug: "web", title: "The quiet web is still here", author: "Mira Kane", hours: 12, body: "Small personal websites, slow blogs and the quiet web of people writing for themselves." },
  { slug: "glaze", title: "Mending a cracked glaze with gold", author: "Mira Kane", hours: 20, body: "A cracked glaze, mended with gold: kintsugi repair, lacquer and patience." },
  { slug: "gadget", title: "Unboxing the new charger", author: "Gil Tech", hours: 3, body: "Unboxing a charger, battery specs and a laptop stand." },
  { slug: "rain", title: "A short film about rain and attention", author: "Sam Ode", hours: 30, body: "Rain on a window, attention, and a short film about slowing down." },
];

function workshop(base: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Workshop Letters</title><link>${base}/workshop</link>
${WORKSHOP.map((p) => `<item><title>${escape(p.title)}</title><link>${base}/workshop/${p.slug}</link><guid>${base}/workshop/${p.slug}</guid>
<dc:creator>${p.author}</dc:creator><pubDate>${rfc822(p.hours)}</pubDate><description>${escape(p.body)}</description></item>`).join("\n")}
</channel></rss>`;
}

/**
 * KI-94's stories: three news feeds covering the same things. Lumen's
 * quarter runs across all three (five articles, long titles, one without a
 * picture); Kestrel Code's game rule across two; a third story's text asks
 * the mock summariser to fail ("mock-fail"). Each feed also has a story of its own.
 */
export const NEWS = {
  /** The first article to cover Lumen's quarter (its lead), and Kin's mock title. */
  quarter: "Lumen reports Q4 2026 earnings: $114.5 billion in revenue, up 12%",
  rule: "Kestrel Code now refuses to clone existing games",
  failing: "Harbor Q7 reactor test ends early",
  /** Each feed's story of its own. */
  alone: ["Tide tables, explained", "How old bridges carry new trucks", "Sourdough at altitude"],
};
type Post = { slug: string; title: string; hours: number; image?: number; body: string };
const NEWS_FEEDS: Record<string, { title: string; posts: Post[] }> = {
  orchard: {
    title: "Orchard Daily",
    posts: [
      { slug: "q4", title: "Lumen reports Q4 2026 earnings: $114.5 billion in revenue, up 12%", hours: 3, image: 4, body: "Lumen today reported fourth quarter revenue of $114.5 billion, up 12 percent, with record phone sales and services. Profit was $30.7 billion." },
      { slug: "forecast", title: "Lumen forecasts its biggest revenue quarter ever despite Duo supply constraints and memory prices that keep climbing through the winter", hours: 2, image: 2, body: "Lumen expects the December quarter to beat its record Q4 2026 earnings of $114.5 billion in revenue, though Duo supply is short and memory prices weigh on Lumen margins." },
      { slug: "stock", title: "Lumen stock drops nearly 3% after hours following Q4 2026 results", hours: 1, body: "Lumen shares fell nearly 3 percent after Lumen reported Q4 2026 earnings: $114.5 billion in revenue, up 12 percent, with record phone sales." },
      { slug: "tide", title: "Tide tables, explained", hours: 6, image: 2, body: "Why the tide comes in twice a day, and what the moon has to do with it." },
    ],
  },
  ledger: {
    title: "The Ledger",
    posts: [
      { slug: "lumen", title: "Lumen set a phone sales record in Q4 even without a new standard phone", hours: 2, image: 3, body: "Lumen's Q4 revenue was $114.5 billion, and phones made $57.6 billion, a record for the quarter without a new standard model." },
      { slug: "kestrel", title: "Kestrel Code now refuses to clone existing games", hours: 7, image: 1, body: "Kestrel changed the Kestrel Code system prompt so it won't re-create existing video games after a wave of AI-made ports and decompilations." },
      { slug: "harbor", title: "Harbor Q7 reactor test ends early", hours: 5, body: "The Harbor Q7 reactor test stopped after four minutes when a coolant valve stuck. (mock-fail)" },
      { slug: "bridges", title: "How old bridges carry new trucks", hours: 9, body: "Engineers on retrofitting a 1930s bridge for modern loads." },
    ],
  },
  bench: {
    title: "Bench Notes",
    posts: [
      { slug: "lumen", title: "Lumen reports fourth quarter results: $114.5 billion", hours: 3, body: "Lumen announced results for its fiscal Q4 2026: revenue of $114.5 billion, up 12 percent year over year, and record phone revenue." },
      { slug: "kestrel", title: "Kestrel Code's new rule against cloning games won't slow the copying much", hours: 6, body: "The Kestrel Code system prompt now tells the model not to clone existing video games. Bench Notes thinks the rule won't slow AI game ports much." },
      { slug: "harbor", title: "Harbor Q7 reactor test stopped after a valve stuck", hours: 4, image: 3, body: "Harbor's Q7 reactor ran for four minutes before a coolant valve stuck and the test ended. (mock-fail)" },
      { slug: "sourdough", title: "Sourdough at altitude", hours: 8, body: "Baking bread at 2,000 metres: less yeast, more water, shorter proofs." },
    ],
  },
};
/** Each news site's reporters (KI-105): several bylines say it's a publication, so its news groups. */
const REPORTERS = ["Priya Raman", "Tom Okafor", "Lena Fischer", "Sam Lee"];
function news(base: string, name: string) {
  const { title, posts } = NEWS_FEEDS[name];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>${title}</title><link>${base}/${name}</link>
${posts
  .map(
    (p, i) => `<item><title>${escape(p.title)}</title><link>${base}/${name}/${p.slug}</link><guid>${base}/${name}/${p.slug}</guid>
<dc:creator>${REPORTERS[(i + name.length) % REPORTERS.length]}</dc:creator><pubDate>${rfc822(p.hours)}</pubDate><description>${escape(p.body.replace(" (mock-fail)", ""))}</description>
<content:encoded><![CDATA[${p.image ? `<p><img src="${base}/art/${p.image}.png"></p>` : ""}<p>${p.body}</p>]]></content:encoded></item>`,
  )
  .join("\n")}
</channel></rss>`;
}

/**
 * KI-105's writing: a personal blog (one author, whose name is the blog's)
 * with an essay on the same quarter the news covers, in rich HTML, and a
 * Hacker News style feed whose item links to that essay. The essay must
 * never join the story, and its reader shows its structure.
 */
export const WRITING = {
  blog: "Ada Lin",
  essay: "What Lumen's Q4 2026 earnings taught me about my own numbers",
  heading: "The record that wasn't the point",
  caption: "My ledger, the analogue version.",
  hn: "Hacker News: Front Page",
};
function personal(base: string) {
  const essay = `<p>I read Lumen's Q4 2026 earnings the way I read my own studio's books: Lumen made $114.5 billion in revenue, up 12 percent, and I kept looking for the line nobody wants to talk about. My studio is tiny, and I still learned more from their quarter than from a year of my own spreadsheets.</p>
<h2>${WRITING.heading}</h2>
<p>Everyone led with the record phone sales. I kept looking at the <em>services</em> line, because that's the part of my own work I keep underpricing.<sup id="fnref:1"><a href="#fn:1">1</a></sup></p>
<blockquote><p>Revenue is a story you tell about last quarter. Margin is the one you tell about next year.</p></blockquote>
<p>Three things I'm changing:</p>
<ul><li>I'm pricing repairs by the hour, not by the bowl.</li><li>I'm writing down every job I turn away.</li><li>I'm keeping a plain list of what each piece cost me.</li></ul>
<figure><img src="${base}/art/2.png" alt="An open ledger on a workbench"><figcaption>${WRITING.caption}</figcaption></figure>
<p>The formula I use now is one line:</p>
<pre><code>=SUM(materials) + hours * rate</code></pre>
<p>Read <a href="${base}/ada/pricing">my older post on pricing</a> for the long version.</p>
<script>alert("never")</script>`;
  const posts = [
    { slug: "lumen", title: WRITING.essay, hours: 1, body: essay },
    { slug: "bowl", title: "Mending a bowl, slowly", hours: 40, body: "<p>I spent my weekend mending a cracked bowl. My hands still smell of lacquer, and I liked every hour of it.</p>" },
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${WRITING.blog}</title><link href="${base}/ada/" rel="alternate"/><id>${base}/ada/</id>
<updated>${iso(1)}</updated><author><name>${WRITING.blog}</name></author>
${posts.map((p) => `<entry><title>${escape(p.title)}</title><link href="${base}/ada/${p.slug}" rel="alternate"/><id>${base}/ada/${p.slug}</id>
<published>${iso(p.hours)}</published><updated>${iso(p.hours)}</updated><content type="html">${escape(p.body)}</content></entry>`).join("\n")}
</feed>`;
}
function hn(base: string) {
  const items = [
    { id: 46001234, title: WRITING.essay, link: `${base}/ada/lumen`, hours: 0.5, by: "pottery_dev" },
    { id: 46001100, title: "Show HN: A ledger for one-person studios", link: `${base}/ledger-app`, hours: 2, by: "maker" },
    { id: 46000990, title: "Tide gauges are moving to open data", link: `${base}/tides`, hours: 3, by: "oceans" },
    { id: 46000870, title: "A 1930s bridge carries modern trucks after a retrofit", link: `${base}/bridge`, hours: 4, by: "civil_eng" },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${WRITING.hn}</title><link>https://news.ycombinator.com/</link><description>Hacker News RSS</description><generator>hnrss v2.1.1</generator>
${items.map((i) => `<item><title><![CDATA[${i.title}]]></title><description><![CDATA[<p>Article URL: <a href="${i.link}">${i.link}</a></p><p>Comments URL: <a href="https://news.ycombinator.com/item?id=${i.id}">https://news.ycombinator.com/item?id=${i.id}</a></p><p>Points: 212</p>]]></description>
<pubDate>${rfc822(i.hours)}</pubDate><link>${i.link}</link><dc:creator>${i.by}</dc:creator><comments>https://news.ycombinator.com/item?id=${i.id}</comments><guid isPermaLink="false">https://news.ycombinator.com/item?id=${i.id}</guid></item>`).join("\n")}
</channel></rss>`;
}

/** The full article behind a post: more than the feed carries. */
const article = (slug: string) => `<!doctype html><html><head><title>${slug}</title></head><body><nav>Home · About</nav>
<article><h1>${slug}</h1><p>Every tool is an argument about what matters.</p>
<p>The pencil argues for slowness; the search box argues that everything is findable. A writer’s tools argue with each other, and the essay is what survives the argument.</p>
<p>This paragraph is only on the page, never in the feed: the full text came through the ingest engine.</p>
<p>${"A long middle that the feed leaves out. ".repeat(12)}</p></article><footer>© The Quiet Blog</footer></body></html>`;

const page = (base: string) => `<!doctype html><html><head><title>The Quiet Blog</title>
<link rel="alternate" type="application/rss+xml" title="The Quiet Blog" href="${base}/quiet/feed.xml"></head>
<body><h1>The Quiet Blog</h1></body></html>`;

/** A /now page without a feed. Version 1 and 2 differ only in dates and counters; 3 is a real edit. */
const now = (version: number) => {
  const [date, visitors, views] = [["November 3, 2026 at 9:14 am", "1,204", "2,301"], ["Nov 5th, 2026 at 14:02", "1,377", "3.4k"], ["December 1, 2026", "2,050", "9,812"]][version - 1];
  const reading = version < 3 ? "<li>The Dispossessed, for the second time</li>" : "<li>The Left Hand of Darkness</li>";
  const extra = version < 3 ? "" : "<p>Learning to bind books by hand.</p>";
  return `<!doctype html><html><head><title>Now · Ada</title><meta property="og:title" content="What I’m doing now"></head>
<body><nav>Home · ${visitors} visitors today</nav><main><h1>What I’m doing now</h1><p>Updated ${date}</p>
<h2>Reading</h2><ul><li>Piranesi by Susanna Clarke</li>${reading}</ul>
<h2>Writing</h2><p>An essay on slow software. ${views} views</p>${extra}</main><footer>© 2026 Ada</footer></body></html>`;
};

/** Google Books' volumes for inauthor:"Susanna Clarke", newest first, with links back to this server. */
const volumes = (base: string) =>
  JSON.stringify({
    kind: "books#volumes",
    items: [
      { id: "lost", volumeInfo: { title: "The Lost Garden", subtitle: "A Novel", authors: ["Susanna Clarke"], publisher: "Bloomsbury", publishedDate: iso(24 * 3).slice(0, 10), description: "A house with a garden that is never the same twice.", pageCount: 288, imageLinks: { thumbnail: `${base}/art/4.png` }, canonicalVolumeLink: `${base}/books/lost-garden` } },
      { id: "about", volumeInfo: { title: "Reading Susanna Clarke", authors: ["M. Critic"], publishedDate: iso(24 * 10).slice(0, 10) } },
      { id: "wood", volumeInfo: { title: "The Wood at Midwinter", authors: ["Susanna Clarke"], publishedDate: "2023-10-24", canonicalVolumeLink: `${base}/books/wood` } },
      { id: "piranesi", volumeInfo: { title: "Piranesi", authors: ["Susanna Clarke"], publishedDate: "2020-09-15", canonicalVolumeLink: `${base}/books/piranesi` } },
      { id: "jsmn", volumeInfo: { title: "Jonathan Strange & Mr Norrell", authors: ["Susanna Clarke"], publishedDate: "2004-09-08", canonicalVolumeLink: `${base}/books/jsmn` } },
    ],
  });

export type Fixtures = { base: string; hits: Map<string, number>; setNow: (version: number) => void; close: () => Promise<void> };

export async function startFeedFixtures(): Promise<Fixtures> {
  const art = artworkSpecs().map((spec) => generateArtwork({ ...spec, width: 360, height: 240 }));
  const hits = new Map<string, number>();
  let base = "";
  let nowVersion = 1;
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const send = (type: string, body: string | Buffer, status = 200) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const artwork = /^\/art\/(\d)\.png$/.exec(path);
    if (artwork && art[Number(artwork[1]) - 1]) return send("image/png", art[Number(artwork[1]) - 1]);
    if (path === "/now") {
      // Conditional requests: the same version's ETag gets a 304.
      const etag = `"now-${nowVersion}"`;
      if (req.headers["if-none-match"] === etag) {
        hits.set("/now:304", (hits.get("/now:304") ?? 0) + 1);
        res.writeHead(304, { etag });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag });
      return res.end(now(nowVersion));
    }
    if (path === "/books/v1/volumes") return send("application/json", volumes(base));
    const book = /^\/books\/([\w-]+)$/.exec(path);
    if (book) return send("text/html; charset=utf-8", `<!doctype html><html><head><title>${book[1]}</title></head><body><main><h1>${book[1]}</h1><p>A book page.</p></main></body></html>`);
    const post = /^\/quiet\/posts\/(\w+)$/.exec(path);
    if (post) return send("text/html; charset=utf-8", article(post[1]));
    switch (path) {
      case "/quiet/":
        return send("text/html; charset=utf-8", page(base));
      case "/quiet/feed.xml":
        return send("application/rss+xml", blog(base));
      case "/craft.atom":
        return send("application/atom+xml", channel(base));
      case "/pod.xml":
        return send("application/rss+xml", podcast(base));
      case "/workshop.xml":
        return send("application/rss+xml", workshop(base));
      case "/notes.json":
        return send("application/feed+json", notes(base));
      case "/orchard.xml":
      case "/ledger.xml":
      case "/bench.xml":
        return send("application/rss+xml", news(base, path.slice(1, -4)));
      case "/ada.atom":
        return send("application/atom+xml", personal(base));
      case "/hn.xml":
        return send("application/rss+xml", hn(base));
      case "/broken.xml":
        return send("text/plain", "down for maintenance", 503);
      default:
        return send("text/plain", "not found", 404);
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server has no port");
  base = `http://127.0.0.1:${address.port}`;
  return { base, hits, setNow: (version) => void (nowVersion = version), close: () => new Promise((done) => server.close(() => done())) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { base } = await startFeedFixtures();
  console.log(`Feed fixtures at ${base}: /quiet/ /craft.atom /pod.xml /notes.json /workshop.xml /orchard.xml /ledger.xml /bench.xml /ada.atom /hn.xml /broken.xml /now /books/v1/volumes`);
}
