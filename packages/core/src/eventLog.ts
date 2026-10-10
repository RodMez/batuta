import { parseEventLine } from "./events.js";
import type { BatutaEvent } from "./events.js";
import type { SistemaArchivos } from "./sistema.js";
import { detalleError, esNoEncontrado } from "./sistema.js";

/** Resultado de leer un registro: eventos válidos y si se descartó cola. */
export interface LecturaRegistro {
  eventos: BatutaEvent[];
  /** Verdadero si la última línea estaba cortada y se descartó. */
  truncado: boolean;
}

/**
 * Función pura: trocea el texto de un `events.jsonl` y valida cada línea.
 * Tolera una última línea cortada (falta el salto final): la descarta e
 * informa con `truncado: true`. Cualquier otra línea inválida es un error
 * que indica su número (1-based). Las líneas se leen con finales LF; un
 * `\r` final se tolera al leer para no romper en Windows.
 */
export function leerTextoRegistro(texto: string): LecturaRegistro {
  if (texto === "") {
    return { eventos: [], truncado: false };
  }
  const completo = texto.endsWith("\n");
  const trozos = texto.split("\n");
  const utiles = trozos.slice(0, -1);
  const eventos: BatutaEvent[] = [];
  utiles.forEach((trozo: string, indice: number): void => {
    const linea = trozo.endsWith("\r") ? trozo.slice(0, -1) : trozo;
    try {
      eventos.push(parseEventLine(linea));
    } catch (error) {
      throw new Error(
        `events.jsonl línea ${indice + 1}: ${detalleError(error)}`,
      );
    }
  });
  return { eventos, truncado: !completo };
}

/**
 * Prefijo del texto que solo contiene líneas completas (función pura).
 * Lo usa la recuperación tras caída: los bytes cortados nunca fueron un
 * evento válido, así que descartarlos no reescribe ningún evento anterior.
 */
export function prefijoCompleto(texto: string): string {
  if (texto === "" || texto.endsWith("\n")) {
    return texto;
  }
  const corte = texto.lastIndexOf("\n");
  return corte === -1 ? "" : texto.slice(0, corte + 1);
}

/**
 * Lee y valida todo el registro en disco. Un registro inexistente equivale
 * a uno vacío (ejecución aún sin eventos). La última línea cortada se
 * descarta e informa; una línea inválida en medio falla con su número.
 */
export async function leerRegistro(
  fs: SistemaArchivos,
  ruta: string,
): Promise<LecturaRegistro> {
  let texto: string;
  try {
    texto = await fs.leerArchivo(ruta);
  } catch (error) {
    if (esNoEncontrado(error)) {
      return { eventos: [], truncado: false };
    }
    throw error;
  }
  return leerTextoRegistro(texto);
}
