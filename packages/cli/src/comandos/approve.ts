import {
  hashContenido,
  parsePlan,
  rutaResumen,
  rutaSolicitud,
  type BatutaConfig,
  type Puerta,
} from "@batuta/core";
import { join } from "node:path";
import {
  prepararContinuacion,
  resolverRepo,
  type EntornoCLI,
} from "../contexto.js";
import {
  CODIGO_USO,
  formatearError,
  presentarResultado,
  type ResultadoCLI,
} from "../salida.js";

export const PUERTAS_VALIDAS: readonly Puerta[] = ["H0", "H1", "H2", "H3"];

export interface ArgsApprove {
  runId: string;
  puerta: string;
  repoDir?: string;
  simulado?: string;
  rechazar: boolean;
  comentario?: string;
  soloRegistrar: boolean;
  debug: boolean;
}

export async function ejecutarApprove(
  args: ArgsApprove,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    return await ejecutarApproveInterno(args, entorno);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}

function esPuerta(valor: string): valor is Puerta {
  return (PUERTAS_VALIDAS as readonly string[]).includes(valor);
}

async function ejecutarApproveInterno(
  args: ArgsApprove,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  if (!esPuerta(args.puerta)) {
    throw new Error(
      `Puerta inválida: "${args.puerta}". Usa una de H0, H1, H2 o H3.`,
    );
  }
  const repoDir = resolverRepo(args.repoDir);
  const { dirBatuta, config, motor } = await prepararContinuacion(
    entorno,
    repoDir,
    args.runId,
    args.simulado,
  );
  const lineas = await describirAprobacion(entorno, dirBatuta, args.runId, config, args.puerta);

  if (args.rechazar) {
    const motivo = args.comentario?.trim() || "Rechazada por la persona";
    const resultado = await motor.rechazar(args.runId, dirBatuta, args.puerta, motivo);
    return {
      texto: [...lineas, `Rechazada ${args.puerta}: ${motivo}.`, presentarResultado(resultado, dirBatuta).texto].join("\n"),
      codigo: 0,
    };
  }

  if (args.soloRegistrar) {
    const pausa = await motor.registrarAprobacion(args.runId, dirBatuta, args.puerta);
    if (pausa) {
      return presentarResultado(pausa, dirBatuta);
    }
    return {
      texto: [
        ...lineas,
        `Aprobación ${args.puerta} registrada sin continuar.`,
        `Siguiente: batuta resume ${args.runId}`,
      ].join("\n"),
      codigo: 10,
    };
  }

  const resultado = await motor.aprobar(args.runId, dirBatuta, args.puerta);
  return presentarResultado(resultado, dirBatuta);
}

/** Qué se aprueba en cada puerta, con rutas y hashes. */
async function describirAprobacion(
  entorno: EntornoCLI,
  dirBatuta: string,
  runId: string,
  config: BatutaConfig,
  puerta: Puerta,
): Promise<string[]> {
  const base = join(dirBatuta, "runs", runId);
  switch (puerta) {
    case "H0": {
      return [
        `Se aprueba H0 (presupuesto y límites) en ${runId}:`,
        `  tokens_por_ejecucion: ${config.limites.tokens_por_ejecucion}`,
        `  minutos_por_ejecucion: ${config.limites.minutos_por_ejecucion}`,
        `  usd_por_agente: ${config.limites.usd_por_agente}`,
        `  pasos_por_agente: ${config.limites.pasos_por_agente}`,
        `  intentos_por_subtarea: ${config.limites.intentos_por_subtarea}`,
      ];
    }
    case "H1": {
      const ruta = join(base, "spec.md");
      const spec = await entorno.fs.leerArchivo(ruta);
      return [
        `Se aprueba H1 (especificación) en ${runId}:`,
        `  Spec: ${ruta}`,
        `  Hash: ${hashContenido(spec)}`,
      ];
    }
    case "H2": {
      const ruta = join(base, "plan.json");
      const texto = await entorno.fs.leerArchivo(ruta);
      const plan = parsePlan(JSON.parse(texto) as unknown);
      return [
        `Se aprueba H2 (plan) en ${runId}:`,
        `  Plan: ${ruta}`,
        `  Hash: ${hashContenido(texto)}`,
        ...plan.subtareas.map((s) => `  - ${s.id}: ${s.titulo} [${s.complejidad}]`),
      ];
    }
    case "H3": {
      return [
        `Se aprueba H3 (fusión final) en ${runId}:`,
        `  Resumen: ${rutaResumen(dirBatuta, runId)}`,
        `  Solicitud: ${rutaSolicitud(dirBatuta, runId, "H3")}`,
      ];
    }
  }
}
