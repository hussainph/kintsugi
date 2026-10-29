export type Rgb = readonly [number, number, number];

/** WCAG 2.x contrast for opaque, already-composited sRGB samples (channels 0–255). */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const luminance = (rgb: Rgb) => {
    if (
      rgb.length !== 3 ||
      rgb.some(
        (channel) => !Number.isFinite(channel) || channel < 0 || channel > 255,
      )
    )
      throw new RangeError(
        "sRGB channels must be finite numbers between 0 and 255",
      );
    const linear = rgb.map((channel) => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
