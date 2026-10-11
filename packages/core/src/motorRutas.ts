import { join } from "node:path";
import { dirRun } from "./runStore.js";
import type { BatutaConfig } from "./config.js";
import type { ProgresoMotor } from "./motorTipos.js";
import type { SistemaArchivos } from "./sistema.js";
import type { Puerta } from "./state.js";

export function rutaMotor(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "motor.json");
}

export function rutaSpec(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "spec.md");
}

export function rutaPlan(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "plan.json");
}

export function rutaConfig(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "config.json");
}

export function rutaSolicitud(dirBatuta: string, runId: string, puerta: Puerta): string {
  return join(dirRun(dirBatuta, runId), `aprobacion-${puerta}.md`);
}

export function rutaEspera(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "espera-entrada.md");
}

export function rutaResumen(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "summary.md");
}

export function dirInformes(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "reports");
}

export async function escrituraAtomicaFs(
  fs: SistemaArchivos,
  destino: string,
  datos: string,
): Promise<void> {
  const tmp = `${destino}.tmp`;
  await fs.escribirArchivo(tmp, datos);
  await fs.renombrar(tmp, destino);
}

export async function leerProgreso(
  fs: SistemaArchivos,
  dirBatuta: string,
  runId: string,
): Promise<ProgresoMotor> {
  const texto = await fs.leerArchivo(rutaMotor(dirBatuta, runId));
  return JSON.parse(texto) as ProgresoMotor;
}

export async function guardarProgreso(
  fs: SistemaArchivos,
  dirBatuta: string,
  runId: string,
  progreso: ProgresoMotor,
): Promise<void> {
  await escrituraAtomicaFs(
    fs,
    rutaMotor(dirBatuta, runId),
    JSON.stringify(progreso, null, 2),
  );
}

export async function leerConfigRun(
  fs: SistemaArchivos,
  dirBatuta: string,
  runId: string,
): Promise<BatutaConfig> {
  const texto = await fs.leerArchivo(rutaConfig(dirBatuta, runId));
  return JSON.parse(texto) as BatutaConfig;
}

export async function leerReglasRepo(
  fs: SistemaArchivos,
  dirBatuta: string,
  runId: string,
): Promise<string> {
  try {
    return await fs.leerArchivo(
      join(dirRun(dirBatuta, runId), "reglas.md"),
    );
  } catch {
    return "Sin reglas adicionales.";
  }
}
