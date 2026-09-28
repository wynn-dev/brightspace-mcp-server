/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { createIsomorphicCanvasFactory, extractText, getDocumentProxy } from "unpdf";
import { log } from "./logger.js";
import { ContentReadError, textSliceEnd } from "./content-reader.js";

export interface PdfReadPosition { page: number; offset: number }

/** Longest rendered edge; keeps a page legible while staying well under model image limits. */
const IMAGE_LONG_EDGE = 1200;
const JPEG_QUALITY = 80;
/** Pages per response: images are far larger than text, so fewer pages fit when rendering. */
const MAX_PAGES = 20;
const MAX_IMAGE_PAGES = 5;

export interface PdfPageImage { page: number; mimeType: "image/jpeg"; data: string; width: number; height: number }

type CanvasFactory = Awaited<ReturnType<typeof createIsomorphicCanvasFactory>>;
let canvasFactory: Promise<CanvasFactory | null> | undefined;
/** Rendering needs the native @napi-rs/canvas binary; without it, reading falls back to text only. */
function loadCanvasFactory(): Promise<CanvasFactory | null> {
  canvasFactory ??= createIsomorphicCanvasFactory(() => import("@napi-rs/canvas")).catch((error) => {
    log("WARN", "PDF page rendering unavailable; returning text only", error);
    return null;
  });
  return canvasFactory;
}

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>>;
async function renderPage(page: PdfPage, Factory: CanvasFactory): Promise<Omit<PdfPageImage, "page">> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: IMAGE_LONG_EDGE / Math.max(base.width, base.height) });
  const factory = new Factory({});
  const drawing = factory.create(Math.round(viewport.width), Math.round(viewport.height));
  try {
    // PDF.js types the DOM canvas; @napi-rs/canvas implements the same drawing API.
    await page.render({ canvas: drawing.canvas, canvasContext: drawing.context, viewport } as unknown as Parameters<PdfPage["render"]>[0]).promise;
    const canvas = drawing.canvas as unknown as { width: number; height: number; encode(format: "jpeg", quality: number): Promise<Buffer> };
    const jpeg = await canvas.encode("jpeg", JPEG_QUALITY);
    return { mimeType: "image/jpeg", data: jpeg.toString("base64"), width: canvas.width, height: canvas.height };
  } finally {
    factory.destroy(drawing);
  }
}

/**
 * Read sequentially, limiting both text and page count (including blank pages).
 * With `images`, each page that starts in this response is also rendered, so
 * scans, diagrams and equations stay readable; a page continued from an
 * earlier response is not rendered again.
 */
export async function readPdfPages(
  buffer: Buffer,
  position: PdfReadPosition,
  endPage: number | undefined,
  maxChars: number,
  options: { images?: boolean } = {}
) {
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    const Factory = options.images ? await loadCanvasFactory() : null;
    // PDF.js diagnostics must not write to stdout on the stdio transport.
    document = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0, ...Factory ? { CanvasFactory: Factory } : {} });
    const lastPage = endPage ?? document.numPages;
    if (position.page > lastPage || lastPage > document.numPages) {
      throw new ContentReadError(`Invalid page range. This PDF has ${document.numPages} pages.`);
    }
    const pages: Array<{ page: number; offset: number; text: string; hasText: boolean; imageIncluded: boolean }> = [];
    const images: PdfPageImage[] = [];
    let renderFailures = 0;
    const maxPages = Factory ? MAX_IMAGE_PAGES : MAX_PAGES;
    let remaining = maxChars;
    let pageNumber = position.page;
    let offset = position.offset;
    while (pageNumber <= lastPage && pages.length < maxPages && remaining > 0) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("");
        if (offset > text.length) throw new ContentReadError("Invalid continuation offset. Restart reading this document.");
        const end = textSliceEnd(text, offset, remaining);
        if (end === offset && text.length > offset) break;
        let imageIncluded = false;
        if (Factory && offset === 0) {
          try {
            images.push({ page: pageNumber, ...await renderPage(page, Factory) });
            imageIncluded = true;
          } catch (error) {
            renderFailures++;
            log("WARN", `Could not render PDF page ${pageNumber}`, error);
          }
        }
        pages.push({ page: pageNumber, offset, text: text.slice(offset, end), hasText: text.trim().length > 0, imageIncluded });
        remaining -= end - offset;
        if (end < text.length) {
          offset = end;
          break;
        }
        pageNumber++;
        offset = 0;
      } finally {
        page.cleanup();
      }
    }
    return {
      totalPages: document.numPages,
      endPage: lastPage,
      pages,
      images,
      imagesAvailable: !options.images || Factory !== null,
      renderFailures,
      next: pageNumber <= lastPage ? { page: pageNumber, offset } : null,
    };
  } catch (error) {
    if (error instanceof ContentReadError) throw error;
    if (error instanceof Error && error.name === "PasswordException") {
      throw new ContentReadError("This PDF is password-protected. Reading encrypted PDFs is not supported.");
    }
    throw new ContentReadError("Could not extract this PDF. It may be malformed or use unsupported PDF features.");
  } finally {
    await document?.loadingTask.destroy();
  }
}

/**
 * Extract text content from a PDF buffer.
 * Returns null on failure (graceful degradation — download still works).
 */
export async function extractPdfText(
  buffer: Buffer
): Promise<{ text: string; totalPages: number } | null> {
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    document = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    const result = await extractText(document, {
      mergePages: true,
    });
    return {
      text: result.text as string,
      totalPages: result.totalPages,
    };
  } catch (error) {
    log("ERROR", "Failed to extract text from PDF", error);
    return null;
  } finally {
    await document?.loadingTask.destroy();
  }
}
