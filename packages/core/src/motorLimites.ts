import type { AgentRole } from "./agentContract.js";
import type { BatutaConfig } from "./config.js";
import { guardarProgreso } from "./motorRutas.js";
import type {
  DependenciasMotor,
  ProgresoMotor,
  ProgresoSubtarea,
  ResultadoMotor,
} from "./motorTipos.js";

export function registrarUso(
  progreso: ProgresoMotor,
  sub: ProgresoSubtarea,
  rol: AgentRole,
  tokens: number,
  usd: number | null,
): void {
  sub.tokens += tokens;
  progreso.tokensAcumulados += tokens;
  const entrada = progreso.usoPorRol[rol] ?? { llamadas: 0, tokens: 0, usd: 0 };
  entrada.llamadas += 1;
  entrada.tokens += tokens;
  if (usd !== null) {
    sub.usd += usd;
    progreso.usdAcumulado += usd;
    entrada.usd += usd;
  } else {
    progreso.usdDesconocido = true;
  }
  progreso.usoPorRol[rol] = entrada;
}

export async function emitirAdvertenciaCostos(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  progreso: ProgresoMotor,
): Promise<void> {
  if (progreso.advertenciaEmitida) return;
  progreso.advertenciaEmitida = true;
  await deps.store.agregar(runId, {
    tipo: "advertencia",
    payload: {
      aviso: "costos_desconocidos",
      mensaje:
        "Sin precios para algún alias: solo se controla por tokens, no por dólares.",
    },
  });
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
}

export function comprobarLimites(
  config: BatutaConfig,
  progreso: ProgresoMotor,
  inicioIso: string,
  ahoraIso: string,
): { motivo: string; limite: string } | null {
  if (progreso.tokensAcumulados > config.limites.tokens_por_ejecucion) {
    return {
      motivo: `Límite de tokens superado (${progreso.tokensAcumulados} > ${config.limites.tokens_por_ejecucion})`,
      limite: "tokens_por_ejecucion",
    };
  }
  const minutos =
    (Date.parse(ahoraIso) - Date.parse(inicioIso)) / 60000;
  if (minutos > config.limites.minutos_por_ejecucion) {
    return {
      motivo: `Límite de minutos superado (${minutos.toFixed(1)} > ${config.limites.minutos_por_ejecucion})`,
      limite: "minutos_por_ejecucion",
    };
  }
  const topeUsd = config.limites.usd_por_ejecucion;
  if (
    topeUsd !== undefined &&
    !progreso.usdDesconocido &&
    progreso.usdAcumulado > topeUsd
  ) {
    return {
      motivo: `Límite de dólares por ejecución superado (${progreso.usdAcumulado} > ${topeUsd})`,
      limite: "usd_por_ejecucion",
    };
  }
  return null;
}

export async function fallarEjecucion(
  deps: DependenciasMotor,
  dirBatuta: string,
  runId: string,
  progreso: ProgresoMotor,
  motivo: string,
  limite?: string,
): Promise<ResultadoMotor> {
  if (limite) {
    await deps.store.agregar(runId, {
      tipo: "limite_alcanzado",
      payload: { limite, motivo },
    });
  } else {
    await deps.store.agregar(runId, {
      tipo: "ejecucion_fallida",
      payload: { motivo },
    });
  }
  progreso.motivoFallo = motivo;
  await guardarProgreso(deps.fs, dirBatuta, runId, progreso);
  if (progreso.worktree) {
    await deps.git.volverACommit(
      progreso.worktree.ruta,
      progreso.worktree.ultimoCommit,
    );
  }
  await deps.notificador.notificar({
    tipo: "fallo",
    runId,
    mensaje: motivo,
  });
  return { resultado: "fallida", runId, motivo };
}
