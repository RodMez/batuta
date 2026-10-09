import { z } from "zod";
import { formatZodError } from "./validation.js";

/**
 * Estados del ciclo de vida (sección 4): flujo INTAKE→SPEC→PLAN→
 * IMPLEMENT→VERIFY→CHECKPOINT→REVIEW→FINALIZE→DONE, con RETRY/DEBUG
 * intermedios, terminales DONE/FAILED/ABORTED, WAITING_INPUT para
 * el bloqueo por duda crítica (`NEEDS_INPUT`) y AWAITING_APPROVAL
 * para la espera de una puerta humana (H0–H3).
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
  "AWAITING_APPROVAL",
] as const;

export const RunStatusSchema = z.enum(RUN_STATUSES);

/** Puertas humanas del ciclo de vida (H0–H3, sección 4). */
export const PUERTAS = ["H0", "H1", "H2", "H3"] as const;

export const PuertaSchema = z.enum(PUERTAS);

/**
 * Estado de la ejecución (`state.json`, secciones 3.1 y 4): vista rápida
 * derivable de `events.jsonl` con el id de la ejecución, el estado general,
 * el presupuesto acumulado y el modelo activo, más la versión de esquema.
 * En `AWAITING_APPROVAL`, `puerta_pendiente` indica qué puerta se espera;
 * en cualquier otro estado debe ser `null`.
 */
export const RunStateSchema = z
  .strictObject({
    version_esquema: z.number().int().min(1).default(1),
    run_id: z.string().min(1),
    estado: RunStatusSchema,
    puerta_pendiente: PuertaSchema.nullable().default(null),
    presupuesto_acumulado_usd: z.number().min(0).default(0),
    modelo_activo: z.string().min(1).nullable().default(null),
    actualizada_en: z.iso.datetime().optional(),
  })
  .superRefine((estado, ctx) => {
    if (estado.estado === "AWAITING_APPROVAL" && estado.puerta_pendiente === null) {
      ctx.addIssue({
        code: "custom",
        path: ["puerta_pendiente"],
        message: "AWAITING_APPROVAL exige indicar la puerta pendiente (H0, H1, H2 o H3)",
      });
    }
    if (estado.estado !== "AWAITING_APPROVAL" && estado.puerta_pendiente !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["puerta_pendiente"],
        message: `puerta_pendiente debe ser null fuera de AWAITING_APPROVAL (estado ${estado.estado})`,
      });
    }
  });

export type RunStatus = z.infer<typeof RunStatusSchema>;
export type Puerta = z.infer<typeof PuertaSchema>;
export type RunState = z.infer<typeof RunStateSchema>;

/** Valida un valor desconocido como estado; falla con la ruta del campo. */
export function parseRunState(data: unknown): RunState {
  const result = RunStateSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Estado inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}
