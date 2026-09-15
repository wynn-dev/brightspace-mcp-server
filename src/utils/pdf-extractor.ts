/**
 * Purdue Brightspace MCP Server
 * Copyright (c) 2026 Rohan Muppa. All rights reserved.
 * Licensed under MIT — see LICENSE file for details.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { log } from "./logger.js";
import { ContentReadError, textSliceEnd } from "./content-reader.js";

export interface PdfReadPosition { page: number; offset: number }

/** Read sequentially, limiting both text and page count (including blank pages). */
export async function readPdfPages(
  buffer: Buffer,
  position: PdfReadPosition,
  endPage: number | undefined,
  maxChars: number
) {
  let document: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  try {
    // PDF.js diagnostics must not write to stdout on the stdio transport.
    document = await getDocumentProxy(new Uint8Array(buffer), { verbosity: 0 });
    const lastPage = endPage ?? document.numPages;
    if (position.page > lastPage || lastPage > document.numPages) {
      throw new ContentReadError(`Invalid page range. This PDF has ${document.numPages} pages.`);
    }
    const pages: Array<{ page: number; offset: number; text: string; hasText: boolean }> = [];
    let remaining = maxChars;
    let pageNumber = position.page;
    let offset = position.offset;
    while (pageNumber <= lastPage && pages.length < 20 && remaining > 0) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : "") : "").join("");
        if (offset > text.length) throw new ContentReadError("Invalid continuation offset. Restart reading this document.");
        const end = textSliceEnd(text, offset, remaining);
        if (end === offset && text.length > offset) break;
        pages.push({ page: pageNumber, offset, text: text.slice(offset, end), hasText: text.trim().length > 0 });
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
