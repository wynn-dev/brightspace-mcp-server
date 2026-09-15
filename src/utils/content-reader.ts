import { fileTypeFromBuffer } from "file-type";
import TurndownService from "turndown";
import { MAX_FILE_SIZE } from "./file-validator.js";

/** Only these errors carry messages suitable for returning to a client. */
export class ContentReadError extends Error {}

/** Enforce the limit while streaming, even with missing/incorrect headers. */
export async function readContentBytes(response: Response, limit = MAX_FILE_SIZE): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new ContentReadError(`File too large. Maximum allowed: ${limit / 1024 / 1024} MiB.`);
  }
  if (!response.body) throw new ContentReadError("The file response has no body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new ContentReadError(`File too large. Maximum allowed: ${limit / 1024 / 1024} MiB.`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function contentFilename(disposition: string, fallback = "document"): string {
  const extended = disposition.match(/filename\*\s*=\s*(?:UTF-8'[^']*')?([^;]+)/i);
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]*)"|([^;]*))/i);
  let name = extended?.[1]?.trim() ?? plain?.[1] ?? plain?.[2]?.trim() ?? fallback;
  if (extended) {
    try { name = decodeURIComponent(name); } catch { /* Keep malformed names readable. */ }
  }
  // Metadata only, never a filesystem path.
  return name.replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).pop()?.slice(0, 255) || "document";
}

const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
markdown.remove(["script", "style", "head"]);

export type ReadableContent =
  | { mimeType: "application/pdf"; format: "pdf" }
  | { mimeType: "text/html" | "text/plain"; format: "markdown" | "text"; text: string };

export async function decodeContent(buffer: Buffer, contentType: string, filename: string): Promise<ReadableContent> {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  // Recognize damaged PDF inputs as PDFs so parsing produces a useful error.
  if (buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    return { mimeType: "application/pdf", format: "pdf" };
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(filename)) {
    throw new ContentReadError("Invalid PDF: the file has no PDF signature.");
  }
  let detected;
  try { detected = await fileTypeFromBuffer(buffer); } catch {
    throw new ContentReadError("Unsupported or malformed file. Supported formats: PDF, HTML, and plain text.");
  }
  if (detected) {
    throw new ContentReadError(`Unsupported file type: ${detected.mime}. Supported formats: PDF, HTML, and plain text.`);
  }

  const charset = contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1];
  const bomEncoding = buffer[0] === 0xff && buffer[1] === 0xfe ? "utf-16le"
    : buffer[0] === 0xfe && buffer[1] === 0xff ? "utf-16be" : undefined;
  let text: string;
  try {
    text = new TextDecoder(bomEncoding ?? charset ?? "utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ContentReadError("Unsupported text encoding or binary file. Use UTF-8, a Unicode BOM, or a supported charset in Content-Type.");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new ContentReadError("Unsupported binary file. Supported formats: PDF, HTML, and plain text.");
  }
  const isHtml = mime === "text/html" || mime === "application/xhtml+xml"
    || /\.html?$/i.test(filename) || /^\s*(?:<!doctype\s+html|<html\b)/i.test(text);
  if (isHtml) {
    try {
      return { mimeType: "text/html", format: "markdown", text: markdown.turndown(text) };
    } catch {
      throw new ContentReadError("Could not convert the HTML document to Markdown.");
    }
  }
  if (mime && !mime.startsWith("text/") && !["application/octet-stream", "application/json"].includes(mime)) {
    throw new ContentReadError(`Unsupported file type: ${mime}. Supported formats: PDF, HTML, and plain text.`);
  }
  return { mimeType: "text/plain", format: "text", text };
}

/** Do not split a UTF-16 surrogate pair at a response boundary. */
export function textSliceEnd(text: string, offset: number, budget: number): number {
  let end = Math.min(text.length, offset + budget);
  if (end > offset && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return end;
}
