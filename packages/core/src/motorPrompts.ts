import type { AgentRole } from "./agentContract.js";
import { AgentOutputJsonSchema } from "./agentContract.js";
import { cargarPlantillaPrompt } from "./agentRunner.js";
import type { Subtask } from "./plan.js";

export function describirSubtarea(s: Subtask): string {
  const base = `${s.id}: ${s.titulo} [${s.complejidad}]`;
  return s.descripcion ? `${base}\n${s.descripcion}` : base;
}

export async function construirPrompt(
  rol: AgentRole,
  subtarea: Subtask,
  spec: string,
  reglasRepo: string,
  informeFallo: string,
  respuesta?: string,
  resumenContinuacion?: { resumen: string; notas: string },
): Promise<string> {
  const variables: Record<string, string> = {
    subtarea: describirSubtarea(subtarea),
    spec,
    reglas_repo: reglasRepo,
    archivos_permitidos: subtarea.archivos.join("\n"),
    informe_fallo:
      informeFallo.length > 0 ? informeFallo : "Sin fallos previos.",
    esquema_salida: JSON.stringify(AgentOutputJsonSchema),
  };
  let prompt = await cargarPlantillaPrompt(rol, variables);
  if (respuesta !== undefined && respuesta.length > 0) {
    prompt += `\n\n## Respuesta a tu pregunta bloqueante\n${respuesta}`;
  }
  if (resumenContinuacion) {
    prompt += `\n\n## Continuación de la sesión anterior\nResumen: ${resumenContinuacion.resumen}\nNotas: ${resumenContinuacion.notas}`;
  } else if (informeFallo.length > 0 && rol === "software-engineer") {
    prompt += `\n\n## Informe de fallo anterior\n${informeFallo}`;
  }
  return prompt;
}
