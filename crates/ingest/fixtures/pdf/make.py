# Writes repair.pdf, a two-page fixture for the PDF adapter: a running
# header, page numbers, headings in a larger bold font, wrapped body lines
# with a hyphenated break, and document metadata. Run: python3 make.py
def esc(s): return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
def page(heading, body, number):
    ops = ["BT /F1 9 Tf 72 760 Td (Journal of Repair) Tj ET",
           f"BT /F2 22 Tf 72 700 Td ({esc(heading)}) Tj ET"]
    y = 670
    for line in body:
        if line == "":
            y -= 10
            continue
        ops.append(f"BT /F1 11 Tf 72 {y} Td ({esc(line)}) Tj ET")
        y -= 15
    ops.append(f"BT /F1 9 Tf 300 40 Td ({number}) Tj ET")
    return "\n".join(ops).encode()
pages = [
    page("The golden seam", [
        "Kintsugi repairs broken pottery with lacquer dusted in gold, so the",
        "crack becomes the most visible part of the bowl. The repair is not",
        "hidden; it is part of the object's his-",
        "tory and its beauty.",
        "",
        "Menders work slowly, in thin layers.",
    ], 1),
    page("Patience", [
        "Urushi lacquer cures in a humid cabinet over weeks. Each coat must",
        "harden before the next, and rushing it ruins the seam.",
    ], 2),
]
objs = []
objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
objs.append(b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>")
for i in range(2):
    objs.append(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents {5+i} 0 R >>".encode())
for content in pages:
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>")
objs.append(b"<< /Title (Kintsugi and the Art of Repair) /Author (Ada Example) /Subject (Mending pottery with gold) /Keywords (kintsugi, repair) /CreationDate (D:20240501100000Z) >>")
out = bytearray(b"%PDF-1.4\n")
offsets = []
for n, body in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % n + body + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for o in offsets:
    out += b"%010d 00000 n \n" % o
out += b"trailer\n<< /Size %d /Root 1 0 R /Info %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, len(objs), xref)
open("repair.pdf", "wb").write(out)
