// Each line marked `expect:` must report exactly those rules.
export function Card({ title }: { title: string }) {
  return (
    <section>
      <p className="text-[11px] uppercase text-muted-foreground">About this note</p> {/* expect: eyebrow-uppercase */}
      <span className="text-xs tracking-wide">Helper report</span> {/* expect: eyebrow-tracking */}
      <span className="md:uppercase tracking-[0.06em]">Hunch</span> {/* expect: eyebrow-uppercase eyebrow-tracking */}
      <span className={cn("block", "tracking-widest")}>Evidence</span> {/* expect: eyebrow-tracking */}
      <span style={{ textTransform: "uppercase" }}>Why</span> {/* expect: eyebrow-uppercase */}
      <span style={{ letterSpacing: "0.04em" }}>Why</span> {/* expect: eyebrow-tracking */}
      <span style={{ fontVariant: "small-caps" }}>Why</span> {/* expect: eyebrow-small-caps */}
      <h2>{title}</h2>
    </section>
  );
}
const theme = {
  ".label": { fontSize: "11px", letterSpacing: ".04em", textTransform: "uppercase" }, // expect: eyebrow-tracking eyebrow-uppercase
};
const css = `
.callout-label { font-size: 11px; letter-spacing: .06em; } /* expect: eyebrow-tracking */
.kicker { text-transform: uppercase; } /* expect: eyebrow-uppercase */
`;
const typst = `#let callout(label, body) = block[#text(tracking: 0.04em, upper(label)) #body]`; // expect: eyebrow-tracking eyebrow-uppercase
