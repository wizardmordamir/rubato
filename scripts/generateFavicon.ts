/**
 * Regenerates the favicon from its single source of truth,
 * `ui/public/favicon.svg` (the violet eighth-note brand mark, drawn to fill the
 * frame so it stays legible at 16px).
 *
 * Output: ui/public/favicon.ico — a multi-resolution icon (16/32/48,
 * PNG-compressed entries, supported by all modern browsers).
 *
 * Edit favicon.svg, then run `bun run scripts/generateFavicon.ts`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const PUBLIC_DIR = join(import.meta.dir, "..", "ui", "public");
const svgPath = join(PUBLIC_DIR, "favicon.svg");

const renderPng = (size: number): Promise<Buffer> =>
	sharp(svgPath, { density: 384 })
		.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
		.png()
		.toBuffer();

/** Assemble an .ico containing PNG-compressed entries (supported by all modern browsers). */
const buildIco = (entries: { size: number; png: Buffer }[]): Buffer => {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type: icon
	header.writeUInt16LE(entries.length, 4);

	const dir = Buffer.alloc(16 * entries.length);
	let offset = 6 + dir.length;
	entries.forEach((entry, i) => {
		const base = i * 16;
		dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 0); // width (0 => 256)
		dir.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
		dir.writeUInt8(0, base + 2); // palette count
		dir.writeUInt8(0, base + 3); // reserved
		dir.writeUInt16LE(1, base + 4); // color planes
		dir.writeUInt16LE(32, base + 6); // bits per pixel
		dir.writeUInt32LE(entry.png.length, base + 8); // size of image data
		dir.writeUInt32LE(offset, base + 12); // offset of image data
		offset += entry.png.length;
	});

	return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
};

const main = async () => {
	const sizes = [16, 32, 48];
	const entries = await Promise.all(sizes.map(async (size) => ({ size, png: await renderPng(size) })));
	writeFileSync(join(PUBLIC_DIR, "favicon.ico"), buildIco(entries));
	console.log(`Wrote ui/public/favicon.ico (${sizes.join("/")}) from favicon.svg`);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
