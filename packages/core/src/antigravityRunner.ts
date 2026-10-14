import { mkdir, writeFile, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  AgentInput,
  AgentOutput,
  AgentOutputJsonSchema,
  AgentOutputSchema,
} from "./agentContract.js";
import {
  AgentCallContext,
  AgentRunner,
  AgentRunResult,
  calcularCostoEstimado,
  CostoEstimado,
  MotivoFalloAgente,
  UsoAgente,
} from "./agentRunner.js";
import {
  EjecutorComandos,
  EjecutorComandosReal,
  ResultadoComando,
} from "./commandRunner.js";
import { CuotaManager, EvaluacionCuota } from "./cuotaManager.js";
import { ofuscarSecretos } from "./diffPolicy.js";
import { formatZodError } from "./validation.js";

/** Variables de entorno adicionales permitidas exclusivamente para agy. */
export const VARIABLES_ENTORNO_AGY: readonly string[] = [
  "USERPROFILE",
  "UserProfile",
  "userprofile",
  "APPDATA",
  "AppData",
  "appdata",
  "LOCALAPPDATA",
  "LocalAppData",
  "localappdata",
  "HOME",
  "home",
];

/** Configuración inyectable para AntigravityRunner. */
export interface AntigravityRunnerConfig {
  binPath?: string;
  timeoutMs?: number;
  umbralCuota?: number;
  validarRutaWorktree?: boolean;
}

/** Dependencias inyectables para pruebas y personalización. */
export interface AntigravityRunnerDeps {
  ejecutor?: EjecutorComandos;
  cuotaManager?: CuotaManager;
}

/**
 * Normaliza una ruta a formato POSIX para comparaciones seguras.
 */
function normalizarRutaPosix(ruta: string): string {
  let normal = ruta.replace(/\\/g, "/");
  while (normal.startsWith("./")) {
    normal = normal.slice(2);
  }
  return normal;
}

/**
 * Comprueba si un directorio de trabajo es un worktree válido de Batuta.
 * Rechaza directorios que no estén dentro de .batuta/worktrees/ o que apunten a la raíz.
 */
export function esWorktreeValido(directorioTrabajo: string): boolean {
  const norm = normalizarRutaPosix(resolve(directorioTrabajo));
  return norm.includes("/.batuta/worktrees/") || norm.endsWith("/.batuta/worktrees");
}

/**
 * Runner de agentes que ejecuta cada paso invocando el binario oficial `agy`
 * en modo headless con --sandbox y --output-format json (ADR 021).
 */
export class AntigravityRunner implements AgentRunner {
  private binPath: string;
  private timeoutMs: number;
  private umbralCuota: number;
  private validarWorktree: boolean;
  private ejecutor: EjecutorComandos;
  private cuotaManager: CuotaManager;

  constructor(
    config?: AntigravityRunnerConfig,
    deps?: AntigravityRunnerDeps,
  ) {
    this.binPath = config?.binPath ?? "agy";
    this.timeoutMs = config?.timeoutMs ?? 300_000;
    this.umbralCuota = config?.umbralCuota ?? 0.05;
    this.validarWorktree = config?.validarRutaWorktree ?? true;
    this.ejecutor = deps?.ejecutor ?? new EjecutorComandosReal();
    this.cuotaManager =
      deps?.cuotaManager ??
      new CuotaManager({
        ejecutor: this.ejecutor,
        binPath: this.binPath,
      });
  }

  /**
   * Ejecuta una tarea de agente usando `agy` en modo headless.
   */
  async ejecutar(
    input: AgentInput,
    contexto: AgentCallContext,
  ): Promise<AgentRunResult> {
    const inicio = Date.now();
    const rutaLog = this.obtenerRutaLog(contexto, input.task_id);

    // 1. Validar que el cwd esté confinado dentro de un worktree de Batuta
    if (this.validarWorktree && !esWorktreeValido(contexto.directorioTrabajo)) {
      const errorMsg = `Seguridad: El directorio de trabajo "${contexto.directorioTrabajo}" no está dentro de .batuta/worktrees/`;
      await this.guardarLog(rutaLog, `[RECHAZO CWD] ${errorMsg}`);
      return {
        exito: false,
        output: null,
        motivoFallo: "error_proceso",
        uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
        costoEstimado: { montoUsd: null, desconocido: true },
        modeloEfectivo: contexto.modelo,
        duracionMs: Date.now() - inicio,
        rutaLog,
        reintentos: 0,
      };
    }

    // 2. Control proactivo de cuota
    let evaluacionProactiva: EvaluacionCuota;
    try {
      evaluacionProactiva = await this.cuotaManager.verificarCuotaModelo(
        contexto.modelo,
        this.umbralCuota,
      );
    } catch (error) {
      // Si la consulta de cuota falla, es un error real del sistema
      const errTexto = error instanceof Error ? error.message : String(error);
      await this.guardarLog(rutaLog, `[ERROR CUOTA PROACTIVA] ${errTexto}`);
      return {
        exito: false,
        output: null,
        motivoFallo: "error_proceso",
        uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
        costoEstimado: { montoUsd: null, desconocido: true },
        modeloEfectivo: contexto.modelo,
        duracionMs: Date.now() - inicio,
        rutaLog,
        reintentos: 0,
      };
    }

    if (!evaluacionProactiva.suficiente) {
      const bucketsStr = evaluacionProactiva.bucketsBajoUmbral
        .map((b) => `${b.id} (${(b.remaining_fraction * 100).toFixed(2)}%)`)
        .join(", ");
      await this.guardarLog(
        rutaLog,
        `[CUOTA AGOTADA PROACTIVA] Modelo ${contexto.modelo} sin cuota suficiente. Buckets bajo umbral: ${bucketsStr}. Reset: ${evaluacionProactiva.resetTimeMasTardio ?? "desconocido"}`,
      );
      return {
        exito: false,
        output: null,
        motivoFallo: "cuota_agotada",
        uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
        costoEstimado: { montoUsd: null, desconocido: true },
        modeloEfectivo: contexto.modelo,
        duracionMs: Date.now() - inicio,
        rutaLog,
        reintentos: 0,
        resetTime: evaluacionProactiva.resetTimeMasTardio,
        bucketsBajoUmbral: evaluacionProactiva.bucketsBajoUmbral.map((b) => b.id),
      };
    }

    // 3. Escribir el esquema JSON a un archivo temporal para evitar problemas de escape en Windows
    const idSchema = randomUUID();
    const rutaSchema = join(tmpdir(), `batuta-schema-${idSchema}.json`);
    await writeFile(rutaSchema, JSON.stringify(AgentOutputJsonSchema), "utf8");

    let reintentos = 0;
    try {
      // Función interna de ejecución de intento
      const ejecutarIntento = async (promptTexto: string): Promise<ResultadoComando> => {
        const timeoutEfectivo = contexto.limites?.timeoutMs ?? this.timeoutMs;
        const args: string[] = [
          "-p",
          promptTexto,
          "--model",
          contexto.modelo,
          "--output-format",
          "json",
          "--json-schema",
          rutaSchema,
          "--sandbox",
        ];

        // Construir entorno con variables limpias + variables OAuth de agy
        const entornoExtra: Record<string, string> = {};
        for (const clave of VARIABLES_ENTORNO_AGY) {
          if (process.env[clave] !== undefined) {
            entornoExtra[clave] = process.env[clave]!;
          }
        }

        // Si el contexto suministró variables extra (fixtures), inyectarlas
        if (contexto.entorno) {
          Object.assign(entornoExtra, contexto.entorno);
        }

        return this.ejecutor.ejecutarArgs(this.binPath, args, {
          cwd: contexto.directorioTrabajo,
          timeoutMs: timeoutEfectivo,
          entornoExtra,
        });
      };

      // Primer intento
      let resultadoCmd = await ejecutarIntento(contexto.prompt);

      // Comprobar si el timeout venció
      if (resultadoCmd.timeoutVencido) {
        await this.guardarLog(
          rutaLog,
          `[TIMEOUT] Comando vencido tras ${Date.now() - inicio} ms.\nStderr: ${resultadoCmd.salidaError}`,
        );
        return {
          exito: false,
          output: null,
          motivoFallo: "timeout",
          uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
          costoEstimado: { montoUsd: null, desconocido: true },
          modeloEfectivo: contexto.modelo,
          duracionMs: Date.now() - inicio,
          rutaLog,
          reintentos,
        };
      }

      // Si el código de salida fue no-cero, evaluar cuota reactiva
      if (resultadoCmd.codigoSalida !== 0) {
        let evaluacionReactiva: EvaluacionCuota | null = null;
        try {
          // Consultar cuota fresca
          evaluacionReactiva = await this.cuotaManager.verificarCuotaModelo(
            contexto.modelo,
            this.umbralCuota,
            true,
          );
        } catch {
          // Si /usage también falla, tratamos el fallo como error_proceso
          evaluacionReactiva = null;
        }

        if (evaluacionReactiva && !evaluacionReactiva.suficiente) {
          await this.guardarLog(
            rutaLog,
            `[CUOTA AGOTADA REACTIVA] Salida no-cero (${resultadoCmd.codigoSalida}) confirmada por /usage. Reset: ${evaluacionReactiva.resetTimeMasTardio ?? "desconocido"}\nStderr: ${resultadoCmd.salidaError}`,
          );
          return {
            exito: false,
            output: null,
            motivoFallo: "cuota_agotada",
            uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
            costoEstimado: { montoUsd: null, desconocido: true },
            modeloEfectivo: contexto.modelo,
            duracionMs: Date.now() - inicio,
            rutaLog,
            reintentos,
            resetTime: evaluacionReactiva.resetTimeMasTardio,
            bucketsBajoUmbral: evaluacionReactiva.bucketsBajoUmbral.map((b) => b.id),
          };
        }

        // Si no fue cuota, es un error del proceso
        await this.guardarLog(
          rutaLog,
          `[ERROR PROCESO] Código de salida ${resultadoCmd.codigoSalida}.\nStderr: ${resultadoCmd.salidaError}\nStdout: ${resultadoCmd.salidaEstandar}`,
        );
        return {
          exito: false,
          output: null,
          motivoFallo: "error_proceso",
          uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
          costoEstimado: { montoUsd: null, desconocido: true },
          modeloEfectivo: contexto.modelo,
          duracionMs: Date.now() - inicio,
          rutaLog,
          reintentos,
        };
      }

      // Parsear e interpretar salida JSON
      let interpretacion = this.interpretarSalidaAgy(resultadoCmd.salidaEstandar);

      // Si falló por salida inválida, reintentar una sola vez con retroalimentación Zod
      if (interpretacion.motivoFallo === "salida_invalida" && interpretacion.errorValidacion) {
        reintentos = 1;
        const promptReintento = `${contexto.prompt}\n\n[REINTENTO POR SALIDA INVÁLIDA]\nLa salida devuelta no cumplió con el esquema requerido:\n${interpretacion.errorValidacion}\nPor favor, responde estrictamente con el JSON de AgentOutput válido.`;

        resultadoCmd = await ejecutarIntento(promptReintento);

        if (resultadoCmd.timeoutVencido) {
          await this.guardarLog(
            rutaLog,
            `[TIMEOUT EN REINTENTO] Vencido tras ${Date.now() - inicio} ms.\nStderr: ${resultadoCmd.salidaError}`,
          );
          return {
            exito: false,
            output: null,
            motivoFallo: "timeout",
            uso: interpretacion.uso,
            costoEstimado: this.calcularCosto(interpretacion.uso, contexto),
            modeloEfectivo: contexto.modelo,
            duracionMs: Date.now() - inicio,
            rutaLog,
            reintentos,
          };
        }

        if (resultadoCmd.codigoSalida === 0) {
          interpretacion = this.interpretarSalidaAgy(resultadoCmd.salidaEstandar);
        } else {
          interpretacion = {
            exito: false,
            agentOutput: null,
            motivoFallo: "error_proceso",
            uso: interpretacion.uso,
          };
        }
      }

      // Control del límite de pasos (turnos) si se definieron
      const maxSteps = contexto.limites?.maxSteps;
      if (maxSteps && (interpretacion.uso.turnos ?? 0) > maxSteps) {
        interpretacion.exito = false;
        interpretacion.agentOutput = null;
        interpretacion.motivoFallo = "turnos_agotados";
      }

      const costoEstimado = this.calcularCosto(interpretacion.uso, contexto);

      // Guardar log ofuscando secretos
      const logCompleto = [
        `=== LOG DE EJECUCIÓN ANTIGRAVITY RUNNER ===`,
        `Tarea: ${input.task_id}`,
        `Rol: ${contexto.rol}`,
        `Modelo: ${contexto.modelo}`,
        `Directorio: ${contexto.directorioTrabajo}`,
        `Reintentos: ${reintentos}`,
        `Duración: ${Date.now() - inicio} ms`,
        `Tokens entrada: ${interpretacion.uso.tokensEntrada}`,
        `Tokens salida: ${interpretacion.uso.tokensSalida}`,
        `Turnos: ${interpretacion.uso.turnos ?? 0}`,
        `Resultado Exitoso: ${interpretacion.exito}`,
        `Motivo Fallo: ${interpretacion.motivoFallo ?? "ninguno"}`,
        `--- STDOUT ---`,
        resultadoCmd.salidaEstandar,
        `--- STDERR ---`,
        resultadoCmd.salidaError,
      ].join("\n");

      await this.guardarLog(rutaLog, logCompleto);

      return {
        exito: interpretacion.exito,
        output: interpretacion.agentOutput,
        motivoFallo: interpretacion.motivoFallo,
        uso: interpretacion.uso,
        costoEstimado,
        modeloEfectivo: contexto.modelo,
        duracionMs: Date.now() - inicio,
        rutaLog,
        reintentos,
      };
    } finally {
      // Limpieza garantizada del archivo temporal de esquema
      try {
        await unlink(rutaSchema);
      } catch {
        // Ignorar si ya no existe
      }
    }
  }

  /**
   * Interpreta la salida JSON de `agy`.
   * Regla de oro (ADR 011 / ADR 002): Ignora el `status` de nivel superior de agy
   * y valida exclusivamente `structured_output` con Zod.
   */
  private interpretarSalidaAgy(salidaEstandar: string): {
    exito: boolean;
    agentOutput: AgentOutput | null;
    motivoFallo: MotivoFalloAgente | null;
    uso: UsoAgente;
    errorValidacion?: string;
  } {
    let rawJson: Record<string, unknown>;
    try {
      rawJson = JSON.parse(salidaEstandar.trim()) as Record<string, unknown>;
    } catch {
      return {
        exito: false,
        agentOutput: null,
        motivoFallo: "salida_invalida",
        uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
        errorValidacion: "La salida no es un JSON válido",
      };
    }

    // Extraer uso de tokens
    const usageObj = (rawJson.usage ?? {}) as Record<string, unknown>;
    const tokensEntrada =
      typeof usageObj.input_tokens === "number" ? usageObj.input_tokens : 0;
    const tokensSalida =
      typeof usageObj.output_tokens === "number" ? usageObj.output_tokens : 0;
    const turnos =
      typeof rawJson.num_turns === "number" ? rawJson.num_turns : 1;
    const uso: UsoAgente = { tokensEntrada, tokensSalida, turnos };

    // Validar exclusivamente structured_output
    const structuredOutput = rawJson.structured_output;
    if (!structuredOutput || typeof structuredOutput !== "object") {
      return {
        exito: false,
        agentOutput: null,
        motivoFallo: "salida_invalida",
        uso,
        errorValidacion: "El campo structured_output está ausente o no es un objeto",
      };
    }

    const validacion = AgentOutputSchema.safeParse(structuredOutput);
    if (!validacion.success) {
      return {
        exito: false,
        agentOutput: null,
        motivoFallo: "salida_invalida",
        uso,
        errorValidacion: formatZodError(validacion.error),
      };
    }

    return {
      exito: true,
      agentOutput: validacion.data,
      motivoFallo: null,
      uso,
    };
  }

  private calcularCosto(
    uso: UsoAgente,
    _contexto: AgentCallContext,
  ): CostoEstimado {
    return calcularCostoEstimado(
      { entrada: uso.tokensEntrada, salida: uso.tokensSalida },
      undefined,
    );
  }

  private obtenerRutaLog(contexto: AgentCallContext, taskId: string): string {
    const dirBase =
      contexto.directorioLogs ??
      join(contexto.directorioTrabajo, ".batuta", "logs");
    return join(dirBase, `agente-${contexto.rol}-${taskId}-${Date.now()}.log`);
  }

  private async guardarLog(rutaArchivo: string, contenido: string): Promise<void> {
    try {
      await mkdir(dirname(rutaArchivo), { recursive: true });
      await writeFile(rutaArchivo, ofuscarSecretos(contenido), "utf8");
    } catch {
      // Si falla la escritura del log, no interrumpir la ejecución principal
    }
  }
}
