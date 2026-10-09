import { z } from "zod";
import { formatZodError } from "./validation.js";

/** Complejidad por subtarea (sección 3.4): la fija el `architect` en el plan. */
export const TASK_COMPLEXITIES = ["baja", "media", "alta"] as const;

export const TaskComplexitySchema = z.enum(TASK_COMPLEXITIES);

/**
 * Subtarea del plan (sección 3.3): archivos a tocar, criterios asociados
 * y complejidad para elegir el modelo del implementador.
 */
export const SubtaskSchema = z.strictObject({
  id: z.string().min(1),
  titulo: z.string().min(1),
  archivos: z.array(z.string().min(1)),
  criterios: z.array(z.string().min(1)),
  complejidad: TaskComplexitySchema,
  descripcion: z.string().optional(),
});

/**
 * Plan (`plan.json`, sección 3.3). Los ids de subtarea deben ser únicos
 * para que el motor pueda referenciarlas sin ambigüedad.
 */
export const PlanSchema = z
  .strictObject({
    version_esquema: z.number().int().min(1).default(1),
    spec_id: z.string().min(1).optional(),
    subtareas: z.array(SubtaskSchema).min(1),
  })
  .superRefine((plan, ctx) => {
    const seen = new Map<string, number>();
    plan.subtareas.forEach((subtarea, index) => {
      const first = seen.get(subtarea.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["subtareas", index, "id"],
          message: `Id de subtarea repetido: "${subtarea.id}" (ya usado en subtareas[${first}])`,
        });
      } else {
        seen.set(subtarea.id, index);
      }
    });
  });

export type TaskComplexity = z.infer<typeof TaskComplexitySchema>;
export type Subtask = z.infer<typeof SubtaskSchema>;
export type Plan = z.infer<typeof PlanSchema>;

/** Valida un valor desconocido como plan; falla con la ruta del campo. */
export function parsePlan(data: unknown): Plan {
  const result = PlanSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`Plan inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}
