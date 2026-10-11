import type { BatutaConfig } from "./config.js";
import type { Plan } from "./plan.js";
import type { PasoSiguiente, ProgresoMotor } from "./motorTipos.js";
import type { Puerta, RunState } from "./state.js";

function puertaNecesaria(
  puerta: Puerta,
  config: BatutaConfig,
  aprobaciones: ProgresoMotor["aprobaciones"],
): boolean {
  const habilitada =
    puerta === "H0"
      ? config.aprobaciones.H0_inicio
      : puerta === "H1"
        ? config.aprobaciones.H1_spec
        : puerta === "H2"
          ? config.aprobaciones.H2_plan
          : config.aprobaciones.H3_merge;
  return habilitada && !aprobaciones[puerta].aprobada;
}

/**
 * Función pura: dado el estado, el progreso y la configuración, dice cuál es
 * el siguiente paso. Permite probar todos los escenarios sin efectos.
 */
export function siguientePaso(
  estado: RunState,
  progreso: ProgresoMotor,
  config: BatutaConfig,
): PasoSiguiente {
  if (
    estado.estado === "DONE" ||
    estado.estado === "FAILED" ||
    estado.estado === "ABORTED"
  ) {
    return { paso: "terminada", estado: estado.estado };
  }
  if (estado.estado === "AWAITING_APPROVAL" && estado.puerta_pendiente) {
    return { paso: "esperar-aprobacion", puerta: estado.puerta_pendiente };
  }
  if (estado.estado === "WAITING_INPUT") {
    return {
      paso: "esperar-entrada",
      pregunta: progreso.esperaEntrada?.pregunta ?? "",
    };
  }
  switch (estado.estado) {
    case "INTAKE": {
      if (puertaNecesaria("H0", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H0" };
      }
      return { paso: "emitir-spec" };
    }
    case "SPEC": {
      if (puertaNecesaria("H1", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H1" };
      }
      return { paso: "emitir-plan" };
    }
    case "PLAN": {
      if (puertaNecesaria("H2", config, progreso.aprobaciones)) {
        return { paso: "solicitar-aprobacion", puerta: "H2" };
      }
      if (progreso.subtareaIndice < progreso.totalSubtareas) {
        return { paso: "ejecutar-subtarea", indice: progreso.subtareaIndice };
      }
      return { paso: "generar-cierre" };
    }
    case "CHECKPOINT":
    case "RETRY":
    case "DEBUG":
    case "IMPLEMENT":
    case "VERIFY": {
      if (progreso.subtareaIndice < progreso.totalSubtareas) {
        return { paso: "ejecutar-subtarea", indice: progreso.subtareaIndice };
      }
      return { paso: "generar-cierre" };
    }
    case "REVIEW":
    case "FINALIZE": {
      if (
        estado.estado === "FINALIZE" &&
        puertaNecesaria("H3", config, progreso.aprobaciones)
      ) {
        return { paso: "solicitar-aprobacion", puerta: "H3" };
      }
      return { paso: "generar-cierre" };
    }
    default: {
      throw new Error(`Estado no contemplado en siguientePaso: ${estado.estado}`);
    }
  }
}

export function progresoInicial(
  runId: string,
  plan: Plan,
  specHash: string,
  planHash: string,
  inicioIso: string,
): ProgresoMotor {
  return {
    version: 1,
    runId,
    inicioIso,
    specHash,
    planHash,
    aprobaciones: {
      H0: { aprobada: false },
      H1: { aprobada: false },
      H2: { aprobada: false },
      H3: { aprobada: false },
    },
    subtareaIndice: 0,
    totalSubtareas: plan.subtareas.length,
    subtareas: plan.subtareas.map((s) => ({
      id: s.id,
      intentos: 0,
      firmas: [],
      informes: [],
      continuaciones: 0,
      modelosUsados: [],
      rolesUsados: [],
      gatesFallidos: [],
      tokens: 0,
      usd: 0,
      completada: false,
      commit: null,
    })),
    tokensAcumulados: 0,
    usdAcumulado: 0,
    usdDesconocido: false,
    advertenciaEmitida: false,
    preguntasUsadas: 0,
    usoPorRol: {},
    gatesFallidosGlobal: [],
    worktree: null,
  };
}
