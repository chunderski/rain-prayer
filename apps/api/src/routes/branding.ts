/** Phase 4 branding routes: settings with contrast and plan checks, and the logo upload pipeline. */
import type { FastifyInstance } from "fastify";
import { Branding } from "@sentinel/shared";
import { guard } from "../lib/access.js";
import { audit } from "../lib/audit.js";
import { authOf } from "../lib/auth.js";
import { brandingResponse, contrastWithWhite, loadBranding, MAX_LOGO_BYTES, MIN_CONTRAST, processLogo } from "../lib/branding.js";
import { AppError, parse } from "../lib/errors.js";
import { logoKey } from "../storage/index.js";
import { reqMeta } from "./auth.js";
import type { FieldRouteDeps } from "./deps.js";

export async function brandingRoutes(app: FastifyInstance, deps: FieldRouteDeps) {
  const { cfg, db, limiters, storage } = deps;
  const role = guard(cfg, db, limiters);

  app.get("/branding", role("client_viewer"), async (req) => {
    const b = await db.withTenant(authOf(req).tenantId, (tx) => loadBranding(tx));
    return brandingResponse(cfg, storage, b);
  });

  app.put("/branding", role("admin"), async (req) => {
    const a = authOf(req);
    const body = parse(Branding, req.body);
    const ratio = contrastWithWhite(body.primaryColor);
    if (ratio < MIN_CONTRAST) {
      throw new AppError(422, "contrast_too_low", `White text on ${body.primaryColor} has a contrast ratio of ${ratio.toFixed(2)}:1; at least ${MIN_CONTRAST}:1 is required. Pick a darker primary color.`, { ratio: Math.round(ratio * 100) / 100, required: MIN_CONTRAST });
    }
    const b = await db.withTenant(a.tenantId, async (tx) => {
      const cur = await loadBranding(tx);
      if (!body.showPoweredBy && cur.plan !== "partner") {
        throw new AppError(403, "plan_required", "Turning off \"Powered by Sentinel Assess\" requires the partner plan");
      }
      await tx.query(
        `INSERT INTO tenant_branding (tenant_id, display_name, primary_color, accent_color, report_footer, contact_email, contact_phone,
                                      website, show_powered_by, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
         ON CONFLICT (tenant_id) DO UPDATE SET display_name = EXCLUDED.display_name, primary_color = EXCLUDED.primary_color,
           accent_color = EXCLUDED.accent_color, report_footer = EXCLUDED.report_footer, contact_email = EXCLUDED.contact_email,
           contact_phone = EXCLUDED.contact_phone, website = EXCLUDED.website, show_powered_by = EXCLUDED.show_powered_by,
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [a.tenantId, body.displayName, body.primaryColor.toLowerCase(), body.accentColor.toLowerCase(), body.reportFooter, body.contactEmail,
          body.contactPhone, body.website, body.showPoweredBy, a.userId],
      );
      await audit(tx, {
        tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "branding.update", entityType: "tenant", entityId: a.tenantId,
        ...reqMeta(req), details: { displayName: body.displayName, primaryColor: body.primaryColor, accentColor: body.accentColor, showPoweredBy: body.showPoweredBy },
      });
      return loadBranding(tx);
    });
    return brandingResponse(cfg, storage, b);
  });

  // Raw PNG or JPEG body, parsed only inside this encapsulated context; the content decides, not the header.
  await app.register(async (upload) => {
    upload.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: MAX_LOGO_BYTES }, (_req, body, done) => done(null, body));
    upload.put("/branding/logo", { ...role("admin"), bodyLimit: MAX_LOGO_BYTES }, async (req) => {
      const a = authOf(req);
      const declared = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if ((declared !== "image/png" && declared !== "image/jpeg") || !Buffer.isBuffer(req.body)) {
        throw new AppError(415, "unsupported_media", "Content-Type must be image/png or image/jpeg; SVG and other formats are refused");
      }
      const out = await processLogo(req.body);
      const key = logoKey(a.tenantId);
      await storage.put(key, out.png, "image/png");
      const b = await db.withTenant(a.tenantId, async (tx) => {
        const cur = await loadBranding(tx);
        await tx.query(
          `INSERT INTO tenant_branding (tenant_id, display_name, primary_color, accent_color, logo_key, logo_updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5, now(), $6)
           ON CONFLICT (tenant_id) DO UPDATE SET logo_key = EXCLUDED.logo_key, logo_updated_at = now(), updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [a.tenantId, cur.displayName, cur.primaryColor, cur.accentColor, key, a.userId],
        );
        await audit(tx, {
          tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "branding.logo.upload", entityType: "tenant", entityId: a.tenantId,
          ...reqMeta(req), details: { detectedType: out.detectedType, declaredType: declared, width: out.width, height: out.height, bytes: out.png.length },
        });
        return loadBranding(tx);
      });
      return brandingResponse(cfg, storage, b);
    });
  });

  app.delete("/branding/logo", role("admin"), async (req, reply) => {
    const a = authOf(req);
    await db.withTenant(a.tenantId, async (tx) => {
      await tx.query("UPDATE tenant_branding SET logo_key = NULL, logo_updated_at = now(), updated_by = $1, updated_at = now() WHERE tenant_id = $2", [a.userId, a.tenantId]);
      await audit(tx, { tenantId: a.tenantId, actorUserId: a.userId, actorEmail: a.user.email, action: "branding.logo.delete", entityType: "tenant", entityId: a.tenantId, ...reqMeta(req) });
    });
    // The key is fixed per tenant, so the object can be removed after the row no longer points at it.
    await storage.delete(logoKey(a.tenantId)).catch((err) => req.log.warn({ err }, "could not delete logo object"));
    return reply.code(204).send();
  });
}
