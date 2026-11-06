/** Phase 4 price book (per tenant, sku unique) and quote settings. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { PriceCategory, UpsertPriceBookItem, Uuid } from "@sentinel/shared";
import type { Tx } from "../db/pool.js";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf } from "../lib/auth.js";
import { AppError, notFound, parse } from "../lib/errors.js";
import { importTemplateItems, loadPriceBookTemplate, PRICE_ITEM_COLS } from "../quotes/pricebook.js";
import { reqMeta } from "./auth.js";
import type { FieldRouteDeps } from "./deps.js";

export interface ChannelDeps extends FieldRouteDeps {
  /** apps/api/data/price-book-template.json unless a test overrides it. */
  templatePath: string;
}

export const QuoteSettings = z
  .object({
    defaultLaborRate: z.number().min(0).max(10_000_000),
    minMarginPct: z.number().min(0).max(95),
    defaultTerms: z.string().max(4000),
    validDays: z.number().int().min(1).max(365),
  })
  .strict();
export type QuoteSettings = z.infer<typeof QuoteSettings>;
export const DEFAULT_QUOTE_SETTINGS: QuoteSettings = { defaultLaborRate: 95, minMarginPct: 25, defaultTerms: "", validDays: 30 };

export async function quoteSettings(tx: Tx): Promise<QuoteSettings> {
  const { rows } = await tx.query<QuoteSettings>(
    `SELECT default_labor_rate AS "defaultLaborRate", min_margin_pct AS "minMarginPct", default_terms AS "defaultTerms", valid_days AS "validDays" FROM quote_settings`,
  );
  return rows[0] ?? { ...DEFAULT_QUOTE_SETTINGS };
}

const isUnique = (err: unknown, constraint: string) =>
  (err as { code?: string; constraint?: string }).code === "23505" && (err as { constraint?: string }).constraint === constraint;

export async function priceBookRoutes(app: FastifyInstance, deps: ChannelDeps) {
  const { cfg, db, limiters } = deps;
  const role = guard(cfg, db, limiters);

  const ListQuery = z.object({
    q: z.string().trim().max(100).optional(),
    category: PriceCategory.optional(),
    active: z.enum(["true", "false"]).optional(),
  });
  app.get("/price-book", role("assessor"), async (req) => {
    const q = parse(ListQuery, req.query);
    return db.withTenant(authOf(req).tenantId, async (tx) => {
      const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const { rows } = await tx.query(
        `SELECT ${PRICE_ITEM_COLS} FROM price_book_item
          WHERE ($1::text IS NULL OR sku ILIKE $1 OR name ILIKE $1 OR description ILIKE $1)
            AND ($2::text IS NULL OR category = $2) AND ($3::boolean IS NULL OR active = $3)
          ORDER BY category, sku`,
        [like, q.category ?? null, q.active === undefined ? null : q.active === "true"],
      );
      return rows;
    });
  });

  app.put("/price-book/:id", role("admin"), async (req) => {
    const a = authOf(req);
    const { id } = parse(z.object({ id: Uuid }), req.params);
    const body = parse(UpsertPriceBookItem, req.body);
    if (body.id !== undefined && body.id !== id) {
      throw new AppError(400, "validation_error", "Request validation failed", [{ path: "id", message: "must match the URL" }]);
    }
    try {
      return await db.withTenant(a.tenantId, async (tx) => {
        const prev = (await tx.query<{ material_cost: number; labor_hours: number; default_margin_pct: number; from_template: boolean }>(
          "SELECT material_cost, labor_hours, default_margin_pct, from_template FROM price_book_item WHERE id = $1 FOR UPDATE", [id],
        )).rows[0];
        const vals = [id, body.sku, body.name, body.description, body.category, body.unit, body.materialCost, body.laborHours, body.defaultMarginPct,
          body.controlIds, body.assetTypes, body.tier, body.active, a.userId];
        if (prev) {
          // The "placeholder price" flag stays until an admin changes a price field.
          const repriced = prev.material_cost !== body.materialCost || prev.labor_hours !== body.laborHours || prev.default_margin_pct !== body.defaultMarginPct;
          await tx.query(
            `UPDATE price_book_item SET sku = $2, name = $3, description = $4, category = $5, unit = $6, material_cost = $7, labor_hours = $8,
                    default_margin_pct = $9, control_ids = $10, asset_types = $11, tier = $12, active = $13, updated_by = $14, updated_at = now(),
                    from_template = from_template AND NOT $15
              WHERE id = $1`,
            [...vals, repriced],
          );
        } else {
          await tx.query(
            `INSERT INTO price_book_item (id, tenant_id, sku, name, description, category, unit, material_cost, labor_hours, default_margin_pct,
                                          control_ids, asset_types, tier, active, created_by, updated_by)
             VALUES ($1, $15, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)`,
            [...vals, a.tenantId],
          );
        }
        await audit(tx, {
          tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: prev ? "price_book.update" : "price_book.create",
          entityType: "price_book_item", entityId: id, ...reqMeta(req), details: { sku: body.sku, active: body.active },
        });
        return (await tx.query(`SELECT ${PRICE_ITEM_COLS} FROM price_book_item WHERE id = $1`, [id])).rows[0];
      });
    } catch (err) {
      if (isUnique(err, "price_book_item_sku_key")) throw new AppError(409, "sku_exists", "Another price book item already uses this SKU");
      if (isUnique(err, "price_book_item_pkey")) throw new AppError(409, "id_conflict", "An item with this id already exists");
      throw err;
    }
  });

  app.delete("/price-book/:id", role("admin"), async (req, reply) => {
    const a = authOf(req);
    const { id } = parse(z.object({ id: Uuid }), req.params);
    await db.withTenant(a.tenantId, async (tx) => {
      const item = await tx.query("SELECT 1 FROM price_book_item WHERE id = $1 FOR UPDATE", [id]);
      if (!item.rowCount) throw notFound("Price book item");
      const used = await tx.query("SELECT 1 FROM quote_line WHERE price_book_item_id = $1 LIMIT 1", [id]);
      // Items used by any quote are kept (inactive) so quote lines keep their reference.
      if (used.rowCount) await tx.query("UPDATE price_book_item SET active = false, updated_by = $2, updated_at = now() WHERE id = $1", [id, a.userId]);
      else await tx.query("DELETE FROM price_book_item WHERE id = $1", [id]);
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: used.rowCount ? "price_book.deactivate" : "price_book.delete",
        entityType: "price_book_item", entityId: id, ...reqMeta(req),
      });
    });
    return reply.code(204).send();
  });

  app.post("/price-book/import-template", role("admin"), async (req) => {
    const a = authOf(req);
    parse(z.object({}).strict(), req.body ?? {});
    const tpl = loadPriceBookTemplate(deps.templatePath);
    if (!tpl) throw new AppError(503, "template_unavailable", "The price book template is not installed on this server");
    if (tpl.invalid) req.log.warn({ invalid: tpl.invalid }, "price book template has items that fail validation; they were skipped");
    return db.withTenant(a.tenantId, async (tx) => {
      const r = await importTemplateItems((sql, p) => tx.query(sql, p), a.tenantId, a.userId, tpl.items);
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "price_book.import_template", entityType: "tenant", entityId: a.tenantId,
        ...reqMeta(req), details: { ...r, invalid: tpl.invalid },
      });
      return { added: r.added, skipped: r.skipped + tpl.invalid };
    });
  });

  app.get("/tenant/quote-settings", role("admin"), async (req) => db.withTenant(authOf(req).tenantId, (tx) => quoteSettings(tx)));

  app.put("/tenant/quote-settings", role("admin"), async (req) => {
    const a = authOf(req);
    const body = parse(QuoteSettings, req.body);
    return db.withTenant(a.tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO quote_settings (tenant_id, default_labor_rate, min_margin_pct, default_terms, valid_days, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id) DO UPDATE SET default_labor_rate = EXCLUDED.default_labor_rate, min_margin_pct = EXCLUDED.min_margin_pct,
           default_terms = EXCLUDED.default_terms, valid_days = EXCLUDED.valid_days, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [a.tenantId, body.defaultLaborRate, body.minMarginPct, body.defaultTerms, body.validDays, a.userId],
      );
      await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "quote_settings.update", entityType: "tenant", entityId: a.tenantId, ...reqMeta(req), details: body });
      return quoteSettings(tx);
    });
  });
}
