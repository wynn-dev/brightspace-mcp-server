import { fileTypeFromBuffer } from "file-type";
import { ContentReadError } from "./content-reader.js";

/** Claude's recommended maximum edge; larger images are downscaled server-side anyway. */
export const IMAGE_LONG_EDGE = 1568;
/** Decoding is refused above this many pixels (decompression-bomb guard). */
const MAX_PIXELS = 40_000_000;
/** Formats models accept directly; others are re-encoded as JPEG. */
const PASSTHROUGH = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const SUPPORTED = new Set([...PASSTHROUGH, "image/bmp"]);
/** Keep passthrough images well under the ~5 MB base64 image limit of model APIs. */
const MAX_PASSTHROUGH_BYTES = 3_500_000;
const JPEG_QUALITY = 85;

export interface ImageContent {
  mimeType: string;
  data: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  resized: boolean;
}

/** Read dimensions from the file header so oversized images are rejected before decoding. */
export function imageDimensions(buffer: Buffer, mime: string): { width: number; height: number } | null {
  try {
    switch (mime) {
      case "image/png":
        return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
      case "image/gif":
        return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
      case "image/bmp":
        return { width: Math.abs(buffer.readInt32LE(18)), height: Math.abs(buffer.readInt32LE(22)) };
      case "image/webp": {
        const chunk = buffer.toString("ascii", 12, 16);
        if (chunk === "VP8 ") return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        if (chunk === "VP8L") {
          const [b0, b1, b2, b3] = buffer.subarray(21, 25);
          return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
        }
        if (chunk === "VP8X") return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
        return null;
      }
      case "image/jpeg": {
        let i = 2;
        while (i + 9 < buffer.length) {
          if (buffer[i] !== 0xff) { i++; continue; }
          const marker = buffer[i + 1];
          // Start-of-frame markers carry the dimensions (C4, C8 and CC are not frames).
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
            return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
          i += 2 + buffer.readUInt16BE(i + 2);
        }
        return null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Return an image file as a model-ready image, or null when the bytes are not
 * an image. Small images in common formats pass through unchanged; large or
 * uncommon ones are downscaled and re-encoded as JPEG.
 */
export async function readImage(buffer: Buffer): Promise<ImageContent | null> {
  let detected;
  try { detected = await fileTypeFromBuffer(buffer); } catch { return null; }
  if (!detected?.mime.startsWith("image/")) return null;
  const mime = detected.mime;
  if (!SUPPORTED.has(mime)) throw new ContentReadError(`Unsupported image type: ${mime}. Supported images: PNG, JPEG, GIF, WebP and BMP.`);
  const size = imageDimensions(buffer, mime);
  if (!size || !size.width || !size.height) throw new ContentReadError("Could not read the image dimensions; the file may be damaged.");
  if (size.width * size.height > MAX_PIXELS) throw new ContentReadError(`Image is too large to process (${size.width}x${size.height}).`);

  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(size.width, size.height));
  if (scale === 1 && PASSTHROUGH.has(mime) && buffer.length <= MAX_PASSTHROUGH_BYTES) {
    return { mimeType: mime, data: buffer.toString("base64"), ...size, originalWidth: size.width, originalHeight: size.height, resized: false };
  }

  let canvasModule: typeof import("@napi-rs/canvas");
  try { canvasModule = await import("@napi-rs/canvas"); } catch {
    throw new ContentReadError("This image needs resizing, but image processing is unavailable on this server.");
  }
  try {
    const image = await canvasModule.loadImage(buffer);
    const width = Math.max(1, Math.round(size.width * scale)), height = Math.max(1, Math.round(size.height * scale));
    const canvas = canvasModule.createCanvas(width, height);
    const context = canvas.getContext("2d");
    // JPEG has no alpha channel: flatten transparency onto white.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const jpeg = await canvas.encode("jpeg", JPEG_QUALITY);
    return { mimeType: "image/jpeg", data: jpeg.toString("base64"), width, height, originalWidth: size.width, originalHeight: size.height, resized: scale < 1 };
  } catch {
    throw new ContentReadError("Could not decode this image; the file may be damaged.");
  }
}
