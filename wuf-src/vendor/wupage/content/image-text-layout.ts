export interface ImageTextLayout {
  width: number;
  height: number;
  slices: Array<{ top: number; bottom: number }>;
  foreground: string;
  fontRatio: number;
}

// Only text assets with paragraph alternatives are eligible. A long photo
// description alone is not evidence that its pixels can be split into text.
export function readImageTextLayout(image: HTMLImageElement, paragraphs: number): ImageTextLayout | null {
  const source = image.currentSrc || image.src;
  if (paragraphs < 2 || !image.complete || !image.naturalWidth || !image.naturalHeight
    || !/(?:^|[/_.-])(?:txt|text|copy)(?=[/_.-]|$)/i.test(source.split(/[?#]/)[0])) return null;
  const scale = Math.min(1, 1200 / image.naturalWidth, 1600 / image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  try {
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return analyzeImageTextLayout(context.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width, canvas.height, paragraphs);
  } catch {
    // Cross-origin or unreadable pixels keep the ordinary image caption.
    return null;
  }
}

export function analyzeImageTextLayout(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  paragraphs: number
): ImageTextLayout | null {
  if (width < 1 || height < 1 || paragraphs < 2 || pixels.length !== width * height * 4) return null;
  const bands: Array<{ top: number; bottom: number }> = [];
  const colors = new Map<string, { count: number; rgb: number[] }>();
  let opaque = 0;
  let band: { top: number; bottom: number } | undefined;
  for (let y = 0; y < height; y++) {
    let ink = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset + 3] < 96) continue;
      ink++;
      opaque++;
      const rgb = [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
      const key = rgb.map((channel) => Math.round(channel / 24)).join(",");
      const color = colors.get(key);
      if (color) color.count++;
      else colors.set(key, { count: 1, rgb });
    }
    if (ink >= Math.max(2, width * 0.002)) {
      if (!band) { band = { top: y, bottom: y + 1 }; bands.push(band); }
      else band.bottom = y + 1;
    } else band = undefined;
  }
  // Text on transparent pixels leaves its original page background visible.
  // Opaque artwork, sparse icons and uncertain layouts retain the safe caption.
  const density = opaque / (width * height);
  if (density < 0.003 || density > 0.3 || bands.length < paragraphs) return null;
  const heights = bands.map((line) => line.bottom - line.top).filter((size) => size >= 3).sort((a, b) => a - b);
  const glyphHeight = heights[Math.floor(heights.length / 2)];
  if (!glyphHeight) return null;
  const gaps = bands.slice(1).map((line, index) => ({
    size: line.top - bands[index].bottom,
    middle: (line.top + bands[index].bottom) / 2
  })).sort((a, b) => b.size - a.size);
  const breaks = gaps.slice(0, paragraphs - 1);
  if (breaks.some((gap) => gap.size < glyphHeight * 0.65)) return null;
  const boundaries = [0, ...breaks.map((gap) => gap.middle).sort((a, b) => a - b), height];
  const foreground = [...colors.values()].sort((a, b) => b.count - a.count)[0]?.rgb;
  if (!foreground) return null;
  return {
    width,
    height,
    slices: boundaries.slice(0, -1).map((top, index) => ({ top, bottom: boundaries[index + 1] })),
    foreground: `rgb(${foreground.join(", ")})`,
    fontRatio: glyphHeight * 1.1 / width
  };
}
