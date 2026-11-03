# Catalogue fixtures

Cohen XML files are bounded excerpts fetched on 2026-11-03 with web_fetch:

- https://longform.asmartbear.com/index.xml (first three items)
- https://longform.asmartbear.com/sitemap.xml (first five URLs)
- https://blog.asmartbear.com/feed/ (first two items)
- https://blog.asmartbear.com/sitemap.xml (all four sitemap locations)
- https://blog.asmartbear.com/post.xml (first four URLs)

Bodies, images and unrelated feed fields were removed; namespaces were
reserialized. Sitemap dates remain modification dates, not publication dates.

`pg-articles.html` is a synthetic, reduced table-index fixture with real
essay links/titles, not a recorded response: fetching Paul Graham's index
timed out. It exercises its legacy relative-link/table shape.
`pg-recorded.html` keeps the first four table rows from a public mirror:
https://github.com/evmn/Paul-Graham/blob/master/www.paulgraham.com/articles.html
read through web_fetch on 2026-11-03. It is not a current PG response.
Page chrome and the tracking query were removed; image links and a reduced
tracking script remain to test that discovery never executes or fetches them.

`history.atom` is synthetic, for archive pagination and content safety.
All network tests serve fixtures on loopback only.

Discovery scans at most 40 index pages and 5,000 entries by default, within
180 seconds. A report marks bounds with `truncated`; scans are not resumable.
Unknown publication dates stay absent, including all sitemap-only entries.
Sitemap-only titles are URL slugs until a feed or HTML index supplies a title.
