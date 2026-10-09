import { z } from "zod";
import { RunStateSchema } from "./state.js";
import { formatZodError } from "./validation.js";

/**
 * Checkpoint (`checkpoints/`, sección 3.1): estado serializado al completar
 * una subtarea, índice del último evento incluido y referencia opaca al
 * commit de Git (texto libre; Git llega en el hito 4, hasta entonces null).
 */
export const CheckpointSchema = z.strictObject({
  version_esquema: z.number().int().min(1).default(1),
  run_id: z.string().min(1),
  ultimo_evento: z.number().int().min(0),
  estado: RunStateSchema,
  commit: z.string().min(1).nullable(),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

/** Valida un valor desconocido como checkpoint; falla con la ruta. */
export function parseCheckpoint(data: unknown): Checkpoint {
  const resultado = CheckpointSchema.safeParse(data);
  if (!resultado.success) {
    throw new Error(`Checkpoint inválido: ${formatZodError(resultado.error)}`);
  }
  return resultado.data;
}

/**
 * Nombre de archivo ordenable por índice (`checkpoint-000015.json`).
 * El relleno mínimo de 6 dígitos ordena bien en `listarDir` hasta 999999.
 */
export function nombreCheckpoint(ultimoEvento: number): string {
  return `checkpoint-${String(ultimoEvento).padStart(6, "0")}.json`;
}

/** Extrae el índice de un nombre de checkpoint o null si no lo es. */
export function indiceDeCheckpoint(nombre: string): number | null {
  const coincidencia = /^checkpoint-(\d{6,})\.json$/.exec(nombre);
  const digitos = coincidencia?.[1];
  if (digitos === undefined) {
    return null;
  }
  return Number.parseInt(digitos, 10);
}
