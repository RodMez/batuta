import { join } from "node:path";
import {
  MotorFlujo,
  RunStore,
  parsePlan,
} from "@batuta/core";
import {
  cargarGuion,
  crearRunner,
  dirBatutaDe,
  leerReglasRepo,
  resolverRepo,
  rutaConfig,
  type EntornoCLI,
} from "../contexto.js";
import { ejecutarChequeos, formatearChequeos } from "../preflight.js";
import {
  CODIGO_USO,
  formatearError,
  presentarResultado,
  type ResultadoCLI,
} from "../salida.js";

export interface ArgsRun {
  spec?: string;
  plan?: string;
  brief?: string;
  configPath?: string;
  repoDir?: string;
  base?: string;
  simulado?: string;
  debug: boolean;
}

/**
 * Asegura `.batuta/` en `.git/info/exclude` para que la carpeta de
 * ejecuciones no ensucie el árbol ni falle la comprobación de limpio.
 */
export async function asegurarExclusionBatuta(
  entorno: EntornoCLI,
  repoDir: string,
): Promise<void> {
  const ruta = join(repoDir, ".git", "info", "exclude");
  let contenido = "";
  try {
    contenido = await entorno.fs.leerArchivo(ruta);
  } catch {
    contenido = "";
  }
  const lineas = contenido.split(/\r?\n/);
  if (lineas.some((l) => l.trim() === ".batuta/")) return;
  const base = contenido.length > 0 && !contenido.endsWith("\n") ? "\n" : "";
  try {
    await entorno.fs.escribirArchivo(ruta, `${contenido}${base}.batuta/\n`);
  } catch {
    // Si no se puede escribir (p. ej. sin .git), el preflight lo señalará.
  }
}

export async function ejecutarRun(
  args: ArgsRun,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  try {
    return await ejecutarRunInterno(args, entorno);
  } catch (error) {
    return { texto: formatearError(error, args.debug), codigo: CODIGO_USO };
  }
}

async function ejecutarRunInterno(
  args: ArgsRun,
  entorno: EntornoCLI,
): Promise<ResultadoCLI> {
  if (args.brief) {
    throw new Error(
      "«brief» aún no está disponible: usa --spec <spec.md> y --plan <plan.json> (el agente architect llega en el hito 8).",
    );
  }
  if (!args.spec) throw new Error("Falta --spec <spec.md>.");
  if (!args.plan) throw new Error("Falta --plan <plan.json>.");

  const repoDir = resolverRepo(args.repoDir);
  const configPath = rutaConfig(repoDir, args.configPath);

  let specContenido: string;
  try {
    specContenido = await entorno.fs.leerArchivo(args.spec);
  } catch {
    throw new Error(`No se puede leer la spec en "${args.spec}".`);
  }
  let planContenido: unknown;
  try {
    const textoPlan = await entorno.fs.leerArchivo(args.plan);
    planContenido = JSON.parse(textoPlan) as unknown;
  } catch {
    throw new Error(`No se puede leer el plan en "${args.plan}" (debe ser JSON válido).`);
  }
  let planValido;
  try {
    planValido = parsePlan(planContenido);
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    throw new Error(`Plan inválido: ${detalle}`);
  }
  void planValido;

  const reglasRepo = await leerReglasRepo(repoDir);
  await asegurarExclusionBatuta(entorno, repoDir);

  const { chequeos, config } = await ejecutarChequeos(entorno, {
    repoDir,
    configPath,
    refBase: args.base,
    simulado: args.simulado !== undefined,
  });
  if (!config || chequeos.some((c) => c.estado === "error")) {
    return {
      texto: ["El preflight no pasó:", formatearChequeos(chequeos)].join("\n"),
      codigo: CODIGO_USO,
    };
  }

  let guion;
  if (args.simulado) {
    guion = await cargarGuion(args.simulado, entorno);
  }
  const dirBatuta = dirBatutaDe(repoDir);
  const store = new RunStore(dirBatuta, entorno.fs, entorno.reloj);
  const motor = new MotorFlujo({
    runner: crearRunner(entorno, config, guion, 0),
    git: entorno.git,
    ejecutor: entorno.ejecutor,
    store,
    reloj: entorno.reloj,
    notificador: entorno.notificador,
    fs: entorno.fs,
  });
  const resultado = await motor.iniciar({
    config,
    specContenido,
    planContenido,
    reglasRepo,
    directorioRepo: repoDir,
    dirBatuta,
    refBase: args.base,
  });
  return presentarResultado(resultado, dirBatuta);
}
