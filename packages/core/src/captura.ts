import type { AgentInput, AgentRole } from "./agentContract.js";
import type { AgentCallContext, PermisosRol } from "./agentRunner.js";

/**
 * Modelo usado por el script de captura cuando `BATUTA_MODELO` no está
 * definido. Es un nombre corto pensado para resolverse en el proxy local;
 * con un proxy el nombre debe ser el que este entienda.
 */
export const MODELO_CAPTURA_POR_DEFECTO = "claude-haiku-5-5";

/** Variables de modelo que el script reenvía al subproceso (API + proxy). */
export const VARIABLES_MODELO_CAPTURA: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
];

/** Lee el modelo de captura desde el entorno con valor por defecto. */
export function modeloCapturaDesdeEntorno(
  entorno: NodeJS.ProcessEnv = process.env,
): string {
  const valor = entorno["BATUTA_MODELO"];
  if (valor !== undefined && valor.trim().length > 0) {
    return valor.trim();
  }
  return MODELO_CAPTURA_POR_DEFECTO;
}

/** Entrada fija del script de captura (rol de solo lectura `architect`). */
export function crearInputCaptura(): AgentInput {
  return {
    task_id: "CAPTURE-01",
    agent_role: "architect",
    spec_path: "README.md",
    allowed_files: ["README.md"],
    budget_limit_usd: 0.05,
    max_steps: 2,
  };
}

/**
 * Contexto de captura con la forma `AgentCallContext` vigente.
 * El rol `architect` es de solo lectura (`soloLectura: true`), sin comandos
 * permitidos: tratarlo como escritura impediría el aislamiento con `--bare`.
 */
export function crearContextoCaptura(
  directorioTrabajo: string,
  modelo: string,
  prompt = "Analiza el archivo README.md y responde con el esquema JSON requerido.",
  runId = "capture",
): AgentCallContext {
  const permisos: PermisosRol = { soloLectura: true };
  const rol: AgentRole = "architect";
  return {
    directorioTrabajo,
    rol,
    modelo,
    limites: { budgetLimitUsd: 0.05, maxSteps: 2, timeoutMs: 30_000 },
    permisos,
    entorno: {},
    prompt,
    runId,
  };
}
