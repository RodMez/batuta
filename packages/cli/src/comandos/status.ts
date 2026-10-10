import { z } from "zod";
import {
  listarEjecuciones,
  rutaResumen,
  rutaSolicitud,
  RunStore,
  type ProgresoMotor,
  type RunState,
} from "@batuta/core";
import { join } from "node:path";
import { dirBatutaDe, resolverRepo, type EntornoCLI } from "../contexto.js";
import {
  CODIGO_TERMINADA,
  CODIGO_USO,
  formatearError,
  type ResultadoCLI,
} from "../salida.js";

/** Salida estable de `status --json`, validada con esquema. */
export const StatusJsonSchema = z.strictObject({
  run_id: z.string().min(1),
  estado: z.string().min(1),
  puerta_pendiente: z.string().nullable(),
  pregunta_pendiente: z.string().nullable(),
  subtareas: z.array(
    z.strictObject({
      id: z.string(),
      completada: z.boolean(),
      intentos: z.number().int().nonnegative(),
    }),
  ),
  avance: z.strictObject({
    completadas: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  tokens_acumulados: z.number().int().nonnegative(),
  usd_acumulado: z.number().nonnegative(),
  usd_desconocido: z.boolean(),
  ultimo_evento: z
    .strictObject({ tipo: z.string(), ts: z.string() })
    .nullable(),
  rutas: z.strictObject({
    worktree: z.string().nullable(),
    spec: z.string(),
    plan: z.string(),
    resumen: z.string(),
    solicitud: z.string().nullable(),
  }),
});

export type StatusJson = z.infer<typeof StatusJsonSchema>;

export interface ArgsStatus {
  runId?: string;
  repoDir?: string;
  json: boolean;
  debug: boolean;
}

export async function ejecutarStatus(
  args: ArgsStatus,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    return await ejecutarStatusInterno(args, entorno);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}

async function ejecutarStatusInterno(
  args: ArgsStatus,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  const repoDir = resolverRepo(args.repoDir);
  const dirBatuta = dirBatutaDe(repoDir);
  const store = new RunStore(dirBatuta, entorno.fs, entorno.reloj);

  if (!args.runId) {
    const ids = await listarEjecuciones(entorno.fs, dirBatuta);
    if (ids.length === 0) {
      return { texto: "No hay ejecuciones.", codigo: CODIGO_TERMINADA };
    }
    if (args.json) {
      const fichas = [];
      for (const id of ids) {
        fichas.push(await fichaEstado(entorno, dirBatuta, store, id));
      }
      return {
        texto: JSON.stringify(StatusJsonSchema.array().parse(fichas), null, 2),
        codigo: CODIGO_TERMINADA,
      };
    }
    const lineas = ["Ejecuciones:"];
    for (const id of ids) {
      try {
        const ficha = await fichaEstado(entorno, dirBatuta, store, id);
        lineas.push(
          `- ${id}: ${ficha.estado} (${ficha.avance.completadas}/${ficha.avance.total} subtareas)`,
        );
      } catch {
        lineas.push(`- ${id}: ilegible`);
      }
    }
    return { texto: lineas.join("\n"), codigo: CODIGO_TERMINADA };
  }

  const ficha = await fichaEstado(entorno, dirBatuta, store, args.runId);
  if (args.json) {
    return {
      texto: JSON.stringify(StatusJsonSchema.parse(ficha), null, 2),
      codigo: CODIGO_TERMINADA,
    };
  }
  const lineas = [
    `Ejecución: ${ficha.run_id}`,
    `Estado: ${ficha.estado}`,
  ];
  if (ficha.puerta_pendiente) lineas.push(`Puerta pendiente: ${ficha.puerta_pendiente}`);
  if (ficha.pregunta_pendiente) lineas.push(`Pregunta pendiente: ${ficha.pregunta_pendiente}`);
  lineas.push(
    `Avance: ${ficha.avance.completadas}/${ficha.avance.total} subtareas`,
    ...ficha.subtareas.map(
      (s) => `  - ${s.id}: ${s.completada ? "completada" : "pendiente"} (${s.intentos} fallos)`,
    ),
    `Tokens: ${ficha.tokens_acumulados}`,
    `Costo: $${ficha.usd_acumulado.toFixed(6)}${ficha.usd_desconocido ? " (parcialmente desconocido)" : ""}`,
  );
  if (ficha.ultimo_evento) {
    lineas.push(`Último evento: ${ficha.ultimo_evento.tipo} (${ficha.ultimo_evento.ts})`);
  }
  lineas.push(
    `Spec: ${ficha.rutas.spec}`,
    `Plan: ${ficha.rutas.plan}`,
    `Resumen: ${ficha.rutas.resumen}`,
  );
  if (ficha.rutas.worktree) lineas.push(`Worktree: ${ficha.rutas.worktree}`);
  if (ficha.rutas.solicitud) lineas.push(`Solicitud: ${ficha.rutas.solicitud}`);
  return { texto: lineas.join("\n"), codigo: CODIGO_TERMINADA };
}

async function fichaEstado(
  entorno: EntornoCLI,
  dirBatuta: string,
  store: RunStore,
  runId: string,
): Promise<StatusJson> {
  let estado: RunState;
  try {
    estado = await store.estado(runId);
  } catch {
    throw new Error(`Ejecución desconocida: "${runId}" (¿repo correcto con --repo?).`);
  }
  let progreso: ProgresoMotor | null = null;
  try {
    const texto = await entorno.fs.leerArchivo(
      join(dirBatuta, "runs", runId, "motor.json"),
    );
    progreso = JSON.parse(texto) as ProgresoMotor;
  } catch {
    progreso = null;
  }
  const lectura = await store.leer(runId);
  const ultimo = lectura.eventos[lectura.eventos.length - 1];
  const subtareas = (progreso?.subtareas ?? []).map((s) => ({
    id: s.id,
    completada: s.completada,
    intentos: s.intentos,
  }));
  const puerta =
    estado.estado === "AWAITING_APPROVAL" ? estado.puerta_pendiente : null;
  return {
    run_id: runId,
    estado: estado.estado,
    puerta_pendiente: puerta,
    pregunta_pendiente:
      estado.estado === "WAITING_INPUT"
        ? (progreso?.esperaEntrada?.pregunta ?? "")
        : null,
    subtareas,
    avance: {
      completadas: subtareas.filter((s) => s.completada).length,
      total: subtareas.length,
    },
    tokens_acumulados: progreso?.tokensAcumulados ?? 0,
    usd_acumulado: progreso?.usdAcumulado ?? 0,
    usd_desconocido: progreso?.usdDesconocido ?? false,
    ultimo_evento: ultimo ? { tipo: ultimo.tipo, ts: ultimo.ts } : null,
    rutas: {
      worktree: progreso?.worktree?.ruta ?? null,
      spec: join(dirBatuta, "runs", runId, "spec.md"),
      plan: join(dirBatuta, "runs", runId, "plan.json"),
      resumen: rutaResumen(dirBatuta, runId),
      solicitud: puerta ? rutaSolicitud(dirBatuta, runId, puerta) : null,
    },
  };
}
