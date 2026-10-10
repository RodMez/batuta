import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { detalleError } from "./sistema.js";

/** Opciones para la ejecución de un comando. */
export interface OpcionesEjecucionComando {
  cwd?: string;
  timeoutMs?: number;
  limiteSalidaBytes?: number;
  entornoExtra?: Record<string, string>;
  shell?: boolean | string;
  onStdoutLine?: (linea: string, abortar: (motivo?: string) => void) => void;
}

/** Resultado estructurado de la ejecución de un comando. */
export interface ResultadoComando {
  codigoSalida: number | null;
  salidaEstandar: string;
  salidaError: string;
  duracionMs: number;
  timeoutVencido: boolean;
  canceladoPor?: string;
  bytesDescartadosStdout?: number;
  bytesDescartadosStderr?: number;
  error?: string;
}

/** Opciones para la ejecución de un comando por vector de argumentos. */
export interface OpcionesEjecucionArgs {
  cwd?: string;
  timeoutMs?: number;
  limiteSalidaBytes?: number;
  entornoExtra?: Record<string, string>;
  onStdoutLine?: (linea: string, abortar: (motivo?: string) => void) => void;
}

/** Interfaz inyectable para el ejecutor de comandos. */
export interface EjecutorComandos {
  ejecutar(
    comando: string,
    opciones?: OpcionesEjecucionComando,
  ): Promise<ResultadoComando>;
  ejecutarArgs(
    ejecutable: string,
    args: readonly string[],
    opciones?: OpcionesEjecucionArgs,
  ): Promise<ResultadoComando>;
}

/** Variables de entorno permitidas por defecto en el entorno limpio. */
export const VARIABLES_ENTORNO_PERMITIDAS: readonly string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "windir",
  "COMSPEC",
  "ComSpec",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE",
  "NODE_ENV",
  "NODE_PATH",
];

/**
 * Filtra el entorno del usuario manteniendo solo las variables permitidas
 * y agregando las variables extra (`entorno_gates`). Las comparaciones
 * de nombres son insensibles a mayúsculas para compatibilidad Windows/Linux.
 */
export function construirEntornoLimpio(
  entornoBase: NodeJS.ProcessEnv = process.env,
  entornoExtra: Record<string, string> = {},
  nombresPermitidosExtra: readonly string[] = [],
): NodeJS.ProcessEnv {
  const permitidasNormalizadas = new Set([
    ...VARIABLES_ENTORNO_PERMITIDAS.map((v) => v.toUpperCase()),
    ...nombresPermitidosExtra.map((v) => v.toUpperCase()),
  ]);

  const limpio: Record<string, string> = {};

  for (const [clave, valor] of Object.entries(entornoBase)) {
    if (valor !== undefined && permitidasNormalizadas.has(clave.toUpperCase())) {
      limpio[clave] = valor;
    }
  }

  for (const [clave, valor] of Object.entries(entornoExtra)) {
    limpio[clave] = valor;
  }

  return limpio;
}

/**
 * Acumulador de salida en streaming con límite máximo de bytes en memoria.
 * Si la salida supera el límite, conserva la cabeza y la cola rodante e indica
 * cuántos bytes se descartaron, sin que la memoria crezca sin control.
 */
export class BufferTruncado {
  private readonly maxBytes: number;
  private readonly mitadBytes: number;
  private bytesTotales = 0;
  private readonly cabeza: Buffer[] = [];
  private longitudCabeza = 0;
  private readonly cola: Buffer[] = [];
  private longitudCola = 0;

  constructor(maxBytes = 64 * 1024) {
    this.maxBytes = Math.max(128, maxBytes);
    this.mitadBytes = Math.floor(this.maxBytes / 2);
  }

  agregar(chunk: Buffer): void {
    this.bytesTotales += chunk.length;

    // 1. Llenar la cabeza hasta mitadBytes
    if (this.longitudCabeza < this.mitadBytes) {
      const espacio = this.mitadBytes - this.longitudCabeza;
      if (chunk.length <= espacio) {
        this.cabeza.push(chunk);
        this.longitudCabeza += chunk.length;
        return;
      }
      const parteCabeza = chunk.subarray(0, espacio);
      this.cabeza.push(parteCabeza);
      this.longitudCabeza += parteCabeza.length;
      chunk = chunk.subarray(espacio);
    }

    // 2. Acumular en la cola rodante (máximo mitadBytes)
    this.cola.push(chunk);
    this.longitudCola += chunk.length;

    while (this.longitudCola - (this.cola[0]?.length ?? 0) >= this.mitadBytes) {
      const primero = this.cola.shift();
      if (primero) {
        this.longitudCola -= primero.length;
      }
    }
  }

  obtenerResultado(): { texto: string; descartados: number } {
    if (this.bytesTotales <= this.maxBytes) {
      const buf = Buffer.concat([...this.cabeza, ...this.cola]);
      return { texto: buf.toString("utf8"), descartados: 0 };
    }

    const bufCabeza = Buffer.concat(this.cabeza);
    const bufColaTotal = Buffer.concat(this.cola);
    const bufCola = bufColaTotal.subarray(
      Math.max(0, bufColaTotal.length - this.mitadBytes),
    );
    const descartados = this.bytesTotales - (bufCabeza.length + bufCola.length);

    const separador = `\n\n[... descartados ${descartados} bytes ...]\n\n`;
    const texto = `${bufCabeza.toString("utf8")}${separador}${bufCola.toString("utf8")}`;
    return { texto, descartados };
  }
}

/**
 * Termina todo el árbol de procesos de un PID.
 * - Windows: usa `taskkill /PID <pid> /T /F` para matar el proceso y todos sus descendientes.
 * - Linux / POSIX: usa `process.kill(-pid, "SIGKILL")` sobre el grupo de procesos.
 */
export function matarArbolProcesos(pid: number): void {
  if (pid <= 0 || !Number.isInteger(pid)) {
    return;
  }
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    } catch {
      // Ignorar si el proceso ya terminó
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Ignorar si ya terminó
      }
    }
  }
}

/**
 * Separa una línea de comandos en ejecutable y argumentos respetando
 * comillas simples y dobles para su ejecución directa sin shell.
 */
export function separarComandoYArgumentos(lineaComandos: string): {
  ejecutable: string;
  args: string[];
} {
  const tokens: string[] = [];
  let tokenActual = "";
  let enComillasDobles = false;
  let enComillasSimples = false;

  for (let i = 0; i < lineaComandos.length; i++) {
    const char = lineaComandos[i]!;

    if (char === '"' && !enComillasSimples) {
      enComillasDobles = !enComillasDobles;
    } else if (char === "'" && !enComillasDobles) {
      enComillasSimples = !enComillasSimples;
    } else if (
      char === "\\" &&
      (enComillasDobles || !enComillasSimples) &&
      (lineaComandos[i + 1] === '"' || lineaComandos[i + 1] === "'")
    ) {
      i++;
      tokenActual += lineaComandos[i]!;
    } else if (/\s/.test(char) && !enComillasDobles && !enComillasSimples) {
      if (tokenActual.length > 0) {
        tokens.push(tokenActual);
        tokenActual = "";
      }
    } else {
      tokenActual += char;
    }
  }

  if (tokenActual.length > 0) {
    tokens.push(tokenActual);
  }

  const ejecutable = tokens[0] ?? "";
  const args = tokens.slice(1);
  return { ejecutable, args };
}

/**
 * Ejecutor de comandos real sobre el sistema operativo.
 */
export class EjecutorComandosReal implements EjecutorComandos {
  private readonly limiteSalidaPorDefecto: number;
  private readonly timeoutPorDefectoMs: number;

  constructor(opciones?: {
    limiteSalidaPorDefecto?: number;
    timeoutPorDefectoMs?: number;
  }) {
    this.limiteSalidaPorDefecto = opciones?.limiteSalidaPorDefecto ?? 64 * 1024;
    this.timeoutPorDefectoMs = opciones?.timeoutPorDefectoMs ?? 120_000;
  }

  private async lanzarProceso(
    crearChild: () => ReturnType<typeof spawn>,
    inicio: number,
    timeoutMs: number,
    limiteBytes: number,
    onStdoutLine?: (linea: string, abortar: (motivo?: string) => void) => void,
  ): Promise<ResultadoComando> {
    const bufferStdout = new BufferTruncado(limiteBytes);
    const bufferStderr = new BufferTruncado(limiteBytes);

    return new Promise<ResultadoComando>((resolve) => {
      let timedOut = false;
      let canceladoPor: string | undefined;
      let timer: NodeJS.Timeout | null = null;
      let terminado = false;

      let child;
      try {
        child = crearChild();
      } catch (error) {
        return resolve({
          codigoSalida: null,
          salidaEstandar: "",
          salidaError: `Error al iniciar el comando: ${detalleError(error)}`,
          duracionMs: Date.now() - inicio,
          timeoutVencido: false,
          error: detalleError(error),
        });
      }

      const abortar = (motivo?: string): void => {
        if (terminado) return;
        canceladoPor = motivo ?? "cancelado";
        if (child.pid) {
          matarArbolProcesos(child.pid);
        }
      };

      const finalizar = (codigo: number | null): void => {
        if (terminado) return;
        terminado = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }

        const { texto: salidaEstandar, descartados: descartadosStdout } =
          bufferStdout.obtenerResultado();
        const { texto: salidaError, descartados: descartadosStderr } =
          bufferStderr.obtenerResultado();

        resolve({
          codigoSalida: timedOut ? null : codigo,
          salidaEstandar,
          salidaError,
          duracionMs: Date.now() - inicio,
          timeoutVencido: timedOut,
          canceladoPor,
          bytesDescartadosStdout:
            descartadosStdout > 0 ? descartadosStdout : undefined,
          bytesDescartadosStderr:
            descartadosStderr > 0 ? descartadosStderr : undefined,
        });
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          if (child.pid) {
            matarArbolProcesos(child.pid);
          }
        }, timeoutMs);
      }

      let remanenteStdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        bufferStdout.agregar(chunk);
        if (onStdoutLine) {
          remanenteStdout += chunk.toString("utf8");
          const partes = remanenteStdout.split(/\r?\n/);
          remanenteStdout = partes.pop() ?? "";
          for (const linea of partes) {
            if (linea.trim().length > 0) {
              onStdoutLine(linea, abortar);
            }
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        bufferStderr.agregar(chunk);
      });

      child.on("error", (error) => {
        bufferStderr.agregar(Buffer.from(detalleError(error)));
        finalizar(null);
      });

      child.on("close", (codigo) => {
        if (remanenteStdout.trim().length > 0 && onStdoutLine) {
          onStdoutLine(remanenteStdout, abortar);
        }
        finalizar(codigo);
      });
    });
  }

  async ejecutar(
    comando: string,
    opciones?: OpcionesEjecucionComando,
  ): Promise<ResultadoComando> {
    const inicio = Date.now();
    const cwd = opciones?.cwd;

    if (cwd !== undefined && !existsSync(cwd)) {
      return {
        codigoSalida: null,
        salidaEstandar: "",
        salidaError: `Directorio de trabajo no existe: ${cwd}`,
        duracionMs: Date.now() - inicio,
        timeoutVencido: false,
        error: `ENOENT: directorio no existe: ${cwd}`,
      };
    }

    const timeoutMs = opciones?.timeoutMs ?? this.timeoutPorDefectoMs;
    const limiteBytes = opciones?.limiteSalidaBytes ?? this.limiteSalidaPorDefecto;
    const env = construirEntornoLimpio(process.env, opciones?.entornoExtra);
    const shell = opciones?.shell ?? false;
    const detached = process.platform !== "win32";

    if (shell) {
      return this.lanzarProceso(
        () =>
          spawn(comando, {
            cwd,
            env,
            shell,
            detached,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          }),
        inicio,
        timeoutMs,
        limiteBytes,
        opciones?.onStdoutLine,
      );
    }

    const { ejecutable, args } = separarComandoYArgumentos(comando);
    return this.lanzarProceso(
      () =>
        spawn(ejecutable, args, {
          cwd,
          env,
          shell: false,
          detached,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      inicio,
      timeoutMs,
      limiteBytes,
      opciones?.onStdoutLine,
    );
  }

  async ejecutarArgs(
    ejecutable: string,
    args: readonly string[],
    opciones?: OpcionesEjecucionArgs,
  ): Promise<ResultadoComando> {
    const inicio = Date.now();
    const cwd = opciones?.cwd;

    if (cwd !== undefined && !existsSync(cwd)) {
      return {
        codigoSalida: null,
        salidaEstandar: "",
        salidaError: `Directorio de trabajo no existe: ${cwd}`,
        duracionMs: Date.now() - inicio,
        timeoutVencido: false,
        error: `ENOENT: directorio no existe: ${cwd}`,
      };
    }

    const timeoutMs = opciones?.timeoutMs ?? this.timeoutPorDefectoMs;
    const limiteBytes = opciones?.limiteSalidaBytes ?? this.limiteSalidaPorDefecto;
    const env = construirEntornoLimpio(process.env, opciones?.entornoExtra);
    const detached = process.platform !== "win32";

    return this.lanzarProceso(
      () =>
        spawn(ejecutable, [...args], {
          cwd,
          env,
          shell: false,
          detached,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      inicio,
      timeoutMs,
      limiteBytes,
      opciones?.onStdoutLine,
    );
  }
}
