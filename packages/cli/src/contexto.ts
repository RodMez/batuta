import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AntigravityRunner,
  ClaudeCodeRunner,
  EjecutorComandosReal,
  ModuloGitReal,
  MotorFlujo,
  NotificadorNulo,
  RunnerGuionado,
  leerConfigRun,
  parseBatutaConfigYaml,
  parseGuionJson,
  relojSistema,
  resolverTipoRunner,
  sistemaArchivosNode,
  RunStore,
  type AgentRunner,
  type BatutaConfig,
  type EjecutorComandos,
  type GuionSimulado,
  type ModuloGit,
  type Notificador,
  type ProgresoMotor,
  type Reloj,
  type SistemaArchivos,
} from "@batuta/core";

/** Dependencias inyectables de los manejadores (ver pauta del hito 0). */
export interface EntornoCLI {
  fs: SistemaArchivos;
  reloj: Reloj;
  ejecutor: EjecutorComandos;
  git: ModuloGit;
  notificador: Notificador;
}

/** Entorno de producción: disco, reloj y ejecutores reales. */
export function entornoReal(): EntornoCLI {
  return {
    fs: sistemaArchivosNode,
    reloj: relojSistema,
    ejecutor: new EjecutorComandosReal(),
    git: new ModuloGitReal(new EjecutorComandosReal()),
    notificador: new NotificadorNulo(),
  };
}

/** Directorio del repositorio (por defecto, el actual). */
export function resolverRepo(repoOpt?: string): string {
  return resolve(repoOpt ?? process.cwd());
}

/** Ruta de `batuta.yaml` (por defecto, en el repositorio). */
export function rutaConfig(repoDir: string, configOpt?: string): string {
  return configOpt ? resolve(configOpt) : join(repoDir, "batuta.yaml");
}

/** Carpeta de ejecuciones (sección 6: `.batuta/` en el repositorio). */
export function dirBatutaDe(repoDir: string): string {
  return join(repoDir, ".batuta");
}

/** Reglas del repositorio (`AGENTS.md`) o texto alternativo claro. */
export async function leerReglasRepo(repoDir: string): Promise<string> {
  try {
    return await readFile(join(repoDir, "AGENTS.md"), "utf8");
  } catch {
    return "Sin reglas de repositorio (falta AGENTS.md).";
  }
}

/** Lee y valida la configuración con errores en español. */
export async function cargarConfiguracion(
  ruta: string,
  entorno: EntornoCLI,
): Promise<BatutaConfig> {
  let texto: string;
  try {
    texto = await entorno.fs.leerArchivo(ruta);
  } catch {
    throw new Error(
      `No existe la configuración en "${ruta}" (usa --config para indicar otra).`,
    );
  }
  try {
    return parseBatutaConfigYaml(texto);
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    throw new Error(`Configuración inválida en "${ruta}": ${detalle}`);
  }
}

/** Lee el guion simulado de un archivo y lo valida. */
export async function cargarGuion(
  ruta: string,
  entorno: EntornoCLI,
): Promise<GuionSimulado> {
  let texto: string;
  try {
    texto = await entorno.fs.leerArchivo(resolve(ruta));
  } catch {
    throw new Error(`No se puede leer el guion en "${ruta}".`);
  }
  try {
    return parseGuionJson(texto);
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    throw new Error(`Guion inválido en "${ruta}": ${detalle}`);
  }
}

/**
 * Llamadas al runner ya registradas: el guion continúa donde lo dejó aunque
 * cada comando corra en un proceso distinto.
 */
export async function indiceGuionActual(
  entorno: EntornoCLI,
  dirBatuta: string,
  runId: string,
): Promise<number> {
  try {
    const texto = await entorno.fs.leerArchivo(
      join(dirBatuta, "runs", runId, "motor.json"),
    );
    const progreso = JSON.parse(texto) as ProgresoMotor;
    return Object.values(progreso.usoPorRol).reduce(
      (total, u) => total + u.llamadas,
      0,
    );
  } catch {
    return 0;
  }
}

/** Construye el runner: guionado con `--simulado` o la herramienta real. */
export function crearRunner(
  entorno: EntornoCLI,
  config: BatutaConfig,
  guion?: GuionSimulado,
  desde = 0,
): AgentRunner {
  if (guion) return new RunnerGuionado(guion, desde);
  const tipo = resolverTipoRunner(config);
  if (tipo === "antigravity") {
    return new AntigravityRunner(
      {
        binPath: config.runner?.bin_path ?? "agy",
        timeoutMs: (config.runner?.timeout_seg ?? 300) * 1000,
        umbralCuota: config.runner?.umbral_cuota ?? 0.05,
      },
      {
        ejecutor: entorno.ejecutor,
      },
    );
  }
  return new ClaudeCodeRunner(entorno.ejecutor, config);
}

export interface DepsEjecucion {
  dirBatuta: string;
  config: BatutaConfig;
  store: RunStore;
  motor: MotorFlujo;
}

/**
 * Prepara lo común para continuar una ejecución: resuelve rutas, lee la
 * configuración guardada en la ejecución y arma registro, motor y runner.
 */
export async function prepararContinuacion(
  entorno: EntornoCLI,
  repoDir: string,
  runId: string,
  guionPath?: string,
): Promise<DepsEjecucion> {
  const dirBatuta = dirBatutaDe(repoDir);
  const store = new RunStore(dirBatuta, entorno.fs, entorno.reloj);
  let config: BatutaConfig;
  try {
    config = await leerConfigRun(entorno.fs, dirBatuta, runId);
  } catch {
    throw new Error(
      `Ejecución desconocida: "${runId}" (¿repo correcto con --repo?).`,
    );
  }
  let guion: GuionSimulado | undefined;
  let desde = 0;
  if (guionPath) {
    guion = await cargarGuion(guionPath, entorno);
    desde = await indiceGuionActual(entorno, dirBatuta, runId);
  }
  const motor = new MotorFlujo({
    runner: crearRunner(entorno, config, guion, desde),
    git: entorno.git,
    ejecutor: entorno.ejecutor,
    store,
    reloj: entorno.reloj,
    notificador: entorno.notificador,
    fs: entorno.fs,
  });
  return { dirBatuta, config, store, motor };
}
