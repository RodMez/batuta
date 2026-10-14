import { z } from "zod";
import { EjecutorComandos, EjecutorComandosReal } from "./commandRunner.js";
import { formatZodError } from "./validation.js";

/** Esquema de un bucket de cuota individual devuelto por `agy /usage`. */
export const BucketUsoSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    description: z.string().optional(),
    window: z.string().optional(),
    remaining_fraction: z.number().min(0).max(1),
    reset_time: z.string().optional(),
  })
  .passthrough();

export type BucketUso = z.infer<typeof BucketUsoSchema>;

/** Grupo de modelos en la salida de `agy /usage`. */
export const GrupoUsoSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    buckets: z.array(BucketUsoSchema).default([]),
  })
  .passthrough();

export type GrupoUso = z.infer<typeof GrupoUsoSchema>;

/** Datos estructurados contenidos en command.data del JSON de `agy /usage`. */
export const DatosUsoSchema = z
  .object({
    description: z.string().optional(),
    groups: z.array(GrupoUsoSchema).default([]),
  })
  .passthrough();

export type DatosUso = z.infer<typeof DatosUsoSchema>;

/** Estructura raíz devuelta por `agy -p /usage --output-format json`. */
export const RespuestaUsageAgySchema = z
  .object({
    status: z.string().optional(),
    command: z
      .object({
        name: z.string().optional(),
        data: DatosUsoSchema,
      })
      .passthrough(),
  })
  .passthrough();

export type RespuestaUsageAgy = z.infer<typeof RespuestaUsageAgySchema>;

/** Resultado de la evaluación de cuota para un modelo. */
export interface EvaluacionCuota {
  suficiente: boolean;
  bucketsEvaluados: BucketUso[];
  bucketsBajoUmbral: BucketUso[];
  resetTimeMasTardio: string | null;
}

/**
 * Devuelve la lista de IDs de buckets correspondientes a un modelo.
 * Gemini: gemini-5h y gemini-weekly.
 * Claude, Opus, GPT-OSS: 3p-5h y 3p-weekly.
 */
export function obtenerBucketsParaModelo(nombreModelo: string): string[] {
  const m = nombreModelo.toLowerCase();
  if (m.startsWith("gemini-") || m.includes("gemini")) {
    return ["gemini-5h", "gemini-weekly"];
  }
  // Modelos de terceros (Claude, GPT, etc.)
  return ["3p-5h", "3p-weekly"];
}

/**
 * Parseador puro de la salida JSON de `agy -p /usage --output-format json`.
 * Extrae todos los buckets planos tolerando formatos extensibles.
 */
export function parsearRespuestaUso(salidaJsonTexto: string): BucketUso[] {
  let raw: unknown;
  try {
    raw = JSON.parse(salidaJsonTexto.trim());
  } catch {
    throw new Error("Salida de /usage inválida: no es JSON válido");
  }

  const validado = RespuestaUsageAgySchema.safeParse(raw);
  if (!validado.success) {
    throw new Error(
      `Estructura de /usage inválida: ${formatZodError(validado.error)}`,
    );
  }

  const todosBuckets: BucketUso[] = [];
  for (const grupo of validado.data.command.data.groups) {
    for (const b of grupo.buckets) {
      todosBuckets.push(b);
    }
  }

  return todosBuckets;
}

/**
 * Evalúa si la cuota disponible para un modelo supera el umbral configurado.
 * Si alguno de sus buckets está por debajo del umbral, se considera insuficiente
 * y se selecciona el reset_time más tardío (mayor) entre los buckets afectados.
 */
export function evaluarCuota(
  buckets: readonly BucketUso[],
  nombreModelo: string,
  umbralCuota: number = 0.05,
): EvaluacionCuota {
  const idsEsperados = obtenerBucketsParaModelo(nombreModelo);
  const mapaBuckets = new Map<string, BucketUso>();
  for (const b of buckets) {
    mapaBuckets.set(b.id, b);
  }

  const evaluados: BucketUso[] = [];
  const bajoUmbral: BucketUso[] = [];

  for (const id of idsEsperados) {
    const bucket = mapaBuckets.get(id);
    if (bucket) {
      evaluados.push(bucket);
      if (bucket.remaining_fraction < umbralCuota) {
        bajoUmbral.push(bucket);
      }
    }
  }

  // Si no se encontraron los buckets esperados, asumimos que no hay bloqueo de cuota conocido
  if (bajoUmbral.length === 0) {
    return {
      suficiente: true,
      bucketsEvaluados: evaluados,
      bucketsBajoUmbral: [],
      resetTimeMasTardio: null,
    };
  }

  // Seleccionar el reset_time más tardío (lexicográficamente mayor en ISO 8601)
  let masTardio: string | null = null;
  for (const b of bajoUmbral) {
    if (b.reset_time) {
      if (masTardio === null || b.reset_time > masTardio) {
        masTardio = b.reset_time;
      }
    }
  }

  return {
    suficiente: false,
    bucketsEvaluados: evaluados,
    bucketsBajoUmbral: bajoUmbral,
    resetTimeMasTardio: masTardio,
  };
}

/**
 * Gestor de cuotas que interactúa con el binario `agy`.
 * Incluye caché en memoria por tiempo para no saturar con llamadas repetidas a `/usage`.
 */
export class CuotaManager {
  private ejecutor: EjecutorComandos;
  private binPath: string;
  private cacheBuckets: { buckets: BucketUso[]; timestamp: number } | null = null;
  private cacheTtlMs: number;

  constructor(opciones?: {
    ejecutor?: EjecutorComandos;
    binPath?: string;
    cacheTtlMs?: number;
  }) {
    this.ejecutor = opciones?.ejecutor ?? new EjecutorComandosReal();
    this.binPath = opciones?.binPath ?? "agy";
    this.cacheTtlMs = opciones?.cacheTtlMs ?? 30_000; // 30 segundos de caché por defecto
  }

  /** Invalida la caché de cuota forzando una nueva consulta. */
  limpiarCache(): void {
    this.cacheBuckets = null;
  }

  /**
   * Consulta `/usage` en modo JSON.
   * Si la CLI falla (código no cero), lanza error real.
   */
  async consultarBuckets(forzarFresca: boolean = false): Promise<BucketUso[]> {
    const ahora = Date.now();
    if (
      !forzarFresca &&
      this.cacheBuckets !== null &&
      ahora - this.cacheBuckets.timestamp < this.cacheTtlMs
    ) {
      return this.cacheBuckets.buckets;
    }

    const resultado = await this.ejecutor.ejecutarArgs(
      this.binPath,
      ["-p", "/usage", "--output-format", "json"],
      {
        timeoutMs: 30_000,
      },
    );

    if (resultado.codigoSalida !== 0) {
      throw new Error(
        `Error al consultar /usage de agy (código ${resultado.codigoSalida}): ${resultado.salidaError || resultado.salidaEstandar}`,
      );
    }

    const buckets = parsearRespuestaUso(resultado.salidaEstandar);
    this.cacheBuckets = { buckets, timestamp: ahora };
    return buckets;
  }

  /**
   * Evalúa si un modelo puede ser invocado de acuerdo a su cuota disponible.
   */
  async verificarCuotaModelo(
    nombreModelo: string,
    umbralCuota: number = 0.05,
    forzarFresca: boolean = false,
  ): Promise<EvaluacionCuota> {
    const buckets = await this.consultarBuckets(forzarFresca);
    return evaluarCuota(buckets, nombreModelo, umbralCuota);
  }
}
