import type { AgentRole } from "./agentContract.js";
import type { BatutaConfig } from "./config.js";
import type { TaskComplexity } from "./plan.js";

/** Resultado puro de la selección de modelo para una llamada. */
export interface DecisionModelo {
  rol: AgentRole;
  alias: string;
  modelo: string;
}

const NIVEL_POR_COMPLEJIDAD: Record<TaskComplexity, number> = {
  baja: 0,
  media: 1,
  alta: 2,
};

const COMPLEJIDAD_POR_NIVEL: TaskComplexity[] = ["baja", "media", "alta"];

/**
 * Función pura: dado el rol, la complejidad de la subtarea, el número de
 * intento (1-based) y la configuración, devuelve el alias y el nombre
 * completo del modelo (`modelos`, `alias_modelos`, sección 3.4).
 *
 * - `software-engineer`: el intento 1 usa el alias de la complejidad; a
 *   partir del intento 2 sube un nivel (baja→media→fuerte) si
 *   `escalar_modelo_en_reintento` es true.
 * - `debugger` y resto de roles: alias fijo de la configuración.
 * - Revisores (`database-reviewer`, `security-reviewer`, `code-reviewer`)
 *   comparten el alias `revisores`.
 */
export function seleccionarModelo(params: {
  rol: AgentRole;
  complejidad?: TaskComplexity;
  intento: number;
  config: BatutaConfig;
}): DecisionModelo {
  const { rol, intento, config } = params;
  let alias: string;

  if (rol === "software-engineer") {
    const complejidad: TaskComplexity = params.complejidad ?? "media";
    let nivel = NIVEL_POR_COMPLEJIDAD[complejidad];
    if (intento >= 2 && config.escalar_modelo_en_reintento) {
      nivel = Math.min(nivel + 1, 2);
    }
    const clave = COMPLEJIDAD_POR_NIVEL[nivel]!;
    alias = config.modelos["software-engineer"][clave];
  } else if (rol === "debugger") {
    alias = config.modelos.debugger;
  } else if (
    rol === "database-reviewer" ||
    rol === "security-reviewer" ||
    rol === "code-reviewer"
  ) {
    alias = config.modelos.revisores;
  } else if (rol === "scout") {
    alias = config.modelos.scout;
  } else {
    alias = config.modelos.architect;
  }

  const entrada = config.alias_modelos[alias];
  if (!entrada) {
    throw new Error(`Alias de modelo no definido: "${alias}"`);
  }
  return { rol, alias, modelo: entrada.modelo };
}
