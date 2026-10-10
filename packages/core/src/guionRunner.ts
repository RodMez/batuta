import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { AgentOutputSchema } from "./agentContract.js";
import type { AgentInput, AgentOutput } from "./agentContract.js";
import type {
  AgentCallContext,
  AgentRunner,
  AgentRunResult,
  MotivoFalloAgente,
  UsoAgente,
} from "./agentRunner.js";
import { MotivoFalloAgenteSchema } from "./agentRunner.js";
import { formatZodError } from "./validation.js";

/**
 * Una llamada guionada: espera opcional (ms), salida o fallo, uso simulado
 * y archivos que el agente "escribe" en el worktree. Si solo se indican
 * archivos, la salida es SUCCESS con esos archivos como modificados.
 */
export const GuionLlamadaSchema = z.strictObject({
  esperaMs: z.number().int().nonnegative().default(0),
  output: AgentOutputSchema.optional(),
  fallo: MotivoFalloAgenteSchema.optional(),
  uso: z
    .strictObject({
      tokensEntrada: z.number().int().nonnegative().optional(),
      tokensSalida: z.number().int().nonnegative().optional(),
      turnos: z.number().int().nonnegative().optional(),
    })
    .default({}),
  archivos: z.record(z.string(), z.string()).default({}),
});

export type GuionLlamada = z.infer<typeof GuionLlamadaSchema>;

/**
 * Guion de agentes simulados (`--simulado <guion.json>`): lista ordenada de
 * llamadas. La llamada N del motor consume la entrada N (o `desde` + N).
 */
export const GuionSimuladoSchema = z.strictObject({
  version_esquema: z.number().int().min(1).default(1),
  llamadas: z.array(GuionLlamadaSchema).min(1),
});

export type GuionSimulado = z.infer<typeof GuionSimuladoSchema>;

/** Valida un valor desconocido como guion; falla con la ruta del campo. */
export function parseGuion(data: unknown): GuionSimulado {
  const resultado = GuionSimuladoSchema.safeParse(data);
  if (!resultado.success) {
    throw new Error(`Guion inválido: ${formatZodError(resultado.error)}`);
  }
  return resultado.data;
}

/** Parsea el texto JSON de un archivo de guion y lo valida. */
export function parseGuionJson(texto: string): GuionSimulado {
  let raw: unknown;
  try {
    raw = JSON.parse(texto) as unknown;
  } catch {
    throw new Error("Guion inválido: no es JSON válido");
  }
  return parseGuion(raw);
}

/**
 * Runner guionado para pruebas y demostraciones sin gastar nada.
 * Consume las llamadas en orden desde `desde` (para continuar una ejecución
 * en otro proceso, la CLI lo calcula con el uso ya registrado).
 */
export class RunnerGuionado implements AgentRunner {
  private realizadas = 0;
  readonly llamadasRecibidas: Array<{
    input: AgentInput;
    contexto: AgentCallContext;
  }> = [];

  constructor(
    private readonly guion: GuionSimulado,
    private readonly desde = 0,
  ) {}

  async ejecutar(
    input: AgentInput,
    contexto: AgentCallContext,
  ): Promise<AgentRunResult> {
    const indice = this.desde + this.realizadas;
    const paso = this.guion.llamadas[indice];
    if (!paso) {
      throw new Error(
        `Guion agotado: no hay llamada ${indice + 1} (el guion tiene ${this.guion.llamadas.length})`,
      );
    }
    this.llamadasRecibidas.push({ input, contexto });
    this.realizadas += 1;

    if (paso.esperaMs > 0) {
      await new Promise((resolver): void => {
        setTimeout(resolver, paso.esperaMs);
      });
    }

    for (const [relativa, contenido] of Object.entries(paso.archivos)) {
      const base = resolve(contexto.directorioTrabajo);
      const destino = resolve(base, relativa);
      if (destino !== base && !destino.startsWith(base + sep)) {
        throw new Error(`Ruta del guion fuera del worktree: "${relativa}"`);
      }
      await mkdir(dirname(destino), { recursive: true });
      await writeFile(destino, contenido, "utf8");
    }

    const uso: UsoAgente = {
      tokensEntrada: paso.uso.tokensEntrada ?? 100,
      tokensSalida: paso.uso.tokensSalida ?? 50,
      turnos: paso.uso.turnos ?? 1,
    };
    const baseResultado = {
      motivoFallo: null as MotivoFalloAgente | null,
      uso,
      costoEstimado: { montoUsd: null as number | null, desconocido: true },
      modeloEfectivo: "guion",
      duracionMs: paso.esperaMs,
      rutaLog: "",
      reintentos: 0,
    };

    if (paso.fallo) {
      return { ...baseResultado, exito: false, output: null, motivoFallo: paso.fallo };
    }
    const output: AgentOutput = paso.output ?? {
      status: "SUCCESS",
      summary: `Guion: llamada ${indice + 1} (${input.task_id})`,
      files_modified: Object.keys(paso.archivos),
      reported_checks: [],
      continuation_notes: "",
      blocking_question: "",
    };
    return { ...baseResultado, exito: true, output };
  }
}
