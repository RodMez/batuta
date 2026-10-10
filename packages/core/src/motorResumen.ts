import type { BatutaConfig } from "./config.js";
import { leerProgreso, rutaResumen } from "./motorRutas.js";
import type { DependenciasMotor, ProgresoMotor, ResultadoMotor } from "./motorTipos.js";

export function textoResumen(
  progreso: ProgresoMotor,
  ahoraIso: string,
): string {
  const minutos =
    (Date.parse(ahoraIso) - Date.parse(progreso.inicioIso)) / 60000;
  const lineas: string[] = [
    `# Resumen de la ejecución ${progreso.runId}`,
    ``,
    `## Subtareas`,
    ...progreso.subtareas.map(
      (s) =>
        `- ${s.id}: ${s.completada ? "completada" : "pendiente"} · intentos fallidos ${s.intentos} · commit ${s.commit ?? "-"}`,
    ),
    ``,
    `## Intentos por subtarea`,
    ...progreso.subtareas.map((s) => `- ${s.id}: ${s.intentos} fallos, modelos: ${s.modelosUsados.join(", ") || "-"}`),
    ``,
    `## Gates que fallaron`,
    progreso.gatesFallidosGlobal.length > 0
      ? progreso.gatesFallidosGlobal.map((g) => `- ${g}`).join("\n")
      : "- ninguno",
    ``,
    `## Uso y costo por rol`,
    ...Object.entries(progreso.usoPorRol).map(
      ([rol, u]) => `- ${rol}: ${u.llamadas} llamadas, ${u.tokens} tokens, $${u.usd.toFixed(6)}`,
    ),
    ``,
    `Total tokens: ${progreso.tokensAcumulados}`,
    `Total USD: $${progreso.usdAcumulado.toFixed(6)}${progreso.usdDesconocido ? " (parcialmente desconocido: faltan precios)" : ""}`,
    `Duración: ${minutos.toFixed(1)} minutos`,
    ``,
  ];
  return lineas.join("\n");
}

export async function generarCierre(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  _config: BatutaConfig,
): Promise<ResultadoMotor | null> {
  const estado = await deps.store.estado(runId);
  const progreso = await leerProgreso(deps.fs, dirBatuta, runId);

  // La decisión de pausar en H3 vive en `siguientePaso`; aquí solo se
  // avanza REVIEW→FINALIZE→DONE. El resumen se escribe antes de H3 y se
  // reescribe de forma idempotente al completar.
  if (estado.estado === "CHECKPOINT") {
    await deps.store.agregar(runId, {
      tipo: "revision_completada",
      payload: { omitida: true, motivo: "hito 6 sin revisores" },
    });
    await deps.store.agregar(runId, {
      tipo: "pr_creada",
      payload: { omitida: true, motivo: "hito 6 sin push" },
    });
    const resumen = textoResumen(progreso, deps.reloj.ahoraIso());
    await deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
    return null;
  }

  if (estado.estado === "REVIEW") {
    await deps.store.agregar(runId, {
      tipo: "pr_creada",
      payload: { omitida: true, motivo: "hito 6 sin push" },
    });
    return null;
  }

  if (estado.estado === "FINALIZE") {
    const resumen = textoResumen(progreso, deps.reloj.ahoraIso());
    await deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
    await deps.store.agregar(runId, { tipo: "ejecucion_completada" });
    await deps.notificador.notificar({
      tipo: "ejecucion_terminada",
      runId,
      mensaje: `Ejecución ${runId} terminada en DONE`,
    });
    return { resultado: "terminada", runId };
  }

  if (estado.estado === "PLAN") {
    // Sin subtareas pendientes pero sin checkpoint: cerrar directo.
    const resumen = textoResumen(progreso, deps.reloj.ahoraIso());
    await deps.fs.escribirArchivo(rutaResumen(dirBatuta, runId), resumen);
    return null;
  }
  return null;
}
