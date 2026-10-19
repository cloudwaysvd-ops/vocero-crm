import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/lib/db";
import { apiError, parseBody } from "@/lib/api";
import { resolveStage } from "@/server/ai/actions";
import { requireBotKey, resolveInstanceOrg } from "@/server/bot/auth";
import { decideForwardMove } from "@/server/bot/stage";
import { publish } from "@/server/events/bus";
import { findContactByIdentity } from "@/server/inbox/identity";
import { moveLeadToStage } from "@/server/leads/stage-history";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    /** Alternativa a conversationId: la identidad tal como la da /context. */
    identity: z.string().min(1).optional(),
    /** Nombre de la etapa, como se ve en el Pipeline (sin distinguir mayúsculas). */
    stage: z.string().min(1).max(80),
    /** Hoy el único modo. Viaja explícito para poder sumar otros sin romper. */
    mode: z.literal("forward").default("forward"),
  })
  .refine((b) => b.conversationId || b.identity, {
    message: "Falta conversationId o identity",
  });

/**
 * Fork — avanzar la tarjeta del lead a una etapa abierta, solo hacia adelante
 * (reglas en `server/bot/stage`). Idempotente: repetirlo responde `already`.
 *
 * 200 `{ status: "moved" | "already" | "skipped_not_forward", ... }`
 * 404 `stage_not_found` · `not_found` (conversación) · `lead_not_found`
 */
export async function POST(req: Request) {
  const denied = requireBotKey(req);
  if (denied) return denied;

  const organizationId = await resolveInstanceOrg();
  if (!organizationId) {
    return apiError(409, "no_org", "La instancia aún no tiene organización");
  }

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const db = getDb();

  let contactId: string | undefined;
  let conversationId: string | undefined;
  if (body.data.conversationId) {
    const rows = await db
      .select({
        id: schema.conversation.id,
        contactId: schema.conversation.contactId,
      })
      .from(schema.conversation)
      .where(
        and(
          eq(schema.conversation.organizationId, organizationId),
          eq(schema.conversation.id, body.data.conversationId)
        )
      )
      .limit(1);
    contactId = rows[0]?.contactId;
    conversationId = rows[0]?.id;
  } else if (body.data.identity) {
    const contact = await findContactByIdentity(
      organizationId,
      body.data.identity
    );
    contactId = contact?.id;
    if (contactId) {
      const convs = await db
        .select({ id: schema.conversation.id })
        .from(schema.conversation)
        .where(
          and(
            eq(schema.conversation.organizationId, organizationId),
            eq(schema.conversation.contactId, contactId),
            eq(schema.conversation.isTest, false)
          )
        )
        .limit(1);
      conversationId = convs[0]?.id;
    }
  }
  if (!contactId) return apiError(404, "not_found", "Conversación no encontrada");

  const [leadRows, stages] = await Promise.all([
    db
      .select({ lead: schema.lead, stage: schema.pipelineStage })
      .from(schema.lead)
      .leftJoin(
        schema.pipelineStage,
        eq(schema.lead.stageId, schema.pipelineStage.id)
      )
      .where(
        and(
          eq(schema.lead.organizationId, organizationId),
          eq(schema.lead.contactId, contactId)
        )
      )
      .limit(1),
    db
      .select()
      .from(schema.pipelineStage)
      .where(eq(schema.pipelineStage.organizationId, organizationId)),
  ]);

  const resolved = resolveStage(body.data.stage, stages);
  const target = resolved ? stages.find((s) => s.id === resolved.id) : undefined;
  if (!target) {
    return apiError(
      404,
      "stage_not_found",
      `No existe la etapa «${body.data.stage}» en el Pipeline`
    );
  }

  const row = leadRows[0];
  if (!row) return apiError(404, "lead_not_found", "El contacto no tiene trato");

  const current = row.stage ?? null;
  const decision = decideForwardMove(current, target);
  const from = current ? { id: current.id, name: current.name } : null;
  const to = { id: target.id, name: target.name };

  if (decision.action === "already") {
    return Response.json({ status: "already", from, stage: to });
  }
  if (decision.action === "skipped_not_forward") {
    return Response.json({
      status: "skipped_not_forward",
      why: decision.why,
      from,
      stage: to,
    });
  }

  const res = await moveLeadToStage({
    organizationId,
    leadId: row.lead.id,
    toStageId: target.id,
    source: "bot",
    extra: { lastActivityAt: new Date() },
  });
  if (!res.ok) {
    // Solo pasaría si el lead o la etapa desaparecieron entre la lectura y el
    // movimiento: se reporta con el mismo código que daría la lectura.
    return apiError(404, res.reason, "No se pudo mover el trato");
  }

  if (conversationId) {
    publish(organizationId, {
      type: "conversation.updated",
      data: { conversation: { id: conversationId } },
    });
  }
  return Response.json({ status: "moved", from, stage: to });
}
