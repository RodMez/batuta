import { CommanderError } from "commander";
import { join } from "node:path";
import { dirRun, type ResultadoMotor } from "@batuta/core";

/** Códigos de salida documentados (sección 4). */
export const CODIGO_TERMINADA = 0;
export const CODIGO_PAUSA_APROBACION = 10;
export const CODIGO_PAUSA_ENTRADA = 11;
export const CODIGO_FALLIDA = 1;
export const CODIGO_USO = 2;

/** Resultado textual de un manejador, listo para imprimir. */
export interface ResultadoCLI {
  texto: string;
  codigo: number;
}

/** Traduce el resultado del motor a texto accionable y código de salida. */
export function presentarResultado(
  resultado: ResultadoMotor,
  dirBatuta: string,
): ResultadoCLI {
  switch (resultado.resultado) {
    case "pausa-aprobacion": {
      const solicitud = join(
        dirRun(dirBatuta, resultado.runId),
        `aprobacion-${resultado.puerta}.md`,
      );
      return {
        texto: [
          `Pausada: se requiere aprobación ${resultado.puerta} en ${resultado.runId}.`,
          `Solicitud: ${solicitud}`,
          `Siguiente: batuta approve ${resultado.runId} ${resultado.puerta}`,
          `O bien: batuta approve ${resultado.runId} ${resultado.puerta} --rechazar`,
        ].join("\n"),
        codigo: CODIGO_PAUSA_APROBACION,
      };
    }
    case "pausa-entrada": {
      const espera = join(dirRun(dirBatuta, resultado.runId), "espera-entrada.md");
      return {
        texto: [
          `Pausada: el agente necesita una respuesta en ${resultado.runId}.`,
          `Pregunta: ${resultado.pregunta}`,
          `Detalle: ${espera}`,
          `Siguiente: batuta answer ${resultado.runId} "<tu respuesta>"`,
        ].join("\n"),
        codigo: CODIGO_PAUSA_ENTRADA,
      };
    }
    case "terminada": {
      const resumen = join(dirRun(dirBatuta, resultado.runId), "summary.md");
      return {
        texto: [
          `Terminada en DONE: ${resultado.runId}.`,
          `Resumen: ${resumen}`,
        ].join("\n"),
        codigo: CODIGO_TERMINADA,
      };
    }
    case "fallida": {
      return {
        texto: [`Fallida: ${resultado.runId}.`, `Motivo: ${resultado.motivo}`].join("\n"),
        codigo: CODIGO_FALLIDA,
      };
    }
    case "abortada": {
      return {
        texto: `Abortada y limpia: ${resultado.runId} (worktree y rama eliminados).`,
        codigo: CODIGO_TERMINADA,
      };
    }
  }
}

const TRADUCCIONES: ReadonlyArray<readonly [string, string]> = [
  ["unknown option", "opción desconocida"],
  ["unknown command", "comando desconocido"],
  ["missing required argument", "falta el argumento requerido"],
  ["missing argument", "falta un argumento"],
  ["too many arguments", "demasiados argumentos"],
  ["option missing argument", "a la opción le falta su valor"],
  ["invalid argument", "argumento inválido"],
  ["excess arguments", "argumentos de más"],
];

/** Pasa los errores internos de commander a español sin perder el detalle. */
export function traducirErrorCommander(mensaje: string): string {
  let texto = mensaje;
  for (const [ingles, espanol] of TRADUCCIONES) {
    texto = texto.replace(ingles, espanol);
  }
  return texto;
}

/**
 * Trata el error lanzado por `parseAsync` con `exitOverride`.
 * Devuelve el código de salida (0 si solo se mostró ayuda o versión).
 */
export function manejarErrorParseo(error: unknown): number {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) return 0;
    console.error(`Error de uso: ${traducirErrorCommander(error.message)}`);
    console.error(`Usa «batuta --help» para ver los comandos.`);
    return CODIGO_USO;
  }
  return CODIGO_USO;
}

/** Formatea un error de manejador: mensaje claro, pila solo con --debug. */
export function formatearError(error: unknown, debug: boolean): string {
  const mensaje = error instanceof Error ? error.message : String(error);
  if (debug && error instanceof Error && error.stack) {
    return `Error: ${mensaje}\n${error.stack}`;
  }
  return `Error: ${mensaje}`;
}
