import { db } from "../db/client.js";
import { auditEvents } from "../db/schema.js";

interface LogAuditEventInput {
  entityType: "website" | "crawl" | "optimization" | "user";
  entityId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort audit logging: failures here must never break the primary
 * request flow, only be logged to the console for operator visibility.
 */
export async function logAuditEvent(input: LogAuditEventInput): Promise<void> {
  try {
    await db.insert(auditEvents).values({
      entityType: input.entityType,
      entityId: input.entityId,
      eventType: input.eventType,
      metadata: input.metadata ?? null,
    });
  } catch (err) {
    console.error("[audit] failed to record event", input.eventType, err);
  }
}
