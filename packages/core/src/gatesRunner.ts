import { z } from "zod";
import type { Gate } from "./config.js";
import type { EjecutorComandos } from "./commandRunner.js";
import { EjecutorComandosReal } from "./commandRunner.js";

/** Resultado de la ejecución de un gate individual. */
export const ResultadoGateSchema = z.strictObject({
  nombre: z.string().min(1),
  comando: z.string().min(1),
  resultado: z.enum(["pasa", "falla"]),
  codigo_salida: z.number().nullable(),
  duracion_ms: z.number().min(0),
  timeout_vencido: z.boolean(),
  salida_estandar: z.string(),
  salida_error: z.string(),
  bytes_descartados_stdout: z.number().min(0).optional(),
  bytes_descartados_stderr: z.number().min(0).optional(),
});

export type ResultadoGate = z.infer<typeof ResultadoGateSchema>;

/** Informe completo de ejecución de la suite de gates. */
export const InformeGatesSchema = z.strictObject({
  exito: z.boolean(),
  gates: z.array(ResultadoGateSchema),
  duracion_total_ms: z.number().min(0),
});

export type InformeGates = z.infer<typeof InformeGatesSchema>;

/**
 * Payload tipado para el evento `gate_ejecutado` en el registro.
 * Admite campos adicionales (.catchall) para extensibilidad.
 */
export const GateEjecutadoPayloadSchema = z
  .strictObject({
    nombre: z.string().min(1),
    comando: z.string().min(1),
    resultado: z.enum(["pasa", "falla"]),
    codigo_salida: z.number().nullable(),
    duracion_ms: z.number().min(0),
    timeout_vencido: z.boolean(),
    salida_estandar: z.string().optional(),
    salida_error: z.string().optional(),
    bytes_descartados_stdout: z.number().min(0).optional(),
    bytes_descartados_stderr: z.number().min(0).optional(),
  })
  .catchall(z.unknown());

export type GateEjecutadoPayload = z.infer<typeof GateEjecutadoPayloadSchema>;

/**
 * Convierte el resultado de un gate en el payload tipado para el evento `gate_ejecutado`.
 */
export function crearPayloadGate(resultado: ResultadoGate): GateEjecutadoPayload {
  return GateEjecutadoPayloadSchema.parse({
    nombre: resultado.nombre,
    comando: resultado.comando,
    resultado: resultado.resultado,
    codigo_salida: resultado.codigo_salida,
    duracion_ms: resultado.duracion_ms,
    timeout_vencido: resultado.timeout_vencido,
    salida_estandar: resultado.salida_estandar,
    salida_error: resultado.salida_error,
    bytes_descartados_stdout: resultado.bytes_descartados_stdout,
    bytes_descartados_stderr: resultado.bytes_descartados_stderr,
  });
}

/** Opciones de ejecución de gates. */
export interface OpcionesEjecucionGates {
  ejecutor?: EjecutorComandos;
  entornoExtra?: Record<string, string>;
  continuarTrasFallo?: boolean;
  limiteSalidaBytes?: number;
}

/**
 * Ejecuta una lista de gates en orden y devuelve un informe JSON validado.
 * Por defecto se detiene en el primer fallo; con `continuarTrasFallo: true`
 * ejecuta todos los gates independientemente de fallos anteriores.
 */
export async function ejecutarGates(
  gates: readonly Gate[],
  directorio: string,
  opciones?: OpcionesEjecucionGates,
): Promise<InformeGates> {
  const inicioTotal = Date.now();
  const ejecutor = opciones?.ejecutor ?? new EjecutorComandosReal();
  const continuarTrasFallo = opciones?.continuarTrasFallo ?? false;
  const resultados: ResultadoGate[] = [];

  for (const gate of gates) {
    const res = await ejecutor.ejecutar(gate.comando, {
      cwd: directorio,
      timeoutMs: gate.timeout_seg * 1000,
      entornoExtra: opciones?.entornoExtra,
      limiteSalidaBytes: opciones?.limiteSalidaBytes,
    });

    const pasa = res.codigoSalida === 0 && !res.timeoutVencido;
    const resultadoGate: ResultadoGate = {
      nombre: gate.nombre,
      comando: gate.comando,
      resultado: pasa ? "pasa" : "falla",
      codigo_salida: res.codigoSalida,
      duracion_ms: res.duracionMs,
      timeout_vencido: res.timeoutVencido,
      salida_estandar: res.salidaEstandar,
      salida_error: res.salidaError,
      bytes_descartados_stdout: res.bytesDescartadosStdout,
      bytes_descartados_stderr: res.bytesDescartadosStderr,
    };

    // Validar cada resultado individual
    ResultadoGateSchema.parse(resultadoGate);
    resultados.push(resultadoGate);

    if (!pasa && !continuarTrasFallo) {
      break;
    }
  }

  const duracionTotalMs = Date.now() - inicioTotal;
  const exito = resultados.every((r) => r.resultado === "pasa");

  const informe: InformeGates = {
    exito,
    gates: resultados,
    duracion_total_ms: duracionTotalMs,
  };

  return InformeGatesSchema.parse(informe);
}
