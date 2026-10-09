import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

/**
 * Reloj inyectable. Solo entrega la hora en ISO 8601; las funciones puras
 * (reductor, ids, rutas, troceado del registro) nunca lo leen, así las
 * pruebas usan un reloj fijo sin depender de la hora real.
 */
export interface Reloj {
  ahoraIso(): string;
}

/** Reloj del sistema para producción. */
export const relojSistema: Reloj = {
  ahoraIso: (): string => new Date().toISOString(),
};

/**
 * Mínimo de entrada/salida de archivos que necesita el registro.
 * Toda la E/S del hito 2 pasa por aquí para poder probarla con un
 * sistema en memoria, sin tocar el disco real.
 */
export interface SistemaArchivos {
  crearDir(ruta: string): Promise<void>;
  leerArchivo(ruta: string): Promise<string>;
  escribirArchivo(ruta: string, datos: string): Promise<void>;
  /** Escribe solo si el archivo no existe; falla en caso contrario. */
  escribirExclusivo(ruta: string, datos: string): Promise<void>;
  agregarArchivo(ruta: string, datos: string): Promise<void>;
  renombrar(origen: string, destino: string): Promise<void>;
  listarDir(ruta: string): Promise<string[]>;
  borrar(ruta: string): Promise<void>;
}

/** Implementación real sobre `node:fs/promises` (Windows y Linux). */
export const sistemaArchivosNode: SistemaArchivos = {
  crearDir: (ruta: string): Promise<void> => {
    return mkdir(ruta, { recursive: true }).then((): void => undefined);
  },
  leerArchivo: (ruta: string): Promise<string> => {
    return readFile(ruta, "utf8");
  },
  escribirArchivo: (ruta: string, datos: string): Promise<void> => {
    return writeFile(ruta, datos, "utf8").then((): void => undefined);
  },
  escribirExclusivo: (ruta: string, datos: string): Promise<void> => {
    return writeFile(ruta, datos, { encoding: "utf8", flag: "wx" }).then(
      (): void => undefined,
    );
  },
  agregarArchivo: (ruta: string, datos: string): Promise<void> => {
    return appendFile(ruta, datos, "utf8").then((): void => undefined);
  },
  renombrar: (origen: string, destino: string): Promise<void> => {
    return rename(origen, destino).then((): void => undefined);
  },
  listarDir: (ruta: string): Promise<string[]> => {
    return readdir(ruta);
  },
  borrar: (ruta: string): Promise<void> => {
    return rm(ruta).then((): void => undefined);
  },
};

/** Indica si un error de E/S es "no existe" (código ENOENT). */
export function esNoEncontrado(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Mensaje corto de un error desconocido, sin exponer el entorno. */
export function detalleError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Comprueba si un proceso sigue vivo por su PID de forma portable
 * (Windows y Linux) sin enviar una señal destructiva.
 */
export function existeProceso(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "EPERM"
    ) {
      return true;
    }
    return false;
  }
}

