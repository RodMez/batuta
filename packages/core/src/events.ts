import { z } from "zod";
import { AgentRoleSchema } from "./agentContract.js";
import { formatZodError } from "./validation.js";

/**
 * Tipos de evento del registro (sección 3.1). Cubren el ciclo de vida
 * (sección 4: INTAKE→SPEC→PLAN→IMPLEMENT→VERIFY→CHECKPOINT→REVIEW→
 * FINALIZE→DONE, más RETRY/DEBUG, FAILED/ABORTED y WAITING_INPUT),
 * los gates, los reintentos, las aprobaciones humanas (H0–H3),
 * los límites y la reanudación, más la condensación de contexto (`resumen`)
 * y avisos no bloqueantes (`advertencia`, p. ej. costos desconocidos).
 */
export const EVENT_TYPES = [
  "ejecucion_iniciada",
  "spec_creada",
  "plan_creado",
  "subtarea_iniciada",
  "agente_completado",
  "gate_ejecutado",
  "reintento_programado",
  "depuracion_iniciada",
  "checkpoint_creado",
  "revision_completada",
  "pr_creada",
  "aprobacion_solicitada",
  "aprobacion_otorgada",
  "limite_alcanzado",
  "entrada_requerida",
  "entrada_recibida",
  "ejecucion_reanudada",
  "contexto_resumido",
  "advertencia",
  "ejecucion_completada",
  "ejecucion_fallida",
  "ejecucion_abortada",
] as const;

export const EventTypeSchema = z.enum(EVENT_TYPES);

/**
 * Estructura común del evento (sección 3.1): `id`, `run_id`, `ts`, `tipo`,
 * `paso`, `agente`, `payload` y `parent_id`, más `version_esquema` para
 * evolucionar el formato sin romper ejecuciones anteriores.
 * `paso`, `agente` y `parent_id` son opcionales porque no todo evento
 * pertenece a una subtarea, lo emite un agente o deriva de otro evento.
 */
export const EventSchema = z.strictObject({
  version_esquema: z.number().int().min(1).default(1),
  id: z.string().min(1),
  run_id: z.string().min(1),
  ts: z.iso.datetime(),
  tipo: EventTypeSchema,
  paso: z.string().min(1).optional(),
  agente: AgentRoleSchema.optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  parent_id: z.string().min(1).optional(),
});

export type EventType = z.infer<typeof EventTypeSchema>;
export type BatutaEvent = z.infer<typeof EventSchema>;

/** Valida un valor desconocido como evento; falla con la ruta del campo. */
export function parseEvent(data: unknown): BatutaEvent {
  const result = EventSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Evento inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * Serializa un evento a una línea JSON (`events.jsonl`).
 * Valida antes de serializar para no escribir líneas inválidas.
 */
export function serializeEvent(event: BatutaEvent): string {
  return JSON.stringify(parseEvent(event));
}

/**
 * Lee una línea del registro (`events.jsonl`) y la devuelve validada.
 * Un `tipo` desconocido se rechaza; una línea que no es JSON válido
 * falla con un mensaje que lo indica.
 */
export function parseEventLine(line: string): BatutaEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new Error("Línea de evento inválida: no es JSON válido");
  }
  return parseEvent(raw);
}
