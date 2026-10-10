import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { EjecutorComandos, ResultadoComando } from "./commandRunner.js";
import { EjecutorComandosReal } from "./commandRunner.js";
import type { CambioArchivo } from "./diffPolicy.js";

/** Versión mínima de Git requerida para soporte completo y estable de worktrees. */
export const VERSION_MINIMA_GIT = "2.20.0";

/** Identidad por defecto con la que Batuta firma los commits de subtareas. */
export const IDENTIDAD_BATUTA_POR_DEFECTO = {
  nombre: "Batuta",
  email: "batuta@localhost",
} as const;

/** Resultado de las comprobaciones previas del repositorio. */
export interface InfoComprobacionesPrevias {
  esRepo: boolean;
  ramaActual: string | null;
  arbolLimpio: boolean;
  referenciaExiste: boolean;
  versionGit: string | null;
  versionSuficiente: boolean;
  detalle?: string;
}

/** Información del worktree creado para una ejecución. */
export interface InfoWorktree {
  ruta: string;
  rama: string;
  commitBase: string;
}

/** Opciones para la creación de un worktree. */
export interface OpcionesCrearWorktree {
  refBase?: string;
  directorioWorktrees?: string;
}

/** Resultado de confirmar una subtarea en el worktree. */
export interface ResultadoCommitSubtarea {
  creado: boolean;
  hash: string | null;
  mensaje?: string;
}

/** Opciones para listar cambios respecto a un commit. */
export interface OpcionesListarCambios {
  commitBase?: string;
}

/** Información de un worktree listado por Git. */
export interface WorktreeListado {
  ruta: string;
  head: string;
  rama: string | null;
  esBatuta: boolean;
  runId: string | null;
  prunable: boolean;
}

/** Worktrees y ramas huérfanas detectadas en el repositorio. */
export interface WorktreesHuerfanos {
  worktreesHuerfanos: WorktreeListado[];
  ramasHuerfanas: string[];
}

/** Interfaz inyectable para el módulo de operaciones Git. */
export interface ModuloGit {
  comprobacionesPrevias(
    directorio: string,
    refBase?: string,
  ): Promise<InfoComprobacionesPrevias>;

  crearWorktree(
    directorioRepo: string,
    runId: string,
    opciones?: OpcionesCrearWorktree,
  ): Promise<InfoWorktree>;

  confirmarSubtarea(
    rutaWorktree: string,
    mensaje: string,
    identidad?: { nombre?: string; email?: string },
  ): Promise<ResultadoCommitSubtarea>;

  listarCambios(
    rutaWorktree: string,
    opciones?: OpcionesListarCambios,
  ): Promise<CambioArchivo[]>;

  volverACommit(rutaWorktree: string, commit: string): Promise<void>;

  eliminarWorktree(rutaWorktree: string): Promise<void>;

  listarWorktrees(directorioRepo: string): Promise<WorktreeListado[]>;

  detectarHuerfanos(
    directorioRepo: string,
    runIdsActivos: readonly string[],
  ): Promise<WorktreesHuerfanos>;
}

/**
 * Compara dos versiones semver en formato X.Y.Z (o X.Y).
 * Devuelve true si versionActual >= versionMinima.
 */
export function compararVersiones(
  versionActual: string,
  versionMinima: string,
): boolean {
  const parse = (v: string): number[] => {
    const match = v.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (!match) return [0, 0, 0];
    return [
      parseInt(match[1]!, 10),
      parseInt(match[2]!, 10),
      parseInt(match[3] ?? "0", 10),
    ];
  };

  const [aMaj, aMin, aPat] = parse(versionActual);
  const [mMaj, mMin, mPat] = parse(versionMinima);

  if (aMaj !== mMaj) return aMaj > mMaj;
  if (aMin !== mMin) return aMin > mMin;
  return aPat >= mPat;
}

/**
 * Comprueba si un buffer corresponde a un archivo binario
 * (heurística estándar de Git: presencia de byte nulo 0x00).
 */
export function esArchivoBinario(buffer: Buffer): boolean {
  const limite = Math.min(buffer.length, 8000);
  for (let i = 0; i < limite; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Parsea la salida de `git diff --numstat -z` cubriendo archivos modificados,
 * eliminados, binarios y renombrados (con formato NUL).
 */
export function parsearNumstatZ(salidaNumstat: string): Array<{
  ruta: string;
  rutaAnterior?: string;
  lineasAnadidas: number;
  lineasEliminadas: number;
  esBinario: boolean;
}> {
  const tokens = salidaNumstat.split("\0");
  const resultados: Array<{
    ruta: string;
    rutaAnterior?: string;
    lineasAnadidas: number;
    lineasEliminadas: number;
    esBinario: boolean;
  }> = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    const tabParts = token.split("\t");
    if (tabParts.length >= 3) {
      const esBinario = tabParts[0] === "-" && tabParts[1] === "-";
      const lineasAnadidas = esBinario ? 0 : parseInt(tabParts[0]!, 10) || 0;
      const lineasEliminadas = esBinario ? 0 : parseInt(tabParts[1]!, 10) || 0;
      const pathPart = tabParts[2]!;

      if (pathPart.length > 0) {
        // Archivo normal sin renombramiento
        resultados.push({
          ruta: pathPart.replace(/\\/g, "/"),
          lineasAnadidas,
          lineasEliminadas,
          esBinario,
        });
      } else {
        // Renombramiento con delimitador NUL
        const rutaAnterior = tokens[++i]?.replace(/\\/g, "/");
        const rutaNueva = tokens[++i]?.replace(/\\/g, "/");
        if (rutaNueva) {
          resultados.push({
            ruta: rutaNueva,
            rutaAnterior,
            lineasAnadidas,
            lineasEliminadas,
            esBinario,
          });
        }
      }
    }
  }

  return resultados;
}

/**
 * Extrae las líneas de texto añadidas por archivo a partir de un unified diff (`git diff -U0`).
 */
export function parsearLineasAnadidasDiff(salidaDiff: string): Map<string, string[]> {
  const mapa = new Map<string, string[]>();
  const lineas = salidaDiff.split(/\r?\n/);
  let archivoActual: string | null = null;

  for (const linea of lineas) {
    if (linea.startsWith("diff --git ")) {
      archivoActual = null;
    } else if (linea.startsWith("+++ b/")) {
      let ruta = linea.slice(6).trim();
      if (ruta.startsWith('"') && ruta.endsWith('"')) {
        ruta = ruta.slice(1, -1);
      }
      archivoActual = ruta.replace(/\\/g, "/");
      if (!mapa.has(archivoActual)) {
        mapa.set(archivoActual, []);
      }
    } else if (linea.startsWith("+++ /dev/null")) {
      archivoActual = null;
    } else if (archivoActual && linea.startsWith("+") && !linea.startsWith("+++")) {
      mapa.get(archivoActual)!.push(linea.slice(1));
    }
  }

  return mapa;
}

/**
 * Parsea los bloques de `git worktree list --porcelain`.
 */
export function parsearWorktreesPorcelain(salidaPorcelain: string): WorktreeListado[] {
  const lineas = salidaPorcelain.split(/\r?\n/);
  const worktrees: WorktreeListado[] = [];

  let rutaActual: string | null = null;
  let headActual: string | null = null;
  let ramaActual: string | null = null;
  let prunable = false;

  const consolidar = (): void => {
    if (rutaActual && headActual) {
      let ramaCorta: string | null = null;
      let esBatuta = false;
      let runId: string | null = null;

      if (ramaActual) {
        if (ramaActual.startsWith("refs/heads/")) {
          ramaCorta = ramaActual.slice("refs/heads/".length);
        } else {
          ramaCorta = ramaActual;
        }

        if (ramaCorta.startsWith("batuta/")) {
          esBatuta = true;
          runId = ramaCorta.slice("batuta/".length);
        }
      }

      const rutaNorm = resolve(rutaActual);
      const existeEnDisco = existsSync(rutaNorm);

      worktrees.push({
        ruta: rutaNorm,
        head: headActual,
        rama: ramaCorta,
        esBatuta,
        runId,
        prunable: prunable || !existeEnDisco,
      });
    }

    rutaActual = null;
    headActual = null;
    ramaActual = null;
    prunable = false;
  };

  for (const linea of lineas) {
    const trimmed = linea.trim();
    if (trimmed.length === 0) {
      consolidar();
      continue;
    }

    if (trimmed.startsWith("worktree ")) {
      if (rutaActual) {
        consolidar();
      }
      rutaActual = trimmed.slice("worktree ".length).trim();
    } else if (trimmed.startsWith("HEAD ")) {
      headActual = trimmed.slice("HEAD ".length).trim();
    } else if (trimmed.startsWith("branch ")) {
      ramaActual = trimmed.slice("branch ".length).trim();
    } else if (trimmed.startsWith("prunable")) {
      prunable = true;
    }
  }

  consolidar();
  return worktrees;
}

/**
 * Implementación real de `ModuloGit` sobre el ejecutable `git` usando `EjecutorComandos`.
 */
export class ModuloGitReal implements ModuloGit {
  constructor(
    private readonly ejecutor: EjecutorComandos = new EjecutorComandosReal(),
  ) {}

  private async ejecutarGit(
    args: readonly string[],
    cwd: string,
    entornoExtra?: Record<string, string>,
  ): Promise<ResultadoComando> {
    return this.ejecutor.ejecutarArgs("git", args, {
      cwd,
      entornoExtra,
    });
  }

  /**
   * Valida estrictamente que una ruta corresponda a un worktree creado por Batuta.
   * Rechaza si la ruta es el repositorio principal o si su rama no empieza con `batuta/`.
   */
  private async validarWorktreeBatuta(
    rutaWorktree: string,
  ): Promise<{ rama: string; dirPrincipal: string }> {
    const rutaNorm = resolve(rutaWorktree);
    if (!existsSync(rutaNorm)) {
      throw new Error(`El directorio del worktree no existe: "${rutaNorm}".`);
    }

    const resCommon = await this.ejecutarGit(["rev-parse", "--git-common-dir"], rutaNorm);
    const resGitDir = await this.ejecutarGit(["rev-parse", "--git-dir"], rutaNorm);
    if (resCommon.codigoSalida !== 0 || resGitDir.codigoSalida !== 0) {
      throw new Error(
        `Operación denegada: la ruta "${rutaNorm}" no es un repositorio o worktree de Git válido.`,
      );
    }

    const commonDirNorm = resolve(rutaNorm, resCommon.salidaEstandar.trim());
    const gitDirNorm = resolve(rutaNorm, resGitDir.salidaEstandar.trim());

    // En el repositorio principal, gitDir y commonDir apuntan al mismo directorio .git
    if (commonDirNorm === gitDirNorm) {
      throw new Error(
        `Operación denegada: la ruta "${rutaNorm}" es el repositorio principal, no un worktree de Batuta.`,
      );
    }

    // Obtener la rama del worktree
    const resRama = await this.ejecutarGit(["branch", "--show-current"], rutaNorm);
    const rama = resRama.salidaEstandar.trim();
    if (!rama.startsWith("batuta/")) {
      throw new Error(
        `Operación denegada: la ruta "${rutaNorm}" no pertenece a Batuta (la rama "${rama}" no es una rama de Batuta, debe empezar con "batuta/").`,
      );
    }

    // Raíz del repositorio principal
    const dirPrincipal = resolve(commonDirNorm, "..");
    return { rama, dirPrincipal };
  }

  async comprobacionesPrevias(
    directorio: string,
    refBase = "HEAD",
  ): Promise<InfoComprobacionesPrevias> {
    const dirNorm = resolve(directorio);

    // 1. Versión de Git
    const resVersion = await this.ejecutor.ejecutarArgs("git", ["--version"], {
      cwd: existsSync(dirNorm) ? dirNorm : undefined,
    });
    let versionGit: string | null = null;
    let versionSuficiente = false;
    if (resVersion.codigoSalida === 0) {
      const match = resVersion.salidaEstandar.match(
        /git version (\d+\.\d+(?:\.\d+)?)/i,
      );
      if (match) {
        versionGit = match[1]!;
        versionSuficiente = compararVersiones(versionGit, VERSION_MINIMA_GIT);
      }
    }

    // 2. Comprobar si es un repositorio Git
    const resRepo = await this.ejecutor.ejecutarArgs(
      "git",
      ["rev-parse", "--is-inside-work-tree"],
      { cwd: dirNorm },
    );
    const esRepo =
      resRepo.codigoSalida === 0 && resRepo.salidaEstandar.trim() === "true";

    if (!esRepo) {
      return {
        esRepo: false,
        ramaActual: null,
        arbolLimpio: false,
        referenciaExiste: false,
        versionGit,
        versionSuficiente,
        detalle: `El directorio "${dirNorm}" no es un repositorio Git válido.`,
      };
    }

    // 3. Rama actual
    const resRama = await this.ejecutarGit(["branch", "--show-current"], dirNorm);
    const ramaRaw = resRama.salidaEstandar.trim();
    const ramaActual = ramaRaw.length > 0 ? ramaRaw : null;

    // 4. Árbol de trabajo limpio
    const resStatus = await this.ejecutarGit(["status", "--porcelain=v1", "-z"], dirNorm);
    const arbolLimpio =
      resStatus.codigoSalida === 0 && resStatus.salidaEstandar.length === 0;

    // 5. Referencia base existente (si empieza por guión se rechaza como dato inválido)
    let referenciaExiste = false;
    if (!refBase.startsWith("-")) {
      const resRef = await this.ejecutarGit(
        ["rev-parse", "--verify", "--quiet", `${refBase}^{commit}`],
        dirNorm,
      );
      referenciaExiste =
        resRef.codigoSalida === 0 && resRef.salidaEstandar.trim().length > 0;
    }

    return {
      esRepo: true,
      ramaActual,
      arbolLimpio,
      referenciaExiste,
      versionGit,
      versionSuficiente,
    };
  }

  async crearWorktree(
    directorioRepo: string,
    runId: string,
    opciones?: OpcionesCrearWorktree,
  ): Promise<InfoWorktree> {
    if (!/^[a-zA-Z0-9_\-]+$/.test(runId)) {
      throw new Error(
        `Identificador de ejecución (run_id) no válido: "${runId}". Solo se permiten letras, números, guiones y guiones bajos.`,
      );
    }

    const repoAbs = resolve(directorioRepo);
    const previas = await this.comprobacionesPrevias(repoAbs);
    if (!previas.esRepo) {
      throw new Error(
        `El directorio "${repoAbs}" no es un repositorio Git válido.`,
      );
    }

    const refBase = opciones?.refBase ?? "HEAD";
    if (refBase.startsWith("-")) {
      throw new Error(
        `La referencia base "${refBase}" no es válida (no puede comenzar con guión).`,
      );
    }
    const resRef = await this.ejecutarGit(
      ["rev-parse", "--verify", `${refBase}^{commit}`],
      repoAbs,
    );
    if (resRef.codigoSalida !== 0) {
      throw new Error(
        `La referencia base "${refBase}" no existe en el repositorio "${repoAbs}".`,
      );
    }
    const commitBase = resRef.salidaEstandar.trim();
    const nombreRama = `batuta/${runId}`;

    // Validar si la rama ya existe
    const resRamaExiste = await this.ejecutarGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${nombreRama}`],
      repoAbs,
    );
    if (resRamaExiste.codigoSalida === 0) {
      throw new Error(
        `La rama "${nombreRama}" ya existe. No se puede crear un worktree duplicado para el run_id "${runId}".`,
      );
    }

    // Calcular la ruta del worktree
    let dirWorktree: string;
    if (opciones?.directorioWorktrees) {
      dirWorktree = isAbsolute(opciones.directorioWorktrees)
        ? resolve(opciones.directorioWorktrees, runId)
        : resolve(repoAbs, opciones.directorioWorktrees, runId);
    } else {
      const dirPadre = dirname(repoAbs);
      const nombreRepo = basename(repoAbs);
      dirWorktree = resolve(dirPadre, `${nombreRepo}-worktrees`, runId);
    }

    if (existsSync(dirWorktree)) {
      throw new Error(
        `El directorio de destino "${dirWorktree}" ya existe. No se puede crear un worktree duplicado para el run_id "${runId}".`,
      );
    }

    // Crear el worktree con Git
    const resAdd = await this.ejecutarGit(
      ["worktree", "add", "-b", nombreRama, "--", dirWorktree, commitBase],
      repoAbs,
    );
    if (resAdd.codigoSalida !== 0) {
      throw new Error(
        `Error al crear el worktree para "${runId}": ${resAdd.salidaError}`,
      );
    }

    return {
      ruta: dirWorktree,
      rama: nombreRama,
      commitBase,
    };
  }

  async confirmarSubtarea(
    rutaWorktree: string,
    mensaje: string,
    identidad?: { nombre?: string; email?: string },
  ): Promise<ResultadoCommitSubtarea> {
    const rutaNorm = resolve(rutaWorktree);
    await this.validarWorktreeBatuta(rutaNorm);

    // Preparar todos los cambios
    const resAdd = await this.ejecutarGit(["add", "-A"], rutaNorm);
    if (resAdd.codigoSalida !== 0) {
      throw new Error(
        `Error al preparar archivos para commit en "${rutaNorm}": ${resAdd.salidaError}`,
      );
    }

    // Comprobar si hay cambios staged
    const resDiff = await this.ejecutarGit(["diff", "--cached", "--quiet"], rutaNorm);
    if (resDiff.codigoSalida === 0) {
      return {
        creado: false,
        hash: null,
        mensaje: "No hay cambios para confirmar",
      };
    }

    const nombre = identidad?.nombre ?? IDENTIDAD_BATUTA_POR_DEFECTO.nombre;
    const email = identidad?.email ?? IDENTIDAD_BATUTA_POR_DEFECTO.email;

    // Crear el commit con identidad propia inyectada sin tocar git config del usuario
    const resCommit = await this.ejecutor.ejecutarArgs(
      "git",
      [
        "-c",
        `user.name=${nombre}`,
        "-c",
        `user.email=${email}`,
        "commit",
        "-m",
        mensaje,
      ],
      {
        cwd: rutaNorm,
        entornoExtra: {
          GIT_AUTHOR_NAME: nombre,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: nombre,
          GIT_COMMITTER_EMAIL: email,
        },
      },
    );

    if (resCommit.codigoSalida !== 0) {
      throw new Error(
        `Error al confirmar subtarea en "${rutaNorm}": ${resCommit.salidaError || resCommit.salidaEstandar}`,
      );
    }

    const resHead = await this.ejecutarGit(["rev-parse", "HEAD"], rutaNorm);
    const hash = resHead.salidaEstandar.trim();

    return {
      creado: true,
      hash,
      mensaje,
    };
  }

  async listarCambios(
    rutaWorktree: string,
    opciones?: OpcionesListarCambios,
  ): Promise<CambioArchivo[]> {
    const rutaNorm = resolve(rutaWorktree);
    const commitBase = opciones?.commitBase ?? "HEAD";

    // 1. Obtener numstat en formato NUL (-z) sin escapes de caracteres especiales
    const resNumstat = await this.ejecutarGit(
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "--numstat",
        "-z",
        "-M",
        "--end-of-options",
        commitBase,
      ],
      rutaNorm,
    );
    const cambiosTracked = parsearNumstatZ(resNumstat.salidaEstandar);

    // 2. Obtener líneas añadidas de texto con diff -U0
    const resDiffU0 = await this.ejecutarGit(
      [
        "-c",
        "core.quotepath=false",
        "diff",
        "-U0",
        "--no-color",
        "-M",
        "--end-of-options",
        commitBase,
      ],
      rutaNorm,
    );
    const lineasAnadidasMap = parsearLineasAnadidasDiff(resDiffU0.salidaEstandar);

    // Mapa para consolidar cambios por ruta relativa
    const cambiosMap = new Map<string, CambioArchivo>();

    for (const c of cambiosTracked) {
      const lineasTexto = c.esBinario ? [] : lineasAnadidasMap.get(c.ruta) ?? [];
      cambiosMap.set(c.ruta, {
        ruta: c.ruta,
        lineasAnadidas: c.lineasAnadidas,
        lineasEliminadas: c.lineasEliminadas,
        lineasAnadidasTexto: lineasTexto.length > 0 ? lineasTexto : undefined,
      });
    }

    // 3. Obtener archivos nuevos sin seguimiento (untracked)
    const resStatus = await this.ejecutarGit(
      ["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z", "-uall"],
      rutaNorm,
    );
    const tokensStatus = resStatus.salidaEstandar.split("\0");

    for (const token of tokensStatus) {
      if (!token) continue;
      if (token.startsWith("?? ")) {
        const rutaUntracked = token.slice(3).trim().replace(/\\/g, "/");
        const rutaAbs = resolve(rutaNorm, rutaUntracked);

        if (existsSync(rutaAbs)) {
          let buffer: Buffer;
          try {
            buffer = readFileSync(rutaAbs);
          } catch {
            continue;
          }

          if (esArchivoBinario(buffer)) {
            cambiosMap.set(rutaUntracked, {
              ruta: rutaUntracked,
              lineasAnadidas: 0,
              lineasEliminadas: 0,
              lineasAnadidasTexto: [],
            });
          } else {
            const texto = buffer.toString("utf8");
            const lineas = texto.length === 0 ? [] : texto.split(/\r?\n/);
            // Si el archivo termina en salto de línea, descartar el elemento vacío final
            if (lineas.length > 0 && lineas[lineas.length - 1] === "") {
              lineas.pop();
            }
            cambiosMap.set(rutaUntracked, {
              ruta: rutaUntracked,
              lineasAnadidas: lineas.length,
              lineasEliminadas: 0,
              lineasAnadidasTexto: lineas,
            });
          }
        }
      }
    }

    // Devolver lista ordenada por ruta para determinismo
    return Array.from(cambiosMap.values()).sort((a, b) =>
      a.ruta.localeCompare(b.ruta),
    );
  }

  async volverACommit(rutaWorktree: string, commit: string): Promise<void> {
    const rutaNorm = resolve(rutaWorktree);
    await this.validarWorktreeBatuta(rutaNorm);

    if (commit.startsWith("-")) {
      throw new Error(
        `El commit "${commit}" no es válido (no puede comenzar con guión).`,
      );
    }

    const resVerify = await this.ejecutarGit(
      ["rev-parse", "--verify", `${commit}^{commit}`],
      rutaNorm,
    );
    if (resVerify.codigoSalida !== 0) {
      throw new Error(
        `El commit "${commit}" no existe en el repositorio para restaurar.`,
      );
    }

    // Descartar cambios versionados
    const resReset = await this.ejecutarGit(
      ["reset", "--hard", "--end-of-options", commit],
      rutaNorm,
    );
    if (resReset.codigoSalida !== 0) {
      throw new Error(
        `Error al ejecutar reset --hard hacia "${commit}": ${resReset.salidaError}`,
      );
    }

    // Descartar archivos nuevos sin seguimiento conservando los ignorados (.gitignore)
    const resClean = await this.ejecutarGit(["clean", "-fd"], rutaNorm);
    if (resClean.codigoSalida !== 0) {
      throw new Error(
        `Error al limpiar archivos nuevos sin seguimiento: ${resClean.salidaError}`,
      );
    }
  }

  async eliminarWorktree(rutaWorktree: string): Promise<void> {
    const rutaNorm = resolve(rutaWorktree);

    // 1. Si no existe en disco, intentar prune y limpiar
    if (!existsSync(rutaNorm)) {
      return;
    }

    // 2. Validar que sea un worktree de Batuta (rechaza repo principal y ramas ajenas)
    const { rama, dirPrincipal } = await this.validarWorktreeBatuta(rutaNorm);

    // 3. Eliminar worktree con Git
    let resRemove = await this.ejecutarGit(
      ["worktree", "remove", "--force", "--", rutaNorm],
      dirPrincipal,
    );

    // En Windows archivos en uso pueden causar fallo transitorio: esperar y reintentar
    if (resRemove.codigoSalida !== 0) {
      await new Promise((r) => setTimeout(r, 250));
      resRemove = await this.ejecutarGit(
        ["worktree", "remove", "--force", "--", rutaNorm],
        dirPrincipal,
      );

      // Si aún persiste, recurrir a borrado en disco y prune
      if (resRemove.codigoSalida !== 0) {
        try {
          await rm(rutaNorm, { recursive: true, force: true });
        } catch {
          // Ignorar si ya se eliminó
        }
      }
    }

    // 4. Eliminar la rama batuta/<run_id>
    await this.ejecutarGit(["branch", "-D", "--", rama], dirPrincipal);

    // 5. Limpiar registros de worktrees
    await this.ejecutarGit(["worktree", "prune"], dirPrincipal);
  }

  async listarWorktrees(directorioRepo: string): Promise<WorktreeListado[]> {
    const repoAbs = resolve(directorioRepo);
    const resList = await this.ejecutarGit(
      ["worktree", "list", "--porcelain"],
      repoAbs,
    );
    if (resList.codigoSalida !== 0) {
      return [];
    }

    return parsearWorktreesPorcelain(resList.salidaEstandar);
  }

  async detectarHuerfanos(
    directorioRepo: string,
    runIdsActivos: readonly string[],
  ): Promise<WorktreesHuerfanos> {
    const repoAbs = resolve(directorioRepo);
    const todosWorktrees = await this.listarWorktrees(repoAbs);
    const activosSet = new Set(runIdsActivos);

    // Worktrees huérfanos: worktrees de Batuta que no están activos o son prunable
    const worktreesHuerfanos = todosWorktrees.filter((w) => {
      if (!w.esBatuta) return false;
      if (w.prunable) return true;
      if (w.runId && !activosSet.has(w.runId)) return true;
      return false;
    });

    // Ramas huérfanas: ramas batuta/* cuyo runId no está activo
    const resBranches = await this.ejecutarGit(
      ["branch", "--list", "batuta/*", "--format=%(refname:short)"],
      repoAbs,
    );
    const ramasLocales = resBranches.salidaEstandar
      .split(/\r?\n/)
      .map((r) => r.trim())
      .filter((r) => r.startsWith("batuta/"));

    const ramasHuerfanas = ramasLocales.filter((rama) => {
      const runId = rama.slice("batuta/".length);
      return !activosSet.has(runId);
    });

    return {
      worktreesHuerfanos,
      ramasHuerfanas,
    };
  }
}
