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

export interface RutasContextoAgy {
  specRel: string;
  planRel: string;
  feedbackRel?: string;
  reglasRepoRel?: string;
}

/**
 * Construye un prompt corto (<500 caracteres en uso típico, siempre <4000)
 * para agy conforme a la Decisión 6 de ADR 021.
 * En lugar de incrustar specs gigantes, planes completos y esquemas en el flag -p,
 * referencia los archivos depositados en .batuta/contexto/ dentro del worktree.
 */
export function construirPromptCortoAgy(
  rol: AgentRole,
  subtarea: Subtask,
  rutas: RutasContextoAgy,
): string {
  const tituloUnaLinea = subtarea.titulo.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  const maxArchivos = 20;
  const archivosVisibles = subtarea.archivos.slice(0, maxArchivos);
  const restantes = subtarea.archivos.length - archivosVisibles.length;
  const archivos =
    archivosVisibles.join(", ") +
    (restantes > 0 ? ` …(+${restantes} más)` : "");
  const lineas = [
    `Rol: ${rol}. Tarea: ${subtarea.id} - ${tituloUnaLinea}.`,
    `Permitidos: ${archivos}.`,
    `Contexto:`,
    `- Spec: "${rutas.specRel}"`,
    `- Plan: "${rutas.planRel}" (ver subtarea "${subtarea.id}")`,
    rutas.feedbackRel ? `- Feedback: "${rutas.feedbackRel}"` : "",
    rutas.reglasRepoRel ? `- Reglas: "${rutas.reglasRepoRel}"` : "",
    `Restriccion de sandbox: No ejecutes comandos de terminal ni pruebas por tu cuenta (la terminal esta deshabilitada en sandbox; el motor ejecutara los gates).`,
    `Instrucción: Solo toca permitidos y responde según esquema.`,
  ].filter(Boolean);

  return lineas.join("\n");
}
