import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentInput,
  AgentOutput,
  AgentOutputJsonSchema,
  AgentOutputSchema,
  AgentRole,
} from "./agentContract.js";
import {
  construirEntornoLimpio,
  EjecutorComandos,
  EjecutorComandosReal,
} from "./commandRunner.js";
import { BatutaConfig } from "./config.js";
import { ofuscarSecretos } from "./diffPolicy.js";
import { formatZodError } from "./validation.js";

/** Motivos de fallo tipados para la ejecución de un agente. */
export type MotivoFalloAgente =
  | "timeout"
  | "presupuesto_agotado"
  | "turnos_agotados"
  | "salida_invalida"
  | "error_herramienta"
  | "error_proceso";

/** Límites de ejecución específicos para la llamada del agente. */
export interface LimitesLlamada {
  budgetLimitUsd?: number;
  maxSteps?: number;
  timeoutMs?: number;
}

/** Permisos por rol traducidos a la herramienta. */
export interface PermisosRol {
  soloLectura: boolean;
  comandosPermitidos?: readonly string[];
  archivosPermitidos?: readonly string[];
}

/** Métricas de uso de tokens y turnos. */
export interface UsoAgente {
  tokensEntrada: number;
  tokensSalida: number;
  turnos?: number;
}

/** Estimación de costo calculada con la tabla de precios. */
export interface CostoEstimado {
  montoUsd: number | null;
  desconocido: boolean;
}

/** Contexto completo entregado al runner en cada invocación. */
export interface AgentCallContext {
  directorioTrabajo: string;
  rol: AgentRole;
  modelo: string;
  aliasModelo?: string;
  limites?: LimitesLlamada;
  permisos: PermisosRol;
  entorno?: Record<string, string>;
  prompt: string;
  promptSistema?: string;
  runId?: string;
  directorioLogs?: string;
}

/** Resultado estructurado devuelto por un AgentRunner. */
export interface AgentRunResult {
  exito: boolean;
  output: AgentOutput | null;
  motivoFallo: MotivoFalloAgente | null;
  uso: UsoAgente;
  costoEstimado: CostoEstimado;
  modeloEfectivo: string;
  duracionMs: number;
  rutaLog: string;
  reintentos: number;
}

/** Interfaz inyectable común a todo runner de agentes. */
export interface AgentRunner {
  ejecutar(
    input: AgentInput,
    contexto: AgentCallContext,
  ): Promise<AgentRunResult>;
}

/**
 * Calcula el costo estimado en dólares a partir de tokens y precios por millón.
 * Si no hay precios configurados para el alias, marca el costo como desconocido.
 */
export function calcularCostoEstimado(
  tokens: { entrada: number; salida: number },
  precios?: { entrada?: number; salida?: number },
): CostoEstimado {
  if (
    precios?.entrada === undefined ||
    precios?.salida === undefined ||
    typeof precios.entrada !== "number" ||
    typeof precios.salida !== "number"
  ) {
    return {
      montoUsd: null,
      desconocido: true,
    };
  }

  const costo =
    (tokens.entrada * precios.entrada) / 1_000_000 +
    (tokens.salida * precios.salida) / 1_000_000;

  return {
    montoUsd: Math.round(costo * 1_000_000) / 1_000_000,
    desconocido: false,
  };
}

/**
 * Carga la plantilla de prompt para un rol sustituyendo sus variables.
 */
export async function cargarPlantillaPrompt(
  rol: AgentRole,
  variables: Record<string, string>,
  directorioPrompts?: string,
): Promise<string> {
  const dir =
    directorioPrompts ??
    resolve(fileURLToPath(import.meta.url), "../../prompts");
  const rutaArchivo = join(dir, `${rol}.md`);
  let contenido = await readFile(rutaArchivo, "utf8");

  for (const [clave, valor] of Object.entries(variables)) {
    contenido = contenido.replaceAll(`{{${clave}}}`, valor);
  }

  return contenido;
}

/** Parámetros para la construcción pura de invocación de Claude Code. */
export interface InvocacionClaudeCodeParams {
  modelo: string;
  prompt: string;
  permisos: PermisosRol;
  limites?: LimitesLlamada;
  esquemaJson?: unknown;
  promptSistema?: string;
}

/**
 * Función pura: construye la lista de argumentos para invocar Claude Code en modo headless.
 */
export function construirInvocacionClaudeCode(
  params: InvocacionClaudeCodeParams,
): { ejecutable: string; args: string[] } {
  const args: string[] = [
    "--print",
    "--verbose",
    "--output-format",
    "stream-json",
    "--bare",
    "--no-session-persistence",
    "--model",
    params.modelo,
  ];

  if (params.limites?.budgetLimitUsd !== undefined) {
    args.push("--max-budget-usd", String(params.limites.budgetLimitUsd));
  }

  if (params.permisos.soloLectura) {
    // Rol de solo lectura: herramientas de inspección, sin edición ni comandos
    args.push("--tools", "Read,Grep,Glob");
  } else {
    // Rol con escritura: definir explícitamente herramientas disponibles con --tools
    args.push("--tools", "Bash,Edit,Write,Read,Grep,Glob");

    // Si hay comandos permitidos, además restringir con --allowed-tools
    if (
      params.permisos.comandosPermitidos &&
      params.permisos.comandosPermitidos.length > 0
    ) {
      const comandosBash = params.permisos.comandosPermitidos
        .map((cmd) => `Bash(${cmd})`)
        .join(" ");
      args.push(
        "--allowed-tools",
        `Read Grep Glob Edit Write ${comandosBash}`,
      );
    }
  }

  if (params.promptSistema !== undefined && params.promptSistema.trim().length > 0) {
    args.push("--append-system-prompt", params.promptSistema);
  }

  if (params.esquemaJson !== undefined) {
    const schemaStr =
      typeof params.esquemaJson === "string"
        ? params.esquemaJson
        : JSON.stringify(params.esquemaJson);
    args.push("--json-schema", schemaStr);
  }

  args.push(params.prompt);

  return { ejecutable: "claude", args };
}

/**
 * Parsea e interpreta la salida cruda devuelta por la CLI de Claude Code.
 */
export function parsearSalidaClaudeCode(salidaTexto: string): {
  exito: boolean;
  agentOutput: AgentOutput | null;
  motivoFallo: MotivoFalloAgente | null;
  uso: UsoAgente;
  errorValidacion?: string;
  rawJson?: Record<string, unknown>;
} {
  // Extraer el objeto JSON (buscando el bloque JSON que contenga type: "result" o la última línea JSON)
  let rawJson: Record<string, unknown> | null = null;
  const lineas = salidaTexto.trim().split(/\r?\n/);

  for (let i = lineas.length - 1; i >= 0; i--) {
    const linea = lineas[i]!.trim();
    if (linea.startsWith("{") && linea.endsWith("}")) {
      try {
        const obj = JSON.parse(linea) as Record<string, unknown>;
        if (obj && typeof obj === "object") {
          if (obj.type === "result" || obj.result !== undefined) {
            rawJson = obj;
            break;
          }
          if (!rawJson) {
            rawJson = obj;
          }
        }
      } catch {
        // Continuar buscando
      }
    }
  }

  if (!rawJson) {
    // Si no se encontró por línea, intentar parsear todo el texto
    try {
      rawJson = JSON.parse(salidaTexto.trim()) as Record<string, unknown>;
    } catch {
      return {
        exito: false,
        agentOutput: null,
        motivoFallo: "salida_invalida",
        uso: { tokensEntrada: 0, tokensSalida: 0, turnos: 0 },
        errorValidacion: "La salida no contiene un JSON válido",
      };
    }
  }

  // Extraer uso
  const usageObj = (rawJson.usage ?? {}) as Record<string, unknown>;
  const tokensEntrada =
    typeof usageObj.input_tokens === "number" ? usageObj.input_tokens : 0;
  const tokensSalida =
    typeof usageObj.output_tokens === "number" ? usageObj.output_tokens : 0;
  const turnos =
    typeof rawJson.num_turns === "number" ? rawJson.num_turns : 0;
  const uso: UsoAgente = { tokensEntrada, tokensSalida, turnos };

  // Detección de motivos de fallo de la herramienta
  const isError = rawJson.is_error === true;
  const terminalReason = String(
    rawJson.terminal_reason ?? rawJson.stop_reason ?? "",
  );

  if (terminalReason === "max_turns" || terminalReason.includes("turn")) {
    return {
      exito: false,
      agentOutput: null,
      motivoFallo: "turnos_agotados",
      uso,
      rawJson,
    };
  }

  if (
    terminalReason === "budget_exceeded" ||
    terminalReason.includes("budget")
  ) {
    return {
      exito: false,
      agentOutput: null,
      motivoFallo: "presupuesto_agotado",
      uso,
      rawJson,
    };
  }

  if (isError && terminalReason === "api_error") {
    return {
      exito: false,
      agentOutput: null,
      motivoFallo: "error_herramienta",
      uso,
      rawJson,
    };
  }

  // Extraer el campo `result`
  const resultRaw = rawJson.result;
  let valorAValidar = resultRaw;

  if (typeof resultRaw === "string") {
    try {
      valorAValidar = JSON.parse(resultRaw);
    } catch {
      return {
        exito: false,
        agentOutput: null,
        motivoFallo: "salida_invalida",
        uso,
        errorValidacion: "El campo result no es un JSON parseable",
        rawJson,
      };
    }
  }

  // Validar con Zod
  const parseResult = AgentOutputSchema.safeParse(valorAValidar);
  if (!parseResult.success) {
    return {
      exito: false,
      agentOutput: null,
      motivoFallo: "salida_invalida",
      uso,
      errorValidacion: formatZodError(parseResult.error),
      rawJson,
    };
  }

  return {
    exito: true,
    agentOutput: parseResult.data,
    motivoFallo: null,
    uso,
    rawJson,
  };
}

/**
 * Runner simulado y guionable para pruebas deterministas y sin consumo de cuota.
 */
export class FakeRunner implements AgentRunner {
  public readonly llamadasRecibidas: Array<{
    input: AgentInput;
    contexto: AgentCallContext;
  }> = [];

  private colaRespuestas: AgentRunResult[] = [];
  private respuestasPorRol = new Map<AgentRole, AgentRunResult>();
  private respuestaPorDefecto: AgentRunResult | null = null;

  guionarSiguienteLlamada(respuesta: Partial<AgentRunResult>): void {
    this.colaRespuestas.push(this.completarResultado(respuesta));
  }

  guionarRol(rol: AgentRole, respuesta: Partial<AgentRunResult>): void {
    this.respuestasPorRol.set(rol, this.completarResultado(respuesta));
  }

  establecerRespuestaPorDefecto(respuesta: Partial<AgentRunResult>): void {
    this.respuestaPorDefecto = this.completarResultado(respuesta);
  }

  simularExito(
    output?: Partial<AgentOutput>,
    extras?: Partial<AgentRunResult>,
  ): AgentRunResult {
    const agentOutput: AgentOutput = {
      status: output?.status ?? "SUCCESS",
      summary: output?.summary ?? "Tarea completada exitosamente",
      files_modified: output?.files_modified ?? [],
      reported_checks: output?.reported_checks ?? [],
      continuation_notes: output?.continuation_notes ?? "",
      blocking_question: output?.blocking_question ?? "",
    };
    return this.completarResultado({
      exito: true,
      output: agentOutput,
      motivoFallo: null,
      ...extras,
    });
  }

  simularFallo(
    motivo: MotivoFalloAgente,
    extras?: Partial<AgentRunResult>,
  ): AgentRunResult {
    return this.completarResultado({
      exito: false,
      output: null,
      motivoFallo: motivo,
      ...extras,
    });
  }

  private completarResultado(res: Partial<AgentRunResult>): AgentRunResult {
    return {
      exito: res.exito ?? (res.output !== null && res.output !== undefined),
      output: res.output ?? null,
      motivoFallo: res.motivoFallo ?? null,
      uso: res.uso ?? { tokensEntrada: 100, tokensSalida: 50, turnos: 1 },
      costoEstimado: res.costoEstimado ?? {
        montoUsd: 0.001,
        desconocido: false,
      },
      modeloEfectivo: res.modeloEfectivo ?? "fake-model-1.0",
      duracionMs: res.duracionMs ?? 150,
      rutaLog: res.rutaLog ?? ".batuta/runs/fake/logs/fake.log",
      reintentos: res.reintentos ?? 0,
    };
  }

  async ejecutar(
    input: AgentInput,
    contexto: AgentCallContext,
  ): Promise<AgentRunResult> {
    this.llamadasRecibidas.push({ input, contexto });

    if (this.colaRespuestas.length > 0) {
      return this.colaRespuestas.shift()!;
    }

    const porRol = this.respuestasPorRol.get(input.agent_role);
    if (porRol) {
      return porRol;
    }

    if (this.respuestaPorDefecto) {
      return this.respuestaPorDefecto;
    }

    return this.simularExito();
  }
}

/**
 * Runner real para la CLI de Claude Code.
 */
export class ClaudeCodeRunner implements AgentRunner {
  constructor(
    private readonly ejecutor: EjecutorComandos = new EjecutorComandosReal(),
    private readonly config?: BatutaConfig,
  ) {}

  async ejecutar(
    input: AgentInput,
    contexto: AgentCallContext,
  ): Promise<AgentRunResult> {
    const inicio = Date.now();
    const maxSteps = input.max_steps;
    const timeoutMs =
      contexto.limites?.timeoutMs ??
      (this.config?.limites?.timeout_comando_seg ?? 120) * 1000;

    const dirLogs =
      contexto.directorioLogs ??
      join(contexto.directorioTrabajo, ".batuta", "runs", contexto.runId ?? "default", "logs");
    await mkdir(dirLogs, { recursive: true });
    const rutaLog = join(
      dirLogs,
      `${input.task_id}-${contexto.rol}-${Date.now()}.log`,
    );

    // Entorno limpio con variables de modelo permitidas
    const variablesModelo = this.config?.variables_modelo ?? ["ANTHROPIC_API_KEY"];
    const envExtra = construirEntornoLimpio(
      process.env,
      contexto.entorno ?? {},
      variablesModelo,
    );

    let reintentos = 0;
    const promptActual = contexto.prompt;
    let turnosStreaming = 0;
    let tokensEntradaStreaming = 0;
    let tokensSalidaStreaming = 0;

    const ejecutarIntento = async (promptParaIntento: string) => {
      turnosStreaming = 0;
      const { ejecutable, args } = construirInvocacionClaudeCode({
        modelo: contexto.modelo,
        prompt: promptParaIntento,
        permisos: contexto.permisos,
        limites: {
          budgetLimitUsd: input.budget_limit_usd,
          maxSteps,
        },
        esquemaJson: AgentOutputJsonSchema,
        promptSistema: contexto.promptSistema,
      });

      return this.ejecutor.ejecutarArgs(ejecutable, args, {
        cwd: contexto.directorioTrabajo,
        timeoutMs,
        entornoExtra: envExtra as Record<string, string>,
        onStdoutLine: (linea, abortar) => {
          try {
            const obj = JSON.parse(linea) as Record<string, unknown>;
            if (!obj || typeof obj !== "object") return;

            // Cada evento del asistente cuenta como un turno/paso activo del agente
            if (
              obj.type === "assistant" ||
              (obj.message as Record<string, unknown> | undefined)?.role === "assistant"
            ) {
              turnosStreaming++;
              if (turnosStreaming > maxSteps) {
                abortar("turnos_agotados");
              }
            }

            if (obj.usage && typeof obj.usage === "object") {
              const u = obj.usage as Record<string, unknown>;
              if (typeof u.input_tokens === "number") tokensEntradaStreaming = u.input_tokens;
              if (typeof u.output_tokens === "number") tokensSalidaStreaming = u.output_tokens;
            }
          } catch {
            // Ignorar líneas no JSON o avisos del CLI
          }
        },
      });
    };

    // 1. Primer intento
    let resultadoCmd = await ejecutarIntento(promptActual);

    // Comprobar si se canceló por turnos agotados en streaming
    if (resultadoCmd.canceladoPor === "turnos_agotados") {
      await this.guardarLog(
        rutaLog,
        `[TURNOS AGOTADOS] Límite de turnos (${maxSteps}) superado mientras el agente corría. Proceso terminado.\nStdout: ${resultadoCmd.salidaEstandar}`,
      );
      return {
        exito: false,
        output: null,
        motivoFallo: "turnos_agotados",
        uso: {
          tokensEntrada: tokensEntradaStreaming,
          tokensSalida: tokensSalidaStreaming,
          turnos: turnosStreaming,
        },
        costoEstimado: this.calcularCosto(
          {
            tokensEntrada: tokensEntradaStreaming,
            tokensSalida: tokensSalidaStreaming,
            turnos: turnosStreaming,
          },
          contexto,
        ),
        modeloEfectivo: contexto.modelo,
        duracionMs: Date.now() - inicio,
        rutaLog,
        reintentos,
      };
    }

    // Comprobar si se superó el timeout de Batuta
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

    let interpretacion = parsearSalidaClaudeCode(resultadoCmd.salidaEstandar);

    // 2. Si falló por salida inválida, reintentar una sola vez con el mensaje de error Zod
    if (interpretacion.motivoFallo === "salida_invalida" && interpretacion.errorValidacion) {
      reintentos = 1;
      const promptReintento = `${contexto.prompt}\n\n[REINTENTO POR SALIDA INVÁLIDA]\nLa salida devuelta no cumplió con el esquema requerido:\n${interpretacion.errorValidacion}\nPor favor, responde estrictamente con el JSON de AgentOutput válido.`;

      resultadoCmd = await ejecutarIntento(promptReintento);

      if (resultadoCmd.canceladoPor === "turnos_agotados") {
        await this.guardarLog(
          rutaLog,
          `[TURNOS AGOTADOS EN REINTENTO] Límite de turnos (${maxSteps}) superado. Proceso terminado.\nStdout: ${resultadoCmd.salidaEstandar}`,
        );
        return {
          exito: false,
          output: null,
          motivoFallo: "turnos_agotados",
          uso: {
            tokensEntrada: tokensEntradaStreaming,
            tokensSalida: tokensSalidaStreaming,
            turnos: turnosStreaming,
          },
          costoEstimado: this.calcularCosto(
            {
              tokensEntrada: tokensEntradaStreaming,
              tokensSalida: tokensSalidaStreaming,
              turnos: turnosStreaming,
            },
            contexto,
          ),
          modeloEfectivo: contexto.modelo,
          duracionMs: Date.now() - inicio,
          rutaLog,
          reintentos,
        };
      }

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

      interpretacion = parsearSalidaClaudeCode(resultadoCmd.salidaEstandar);
    }

    // 3. Batuta aplica el límite de turnos aunque la herramienta lo ignore
    const turnosTotales = Math.max(interpretacion.uso.turnos ?? 0, turnosStreaming);
    interpretacion.uso.turnos = turnosTotales;

    if (turnosTotales > maxSteps) {
      interpretacion.exito = false;
      interpretacion.agentOutput = null;
      interpretacion.motivoFallo = "turnos_agotados";
    }

    // 4. Calcular costo con la tabla de alias de la configuración
    const costoEstimado = this.calcularCosto(interpretacion.uso, contexto);

    // 5. Guardar registro ofuscando secretos
    const logCompleto = [
      `=== LOG DE EJECUCIÓN AGENTE ===`,
      `Tarea: ${input.task_id}`,
      `Rol: ${contexto.rol}`,
      `Modelo: ${contexto.modelo}`,
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
  }

  private calcularCosto(uso: UsoAgente, contexto: AgentCallContext): CostoEstimado {
    const alias = contexto.aliasModelo;
    const precios = alias && this.config?.alias_modelos?.[alias]
      ? this.config.alias_modelos[alias]
      : undefined;

    return calcularCostoEstimado(
      { entrada: uso.tokensEntrada, salida: uso.tokensSalida },
      precios ? { entrada: precios.entrada, salida: precios.salida } : undefined,
    );
  }

  private async guardarLog(rutaLog: string, contenido: string): Promise<void> {
    const contenidoOfuscado = ofuscarSecretos(contenido);
    await mkdir(dirname(rutaLog), { recursive: true });
    await writeFile(rutaLog, contenidoOfuscado, "utf8");
  }
}

/**
 * Realiza comprobaciones previas para verificar que la CLI de Claude Code esté disponible y compatible.
 */
export async function verificarPreflightClaudeCode(
  ejecutor: EjecutorComandos = new EjecutorComandosReal(),
): Promise<{
  ok: boolean;
  version: string | null;
  flagsAdmitidos: boolean;
  mensaje?: string;
}> {
  const resVersion = await ejecutor.ejecutarArgs("claude", ["--version"]);
  if (resVersion.codigoSalida !== 0) {
    return {
      ok: false,
      version: null,
      flagsAdmitidos: false,
      mensaje:
        "La CLI de Claude Code no está instalada o no se encuentra en el PATH.",
    };
  }

  const match = resVersion.salidaEstandar.match(/(\d+\.\d+\.\d+)/);
  const version = match ? match[1]! : null;

  const resHelp = await ejecutor.ejecutarArgs("claude", ["--help"]);
  if (resHelp.codigoSalida !== 0) {
    return {
      ok: false,
      version,
      flagsAdmitidos: false,
      mensaje: "No se pudo consultar la ayuda de Claude Code (--help).",
    };
  }

  const salidaHelp = resHelp.salidaEstandar;
  const tienePrint =
    salidaHelp.includes("--print") || salidaHelp.includes("-p");
  const tieneOutputFormat = salidaHelp.includes("--output-format");
  const tieneJsonSchema = salidaHelp.includes("--json-schema");

  if (!tienePrint || !tieneOutputFormat || !tieneJsonSchema) {
    return {
      ok: false,
      version,
      flagsAdmitidos: false,
      mensaje: `La versión de Claude Code instalada (${version ?? "desconocida"}) no admite los flags requeridos (--print, --output-format, --json-schema).`,
    };
  }

  return {
    ok: true,
    version,
    flagsAdmitidos: true,
  };
}
