# Writes repair.epub, a small EPUB 3 fixture for the EPUB adapter: metadata
# with an ISBN, a cover image, a nav document, a copyright page and two
# chapters with links, images and a script. Run: python3 make.py
import base64, zipfile
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==")
container = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""
opf = """<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:isbn:978-0-306-40615-7</dc:identifier>
    <dc:title>The Golden Seam</dc:title>
    <dc:creator>Ada Example</dc:creator>
    <dc:creator>Ben Sample</dc:creator>
    <dc:language>en</dc:language>
    <dc:date>2023-03-01</dc:date>
    <dc:publisher>Lacquer Press</dc:publisher>
    <dc:description>&lt;p&gt;A short book about &lt;b&gt;repair&lt;/b&gt; and patience.&lt;/p&gt;</dc:description>
    <meta property="dcterms:modified">2023-03-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
    <item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="copyright" href="text/copyright.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover"/>
    <itemref idref="nav" linear="no"/>
    <itemref idref="copyright"/>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"""
def page(title, body):
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>{title}</title><style>p {{ margin: 0 }}</style></head>
<body>{body}</body></html>"""
files = {
    "META-INF/container.xml": container,
    "OEBPS/content.opf": opf,
    "OEBPS/nav.xhtml": page("Contents", '<nav epub:type="toc"><ol><li><a href="text/chapter%201.xhtml">One</a></li></ol></nav>'),
    "OEBPS/text/cover.xhtml": page("Cover", '<img src="../images/cover.png" alt="Cover"/>'),
    "OEBPS/text/copyright.xhtml": page("Copyright", "<p>Copyright 2023 Ada Example. All rights reserved.</p>"),
    "OEBPS/text/chapter 1.xhtml": page("One", """<h1>One: The crack</h1>
<p>The bowl broke along an old <em>fault</em>. See <a href="chapter2.xhtml#mend">the mend</a> or <a href="https://example.org/kintsugi">a guide</a>.</p>
<p><img src="../images/cover.png" alt="a bowl"/>Gold follows the line.</p>
<script>alert('no')</script>"""),
    "OEBPS/text/chapter2.xhtml": page("Two", """<h1 id="mend">Two: The mend</h1>
<p>Lacquer, then gold, then waiting.</p>"""),
}
with zipfile.ZipFile("repair.epub", "w") as z:
    z.writestr(zipfile.ZipInfo("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
    for name, text in files.items():
        z.writestr(name, text, compress_type=zipfile.ZIP_DEFLATED)
    z.writestr("OEBPS/images/cover.png", PNG, compress_type=zipfile.ZIP_STORED)
