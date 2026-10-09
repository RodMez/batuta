import { z } from "zod";
import { formatZodError } from "./validation.js";

/**
 * Estados del ciclo de vida (sección 4): flujo INTAKE→SPEC→PLAN→
 * IMPLEMENT→VERIFY→CHECKPOINT→REVIEW→FINALIZE→DONE, con RETRY/DEBUG
 * intermedios, terminales DONE/FAILED/ABORTED y WAITING_INPUT para
 * el bloqueo por duda crítica (`NEEDS_INPUT`).
 */
export const RUN_STATUSES = [
  "INTAKE",
  "SPEC",
  "PLAN",
  "IMPLEMENT",
  "VERIFY",
  "RETRY",
  "DEBUG",
  "CHECKPOINT",
  "REVIEW",
  "FINALIZE",
  "DONE",
  "FAILED",
  "ABORTED",
  "WAITING_INPUT",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);

/**
 * Estado de la ejecución (`state.json`, secciones 3.1 y 4): vista rápida
 * derivable de `events.jsonl` con el id de la ejecución, el estado general,
 * el presupuesto acumulado y el modelo activo, más la versión de esquema.
 */
export const RunStateSchema = z.strictObject({
  version_esquema: z.number().int().min(1).default(1),
  run_id: z.string().min(1),
  estado: RunStatusSchema,
  presupuesto_acumulado_usd: z.number().min(0).default(0),
  modelo_activo: z.string().min(1).nullable().default(null),
  actualizada_en: z.iso.datetime().optional(),
});

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type RunState = z.infer<typeof RunStateSchema>;

/** Valida un valor desconocido como estado; falla con la ruta del campo. */
export function parseRunState(data: unknown): RunState {
  const result = RunStateSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Estado inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}
