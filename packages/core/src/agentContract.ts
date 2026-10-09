import { z } from "zod";
import { formatZodError } from "./validation.js";

/** Roles de agente definidos en la sección 5 del diseño. */
export const AGENT_ROLES = [
  "scout",
  "architect",
  "software-engineer",
  "debugger",
  "database-reviewer",
  "security-reviewer",
  "code-reviewer",
] as const;

export const AgentRoleSchema = z.enum(AGENT_ROLES);

/** Entrada común a todo agente (`AgentInput`, sección 5). */
export const AgentInputSchema = z.strictObject({
  task_id: z.string().min(1),
  agent_role: AgentRoleSchema,
  spec_path: z.string().min(1),
  allowed_files: z.array(z.string().min(1)),
  budget_limit_usd: z.number().positive(),
  max_steps: z.number().int().positive(),
});

/** Los cuatro estados de salida de la sección 5. */
export const AGENT_STATUSES = [
  "SUCCESS",
  "FAILED",
  "NEEDS_CONTINUATION",
  "NEEDS_INPUT",
] as const;

export const AgentStatusSchema = z.enum(AGENT_STATUSES);

export const ReportedCheckSchema = z.strictObject({
  command: z.string().min(1),
  exit_code: z.number().int().min(0),
});

/** Salida obligatoria (`AgentOutput`, sección 5). */
export const AgentOutputSchema = z.strictObject({
  status: AgentStatusSchema,
  summary: z.string().min(1),
  files_modified: z.array(z.string().min(1)),
  reported_checks: z.array(ReportedCheckSchema),
  continuation_notes: z.string(),
  blocking_question: z.string(),
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type AgentInput = z.infer<typeof AgentInputSchema>;
export type AgentStatus = z.infer<typeof AgentStatusSchema>;
export type ReportedCheck = z.infer<typeof ReportedCheckSchema>;
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

/** Valida un valor desconocido como `AgentInput`; falla con la ruta del campo. */
export function parseAgentInput(data: unknown): AgentInput {
  const result = AgentInputSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`AgentInput inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/** Valida un valor desconocido como `AgentOutput`; falla con la ruta del campo. */
export function parseAgentOutput(data: unknown): AgentOutput {
  const result = AgentOutputSchema.safeParse(data);
  if (!result.success) {
    throw new Error(`AgentOutput inválido: ${formatZodError(result.error)}`);
  }
  return result.data;
}

/**
 * JSON Schema (draft 2020-12) del esquema de `AgentOutput`, generado desde
 * la misma definición Zod para que sea la fuente única de verdad.
 * Pensado para pasarlo a herramientas que admiten esquemas de salida.
 */
export const AgentOutputJsonSchema = z.toJSONSchema(AgentOutputSchema);
