import { dirRuns } from "./runStore.js";
import { esNoEncontrado } from "./sistema.js";
import type { SistemaArchivos } from "./sistema.js";

/**
 * Lista los identificadores de ejecución en `<dirBatuta>/runs/`,
 * ordenados. Un directorio inexistente equivale a lista vacía.
 */
export async function listarEjecuciones(
  fs: SistemaArchivos,
  dirBatuta: string,
): Promise<string[]> {
  let nombres: string[];
  try {
    nombres = await fs.listarDir(dirRuns(dirBatuta));
  } catch (error) {
    if (esNoEncontrado(error)) return [];
    throw error;
  }
  return nombres.filter((n) => n.length > 0).sort();
}
