/** Price book helpers shared by the routes and the seed loader (template import, row mapping). */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UpsertPriceBookItem } from "@sentinel/shared";
import type { z } from "zod";

/** Owned by the channel product manager; illustrative placeholder prices only. */
export const DEFAULT_TEMPLATE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/price-book-template.json");

export type TemplateItem = Omit<z.infer<typeof UpsertPriceBookItem>, "id">;

export const PRICE_ITEM_COLS = `id, sku, name, description, category, unit, material_cost AS "materialCost", labor_hours AS "laborHours",
  default_margin_pct AS "defaultMarginPct", control_ids AS "controlIds", asset_types AS "assetTypes", tier, active, from_template AS "fromTemplate"`;

/**
 * Reads the template file ({items: [...]} or a bare array). Returns null when the file is absent.
 * Items that fail the shared schema are counted as invalid and never imported.
 */
export function loadPriceBookTemplate(path = DEFAULT_TEMPLATE_PATH): { items: TemplateItem[]; invalid: number } | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { items?: unknown })?.items) ? (raw as { items: unknown[] }).items : [];
  const items: TemplateItem[] = [];
  let invalid = 0;
  for (const it of list) {
    const r = UpsertPriceBookItem.safeParse(it);
    if (r.success) {
      const { id: _id, ...rest } = r.data;
      items.push(rest);
    } else invalid++;
  }
  return { items, invalid };
}

type Q = (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }>;

/** Inserts template items into the current tenant (RLS context must be set), skipping existing skus. */
export async function importTemplateItems(q: Q, tenantId: string, userId: string | null, items: TemplateItem[]): Promise<{ added: number; skipped: number }> {
  let added = 0;
  let skipped = 0;
  for (const it of items) {
    const r = await q(
      `INSERT INTO price_book_item (id, tenant_id, sku, name, description, category, unit, material_cost, labor_hours, default_margin_pct,
                                    control_ids, asset_types, tier, active, from_template, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, true, $15, $15)
       ON CONFLICT ON CONSTRAINT price_book_item_sku_key DO NOTHING`,
      [randomUUID(), tenantId, it.sku, it.name, it.description, it.category, it.unit, it.materialCost, it.laborHours, it.defaultMarginPct,
        it.controlIds, it.assetTypes, it.tier, it.active, userId],
    );
    if (r.rowCount) added++;
    else skipped++;
  }
  return { added, skipped };
}
