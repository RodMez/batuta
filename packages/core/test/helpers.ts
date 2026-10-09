import type { NuevoEvento, Reloj, SistemaArchivos } from "../src/index.js";

function errorSistema(codigo: string, ruta: string): Error {
  const error = new Error(`${codigo}: ${ruta}`) as Error & { code: string };
  error.code = codigo;
  return error;
}

/**
 * Normaliza separadores a `/` para que el sistema en memoria se comporte
 * igual con las rutas de `node:path` en Windows (`\`) y en Linux (`/`).
 */
function normalizar(ruta: string): string {
  return ruta.replace(/\\/g, "/");
}

/**
 * Sistema de archivos en memoria para probar sin disco real ni rutas
 * absolutas. Registra las operaciones para evidenciar, por ejemplo, que
 * `state.json` se escribe vía temporal + renombrado.
 */
export class SistemaArchivosMemoria implements SistemaArchivos {
  private readonly archivos = new Map<string, string>();
  private readonly dirs = new Set<string>();
  readonly operaciones: string[] = [];

  async crearDir(ruta: string): Promise<void> {
    const clave = normalizar(ruta);
    this.dirs.add(clave);
    this.operaciones.push(`mkdir ${clave}`);
  }

  async leerArchivo(ruta: string): Promise<string> {
    const datos = this.archivos.get(normalizar(ruta));
    if (datos === undefined) throw errorSistema("ENOENT", ruta);
    return datos;
  }

  async escribirArchivo(ruta: string, datos: string): Promise<void> {
    const clave = normalizar(ruta);
    this.archivos.set(clave, datos);
    this.operaciones.push(`write ${clave}`);
  }

  async escribirExclusivo(ruta: string, datos: string): Promise<void> {
    const clave = normalizar(ruta);
    if (this.archivos.has(clave)) throw errorSistema("EEXIST", ruta);
    this.archivos.set(clave, datos);
    this.operaciones.push(`write-new ${clave}`);
  }

  async agregarArchivo(ruta: string, datos: string): Promise<void> {
    const clave = normalizar(ruta);
    this.archivos.set(clave, (this.archivos.get(clave) ?? "") + datos);
    this.operaciones.push(`append ${clave}`);
  }

  async renombrar(origen: string, destino: string): Promise<void> {
    const desde = normalizar(origen);
    const hasta = normalizar(destino);
    const datos = this.archivos.get(desde);
    if (datos === undefined) throw errorSistema("ENOENT", origen);
    this.archivos.delete(desde);
    this.archivos.set(hasta, datos);
    this.operaciones.push(`rename ${desde} -> ${hasta}`);
  }

  async listarDir(ruta: string): Promise<string[]> {
    const base = normalizar(ruta);
    const prefijo = base.endsWith("/") ? base : `${base}/`;
    const hijos = new Set<string>();
    for (const clave of [...this.archivos.keys(), ...this.dirs]) {
      if (clave.startsWith(prefijo)) {
        const resto = clave.slice(prefijo.length);
        const nombre = resto.split("/")[0];
        if (nombre !== undefined && nombre !== "") hijos.add(nombre);
      }
    }
    if (hijos.size === 0 && !this.dirs.has(base)) {
      throw errorSistema("ENOENT", ruta);
    }
    return [...hijos];
  }

  async borrar(ruta: string): Promise<void> {
    if (!this.archivos.delete(normalizar(ruta))) {
      throw errorSistema("ENOENT", ruta);
    }
    this.operaciones.push(`rm ${normalizar(ruta)}`);
  }

  /** Solo para pruebas: contenido crudo de un archivo o undefined. */
  verArchivo(ruta: string): string | undefined {
    return this.archivos.get(normalizar(ruta));
  }
}

/** Reloj fijo con avance manual (nada depende de la hora real). */
export function crearRelojFijo(
  inicio = "2026-10-09T12:00:00.000Z",
): Reloj & { avanzar: (segundos?: number) => void } {
  let instante = Date.parse(inicio);
  return {
    ahoraIso: (): string => new Date(instante).toISOString(),
    avanzar: (segundos = 1): void => {
      instante += segundos * 1000;
    },
  };
}

/**
 * Guion que recorre el ciclo de vida completo (sección 4): H0, spec, H1,
 * plan, subtarea con reintento, checkpoint, espera de entrada, revisión,
 * PR, H3 y DONE. Son los eventos posteriores a `ejecucion_iniciada`.
 */
export function guionCicloCompleto(): NuevoEvento[] {
  return [
    { tipo: "aprobacion_solicitada", payload: { puerta: "H0" } },
    { tipo: "aprobacion_otorgada", payload: { puerta: "H0" } },
    { tipo: "spec_creada" },
    { tipo: "aprobacion_solicitada", payload: { puerta: "H1" } },
    { tipo: "aprobacion_otorgada", payload: { puerta: "H1" } },
    { tipo: "plan_creado" },
    { tipo: "subtarea_iniciada", paso: "SUB-01", agente: "software-engineer" },
    {
      tipo: "agente_completado",
      paso: "SUB-01",
      agente: "software-engineer",
      payload: { costo_usd: 0.4, modelo: "m-fuerte" },
    },
    { tipo: "gate_ejecutado", paso: "SUB-01", payload: { gate: "lint", ok: true } },
    { tipo: "reintento_programado", paso: "SUB-01" },
    { tipo: "subtarea_iniciada", paso: "SUB-01", agente: "software-engineer" },
    {
      tipo: "agente_completado",
      paso: "SUB-01",
      agente: "software-engineer",
      payload: { costo_usd: 0.6, modelo: "m-fuerte" },
    },
    { tipo: "gate_ejecutado", paso: "SUB-01", payload: { gate: "tests", ok: true } },
    { tipo: "checkpoint_creado", paso: "SUB-01" },
    { tipo: "entrada_requerida", payload: { pregunta: "¿Continuar?" } },
    { tipo: "entrada_recibida", payload: { retomar_en: "CHECKPOINT" } },
    { tipo: "revision_completada" },
    { tipo: "pr_creada" },
    { tipo: "aprobacion_solicitada", payload: { puerta: "H3" } },
    { tipo: "aprobacion_otorgada", payload: { puerta: "H3" } },
    { tipo: "ejecucion_completada" },
  ];
}
