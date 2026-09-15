import { describe, expect, it, vi } from "vitest";
import { contentFilename, decodeContent, readContentBytes } from "../../src/utils/content-reader.js";

describe("content file reading", () => {
  it("cancels an oversized declared body without reading it", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "Content-Length": "9" } });
    await expect(readContentBytes(response, 8)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([{}, { "Content-Length": "1" }])("cancels oversized streamed bodies with headers %j", async (headers) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(5)); }, cancel,
    }), { headers });
    await expect(readContentBytes(response, 8)).rejects.toThrow(/too large/);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("accepts a file exactly at the byte limit", async () => {
    expect(await readContentBytes(new Response("12345678"), 8)).toEqual(Buffer.from("12345678"));
  });

  it("parses Unicode and quoted filenames", () => {
    expect(contentFilename("attachment; filename*=UTF-8''Lecture%20%C3%A9.pdf")).toBe("Lecture é.pdf");
    expect(contentFilename('attachment; filename="Lecture; 1.pdf"')).toBe("Lecture; 1.pdf");
    expect(contentFilename("", "/content/enforced/course/notes.txt")).toBe("notes.txt");
  });

  it("decodes UTF-16 with a BOM and a declared legacy charset", async () => {
    expect(await decodeContent(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello", "utf16le")]), "text/plain", "notes.txt"))
      .toMatchObject({ format: "text", text: "Hello" });
    expect(await decodeContent(Buffer.from([0x63, 0x61, 0x66, 0xe9]), "text/plain; charset=windows-1252", "notes.txt"))
      .toMatchObject({ text: "café" });
  });

  it("rejects binary data even when labelled text", async () => {
    await expect(decodeContent(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(32).fill(0)]), "text/plain", "notes.txt"))
      .rejects.toThrow(/Unsupported/);
    await expect(decodeContent(Buffer.from([0, 1, 2]), "text/plain", "notes.txt")).rejects.toThrow(/binary/);
  });

  it("converts HTML fragments and removes scripts/styles", async () => {
    const result = await decodeContent(Buffer.from('<h1>Lab</h1><p>Read <strong>this</strong>.</p><script>alert(1)</script><style>p{color:red}</style>'), "text/html", "lab.html");
    expect(result).toMatchObject({ format: "markdown", text: "# Lab\n\nRead **this**." });
  });
});
