import { describe, it, expect } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { readImage, imageDimensions } from "../../src/utils/image-reader.js";

async function encode(width: number, height: number, format: "png" | "jpeg" | "webp") {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#336699"; context.fillRect(0, 0, width, height);
  return format === "png" ? canvas.encode("png") : canvas.encode(format, 90);
}

describe("image reader", () => {
  it.each(["png", "jpeg", "webp"] as const)("reads %s dimensions from the header", async format => {
    const mime = `image/${format}`;
    expect(imageDimensions(await encode(321, 123, format), mime)).toEqual({ width: 321, height: 123 });
  });

  it("reads GIF and BMP headers", () => {
    const gif = Buffer.from("GIF89a\x40\x01\xc8\x00", "latin1");
    expect(imageDimensions(gif, "image/gif")).toEqual({ width: 320, height: 200 });
    const bmp = Buffer.alloc(30); bmp.write("BM"); bmp.writeInt32LE(640, 18); bmp.writeInt32LE(-480, 22);
    expect(imageDimensions(bmp, "image/bmp")).toEqual({ width: 640, height: 480 });
  });

  it("passes small common images through unchanged", async () => {
    const png = await encode(200, 100, "png");
    expect(await readImage(png)).toEqual({ mimeType: "image/png", data: png.toString("base64"), width: 200, height: 100,
      originalWidth: 200, originalHeight: 100, resized: false });
  });

  it("downscales large images to the long-edge limit as JPEG", async () => {
    const image = await readImage(await encode(3000, 1500, "png"));
    expect(image).toMatchObject({ mimeType: "image/jpeg", width: 1568, height: 784, originalWidth: 3000, originalHeight: 1500, resized: true });
    expect(Buffer.from(image!.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("rejects oversized headers before decoding, unsupported images, and ignores non-images", async () => {
    const huge = await encode(10, 10, "png"); huge.writeUInt32BE(100_000, 16); huge.writeUInt32BE(100_000, 20);
    await expect(readImage(huge)).rejects.toThrow(/too large/);
    const tiff = Buffer.concat([Buffer.from("II*\0", "latin1"), Buffer.alloc(64)]);
    await expect(readImage(tiff)).rejects.toThrow(/Unsupported image type: image\/tiff/);
    expect(await readImage(Buffer.from("plain text"))).toBeNull();
  });
});
