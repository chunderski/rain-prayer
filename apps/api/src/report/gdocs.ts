/**
 * Google Docs renderer: turns a ReportDoc into documents.batchUpdate requests for a new, empty document.
 *
 * Index strategy: blocks are emitted last to first and every block is inserted at index 1, so each
 * block's own ranges are known exactly ([1, 1 + length)) and no running index has to be tracked across
 * tables and images. Requests in one batchUpdate apply in order, so the final document reads first to last.
 * Tables: insertTable at index L puts a newline at L and the table at L + 1; the paragraph of cell (r, c)
 * starts at L + 4 + r * (2 * columns + 1) + 2 * c. Cells are filled last to first so earlier indexes hold.
 * Text is inserted literally (no markup), so hostile finding text cannot change document structure.
 */
import { LOGO_IMAGE_ID, POWERED_BY, type Block, type ReportDoc } from "./model.js";

export type DocsRequest = Record<string, unknown>;
/** Image URI by photo id: a URL Google can fetch once at insertion time (see exports.ts). */
export type DocImageUris = Map<string, string>;

const IMAGE_WIDTH_PT = 440;
// Control characters other than tab and newline are rejected by the Docs API.
const clean = (s: string) => s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

type Named = "TITLE" | "SUBTITLE" | "HEADING_1" | "HEADING_2" | "HEADING_3" | "NORMAL_TEXT";

function paragraph(text: string, style: Named): DocsRequest[] {
  const t = `${clean(text)}\n`;
  return [
    { insertText: { location: { index: 1 }, text: t } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 1 + t.length }, paragraphStyle: { namedStyleType: style }, fields: "namedStyleType" } },
  ];
}

function table(header: string[], rows: string[][]): DocsRequest[] {
  const all = [header, ...rows];
  const cols = header.length;
  const out: DocsRequest[] = [
    { insertTable: { location: { index: 1 }, rows: all.length, columns: cols } },
    { updateParagraphStyle: { range: { startIndex: 1, endIndex: 2 }, paragraphStyle: { namedStyleType: "NORMAL_TEXT" }, fields: "namedStyleType" } },
  ];
  for (let r = all.length - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const text = clean(all[r]![c] ?? "");
      if (!text) continue;
      out.push({ insertText: { location: { index: 1 + 4 + r * (2 * cols + 1) + 2 * c }, text } });
    }
  }
  return out;
}

function blockRequests(b: Block, uris: DocImageUris): DocsRequest[] {
  switch (b.type) {
    case "heading":
      return paragraph(b.text, (["HEADING_1", "HEADING_2", "HEADING_3"] as const)[b.level - 1]!);
    case "paragraph":
      return paragraph(b.tone === "notice" ? `Notice: ${b.text}` : b.text, "NORMAL_TEXT");
    case "placeholder":
      return paragraph(b.text, "NORMAL_TEXT");
    case "bullets":
      // Plain bullet characters rather than native lists: native bullets would leak onto paragraphs inserted before them.
      return [...b.items].reverse().flatMap((i) => paragraph(`• ${i}`, "NORMAL_TEXT"));
    case "table":
      return table(b.header, b.rows);
    case "finding":
      // Inserted at index 1 in reverse, so the heading ends up first.
      return [...b.blocks].reverse().flatMap((x) => blockRequests(x, uris)).concat(paragraph(b.title, "HEADING_3"));
    case "image": {
      const uri = uris.get(b.image.photoId);
      const caption = paragraph(b.image.caption || "Finding photo", "NORMAL_TEXT");
      if (!uri) return paragraph(`Photo unavailable: ${b.image.caption || b.image.photoId}`, "NORMAL_TEXT");
      return [
        ...caption,
        ...paragraph("", "NORMAL_TEXT"),
        { insertInlineImage: { location: { index: 1 }, uri, objectSize: { width: { magnitude: IMAGE_WIDTH_PT, unit: "PT" } } } },
      ];
    }
  }
}

const rgb = (hex: string) => {
  const m = /^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/.exec(hex);
  if (!m) return null;
  return { red: parseInt(m[1]!, 16) / 255, green: parseInt(m[2]!, 16) / 255, blue: parseInt(m[3]!, 16) / 255 };
};

/** A paragraph whose text is set in a brand color (validated #RRGGBB; plain when invalid). */
function coloredParagraph(text: string, style: Named, hex: string): DocsRequest[] {
  const reqs = paragraph(text, style);
  const color = rgb(hex);
  const len = clean(text).length;
  if (!color || !len) return reqs;
  return [...reqs, { updateTextStyle: { range: { startIndex: 1, endIndex: 1 + len }, textStyle: { foregroundColor: { color: { rgbColor: color } } }, fields: "foregroundColor" } }];
}

export function renderDocsRequests(doc: ReportDoc, uris: DocImageUris): DocsRequest[] {
  const brand = doc.brand;
  const logo = uris.get(LOGO_IMAGE_ID);
  const blocks: { req: DocsRequest[] }[] = [
    ...(logo ? [{ req: [...paragraph("", "NORMAL_TEXT"), { insertInlineImage: { location: { index: 1 }, uri: logo, objectSize: { height: { magnitude: 48, unit: "PT" } } } }] }] : []),
    { req: coloredParagraph(doc.title, "TITLE", brand.primaryColor) },
    { req: paragraph(doc.subtitle, "SUBTITLE") },
    { req: coloredParagraph(doc.brandName, "NORMAL_TEXT", brand.primaryColor) },
    ...doc.blocks.map((b) => ({ req: blockRequests(b, uris) })),
    ...(brand.footer ? [{ req: paragraph(brand.footer, "NORMAL_TEXT") }] : []),
    ...(brand.contact ? [{ req: paragraph(brand.contact, "NORMAL_TEXT") }] : []),
    ...(brand.poweredBy ? [{ req: paragraph(POWERED_BY, "NORMAL_TEXT") }] : []),
  ];
  return blocks.reverse().flatMap((b) => b.req);
}

/** Splits requests into ordered batches (keeps each batchUpdate payload small). */
export function chunkRequests(reqs: DocsRequest[], size = 400): DocsRequest[][] {
  const out: DocsRequest[][] = [];
  for (let i = 0; i < reqs.length; i += size) out.push(reqs.slice(i, i + size));
  return out;
}
