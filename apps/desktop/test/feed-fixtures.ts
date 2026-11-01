// A loopback fixture server for the Feed: a blog (with a page that links to
// its feed), a YouTube-style Atom channel, a podcast, a JSON Feed, and a
// broken source. Dates are relative to now so items are always fresh, and
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

/** The full article behind a post: more than the feed carries. */
const article = (slug: string) => `<!doctype html><html><head><title>${slug}</title></head><body><nav>Home · About</nav>
<article><h1>${slug}</h1><p>Every tool is an argument about what matters.</p>
<p>The pencil argues for slowness; the search box argues that everything is findable. A writer’s tools argue with each other, and the essay is what survives the argument.</p>
<p>This paragraph is only on the page, never in the feed: the full text came through the ingest engine.</p>
<p>${"A long middle that the feed leaves out. ".repeat(12)}</p></article><footer>© The Quiet Blog</footer></body></html>`;

const page = (base: string) => `<!doctype html><html><head><title>The Quiet Blog</title>
<link rel="alternate" type="application/rss+xml" title="The Quiet Blog" href="${base}/quiet/feed.xml"></head>
<body><h1>The Quiet Blog</h1></body></html>`;

export type Fixtures = { base: string; hits: Map<string, number>; close: () => Promise<void> };

export async function startFeedFixtures(): Promise<Fixtures> {
  const art = artworkSpecs().map((spec) => generateArtwork({ ...spec, width: 360, height: 240 }));
  const hits = new Map<string, number>();
  let base = "";
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    const send = (type: string, body: string | Buffer, status = 200) => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    const artwork = /^\/art\/(\d)\.png$/.exec(path);
    if (artwork && art[Number(artwork[1]) - 1]) return send("image/png", art[Number(artwork[1]) - 1]);
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
      case "/notes.json":
        return send("application/feed+json", notes(base));
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
  return { base, hits, close: () => new Promise((done) => server.close(() => done())) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { base } = await startFeedFixtures();
  console.log(`Feed fixtures at ${base}: /quiet/ /craft.atom /pod.xml /notes.json /broken.xml`);
}
