# Writes columns.pdf, a two-column fixture for the PDF layout: a full-width
# title, then a left and a right column whose lines are interleaved in the
# content stream (as many papers' are), a bold numbered section heading at
# body size, and a second page. Run: python3 columns.py
def esc(s): return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
left = [("F1", "Left column opens the argument and"),
        ("F1", "keeps going down the page until"),
        ("F1", "it ends here."),
        ("F2", "2.1 No spinners"),
        ("F1", "Work is at your fingertips.")]
right = [("F1", "Right column follows on and"),
         ("F1", "finishes the thought."),
         ("F1", "A second right paragraph"),
         ("F1", "closes the page.")]
ops = ["BT /F2 20 Tf 72 720 Td (Two columns, read in order) Tj ET"]
rows = max(len(left), len(right))
y = 680
for i in range(rows):
    for x, col in ((72, left), (330, right)):
        if i < len(col):
            font, text = col[i]
            ops.append(f"BT /{font} 10 Tf {x} {y} Td ({esc(text)}) Tj ET")
    y -= 14 if i != 2 else 28
page1 = "\n".join(ops).encode()
page2 = b"BT /F1 10 Tf 72 700 Td (The second page says where it is.) Tj ET"
objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>"]
for i in range(2):
    objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents {5+i} 0 R >>".encode())
for content in (page1, page2):
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
out = bytearray(b"%PDF-1.4\n")
offsets = []
for n, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open("columns.pdf", "wb").write(out)
