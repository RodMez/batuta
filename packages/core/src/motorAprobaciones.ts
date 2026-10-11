import type { BatutaConfig } from "./config.js";
import { parsePlan } from "./plan.js";
import {
  guardarProgreso,
  leerConfigRun,
  leerProgreso,
  rutaPlan,
  rutaSolicitud,
  rutaSpec,
} from "./motorRutas.js";
import { hashContenido } from "./motorTipos.js";
import type {
  DependenciasMotor,
  ProgresoMotor,
  ResultadoMotor,
} from "./motorTipos.js";
import type { Puerta } from "./state.js";

export async function limpiarWorktree(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
): Promise<void> {
  try {
    const progreso = await leerProgreso(deps.fs, dirBatuta, runId);
    if (progreso.worktree) {
      await deps.git.eliminarWorktree(progreso.worktree.ruta);
    }
  } catch {
    // Si el progreso no existe, no hay worktree que limpiar.
  }
}

export async function revisarHashes(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  progreso: ProgresoMotor,
): Promise<ProgresoMotor | null> {
  let cambiado = false;
  if (progreso.aprobaciones["H1"].aprobada) {
    const actual = await deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
    if (hashContenido(actual) !== progreso.aprobaciones["H1"].hash) {
      progreso.aprobaciones["H1"] = { aprobada: false };
      cambiado = true;
    }
  }
  if (progreso.aprobaciones["H2"].aprobada) {
    const actual = await deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    if (hashContenido(actual) !== progreso.aprobaciones["H2"].hash) {
      progreso.aprobaciones["H2"] = { aprobada: false };
      cambiado = true;
    }
  }
  if (cambiado) {
    await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
    return progreso;
  }
  return null;
}

export async function solicitarAprobacion(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  config: BatutaConfig,
  puerta: Puerta,
): Promise<void> {
  await deps.store.agregar(runId, {
    tipo: "aprobacion_solicitada",
    payload: { puerta },
  });
  // Guardar el hash pendiente para detectar cambios antes de aprobar.
  const progreso = await leerProgreso(deps.fs, dirBatuta, runId);
  if (puerta === "H1") {
    const spec = await deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
    progreso.aprobaciones["H1"] = { aprobada: false, pendiente: hashContenido(spec) };
  } else if (puerta === "H2") {
    const planTexto = await deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    progreso.aprobaciones["H2"] = { aprobada: false, pendiente: hashContenido(planTexto) };
  }
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
  const contenido = await textoSolicitud(deps, dirBatuta, runId, config, puerta);
  await deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
  await deps.notificador.notificar({
    tipo: "aprobacion_requerida",
    runId,
    mensaje: `Se requiere aprobación ${puerta} en ${runId}`,
  });
}

export async function textoSolicitud(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  config: BatutaConfig,
  puerta: Puerta,
): Promise<string> {
  const progreso = await leerProgreso(deps.fs, dirBatuta, runId);
  const spec = await deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
  const planTexto = await deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
  const plan = parsePlan(JSON.parse(planTexto) as unknown);
  switch (puerta) {
    case "H0": {
      return [
        `# Solicitud de aprobación H0 (presupuesto y límites)`,
        ``,
        `Ejecución: ${runId}`,
        ``,
        `## Límites`,
        `- tokens_por_ejecucion: ${config.limites.tokens_por_ejecucion}`,
        `- minutos_por_ejecucion: ${config.limites.minutos_por_ejecucion}`,
        `- usd_por_agente: ${config.limites.usd_por_agente}`,
        `- pasos_por_agente: ${config.limites.pasos_por_agente}`,
        `- intentos_por_subtarea: ${config.limites.intentos_por_subtarea}`,
        `- preguntas_bloqueantes: ${config.limites.preguntas_bloqueantes}`,
        `- continuaciones_por_subtarea: ${config.limites.continuaciones_por_subtarea}`,
        ``,
        `Responde con \`aprobar\` o \`rechazar\`.`,
        ``,
      ].join("\n");
    }
    case "H1": {
      return [
        `# Solicitud de aprobación H1 (especificación)`,
        ``,
        `Ejecución: ${runId}`,
        `Hash spec.md: ${hashContenido(spec)}`,
        ``,
        `Aprueba la especificación en \`spec.md\` o rechaza para abortar.`,
        ``,
      ].join("\n");
    }
    case "H2": {
      const lineas = plan.subtareas.map((s) => `- ${s.id}: ${s.titulo} [${s.complejidad}]`);
      return [
        `# Solicitud de aprobación H2 (plan)`,
        ``,
        `Ejecución: ${runId}`,
        `Hash plan.json: ${hashContenido(planTexto)}`,
        ``,
        `## Subtareas`,
        ...lineas,
        ``,
        `Aprueba el plan o rechaza para abortar.`,
        ``,
      ].join("\n");
    }
    case "H3": {
      const lineas = progreso.subtareas.map(
        (s) => `- ${s.id}: ${s.completada ? "completada" : "pendiente"} (${s.intentos} fallos)`,
      );
      return [
        `# Solicitud de aprobación H3 (fusión final)`,
        ``,
        `Ejecución: ${runId}`,
        ``,
        `## Subtareas`,
        ...lineas,
        ``,
        `Revisa \`summary.md\` en la carpeta de la ejecución. No se hace push.`,
        ``,
      ].join("\n");
    }
  }
}

/**
 * Registra una aprobación. Devuelve el resultado si el documento cambió tras
 * solicitar (hay que aprobar de nuevo) o null para que el llamante continúe.
 */
export async function aprobarPuerta(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  puerta: Puerta,
): Promise<ResultadoMotor | null> {
  const estado = await deps.store.estado(runId);
  if (
    estado.estado !== "AWAITING_APPROVAL" ||
    estado.puerta_pendiente !== puerta
  ) {
    throw new Error(`No hay puerta ${puerta} pendiente en ${runId}`);
  }
  const progreso = await leerProgreso(deps.fs, dirBatuta, runId);
  const payload: Record<string, unknown> = { puerta };
  if (puerta === "H1") {
    const spec = await deps.fs.leerArchivo(rutaSpec(dirBatuta, runId));
    const hash = hashContenido(spec);
    const pendiente = progreso.aprobaciones["H1"].pendiente;
    if (pendiente !== undefined && pendiente !== hash) {
      // El documento cambió tras solicitar: hay que aprobar de nuevo.
      progreso.aprobaciones["H1"] = { aprobada: false, pendiente: hash };
      await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
      const config = await leerConfigRun(deps.fs, dirBatuta, runId);
      const contenido = await textoSolicitud(deps, dirBatuta, runId, config, puerta);
      await deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
      return { resultado: "pausa-aprobacion", runId, puerta };
    }
    payload["hash_spec"] = hash;
    progreso.aprobaciones["H1"] = { aprobada: true, hash };
  } else if (puerta === "H2") {
    const planTexto = await deps.fs.leerArchivo(rutaPlan(dirBatuta, runId));
    const hash = hashContenido(planTexto);
    const pendiente = progreso.aprobaciones["H2"].pendiente;
    if (pendiente !== undefined && pendiente !== hash) {
      progreso.aprobaciones["H2"] = { aprobada: false, pendiente: hash };
      await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
      const config = await leerConfigRun(deps.fs, dirBatuta, runId);
      const contenido = await textoSolicitud(deps, dirBatuta, runId, config, puerta);
      await deps.fs.escribirArchivo(rutaSolicitud(dirBatuta, runId, puerta), contenido);
      return { resultado: "pausa-aprobacion", runId, puerta };
    }
    payload["hash_plan"] = hash;
    progreso.aprobaciones["H2"] = { aprobada: true, hash };
  } else {
    progreso.aprobaciones[puerta] = { aprobada: true };
  }
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
  await deps.store.agregar(runId, {
    tipo: "aprobacion_otorgada",
    payload,
  });
  return null;
}

/** Un rechazo termina la ejecución en ABORTED y limpia el worktree. */
export async function rechazarPuerta(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  puerta: Puerta,
  motivo: string,
): Promise<ResultadoMotor> {
  const estado = await deps.store.estado(runId);
  if (
    estado.estado !== "AWAITING_APPROVAL" ||
    estado.puerta_pendiente !== puerta
  ) {
    throw new Error(`No hay puerta ${puerta} pendiente en ${runId}`);
  }
  await deps.store.agregar(runId, {
    tipo: "ejecucion_abortada",
    payload: { puerta, motivo },
  });
  await limpiarWorktree(deps, dirBatuta, runId);
  await deps.notificador.notificar({
    tipo: "fallo",
    runId,
    mensaje: `Ejecución ${runId} abortada en ${puerta}: ${motivo}`,
  });
  return { resultado: "abortada", runId };
}
