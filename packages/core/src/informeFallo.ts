import type { ViolacionDiff } from "./diffPolicy.js";
import type { ResultadoGate } from "./gatesRunner.js";

/** Fallo evaluable para informe recortado y firma de bucle (sección 3.5). */
export type FalloEvaluacion =
  | {
      tipo: "diff";
      violaciones: readonly ViolacionDiff[];
    }
  | {
      tipo: "gate";
      gate: ResultadoGate;
    }
  | {
      tipo: "agente";
      motivo: string;
      detalle?: string;
    }
  | {
      tipo: "preparacion";
      comando: string;
      codigoSalida: number | null;
      salida: string;
    };

/** Tamaño máximo del informe recortado para reintentos (caracteres). */
export const INFORME_FALLO_MAX_CHARS = 2000;

/** Líneas de salida conservadas en el informe (las últimas relevantes). */
export const INFORME_FALLO_MAX_LINEAS = 30;

function ultimasLineas(texto: string, max: number): string[] {
  const lineas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lineas.slice(-max);
}

function recortar(texto: string, max: number): string {
  if (texto.length <= max) return texto;
  return `…[recortado]…\n${texto.slice(-max)}`;
}

/**
 * Informe de fallo recortado para los reintentos: gate, comando, código de
 * salida y las últimas líneas relevantes de la salida, con tamaño máximo.
 * Texto plano, apto para interpolar en el prompt (nunca en comandos).
 */
export function recortarInformeFallo(fallo: FalloEvaluacion): string {
  switch (fallo.tipo) {
    case "diff": {
      const lineas = fallo.violaciones.map(
        (v) =>
          `- [${v.tipo}]${v.archivo ? ` ${v.archivo}` : ""}: ${v.mensaje}`,
      );
      return recortar(
        `Violación de la política de diff:\n${lineas.join("\n")}`,
        INFORME_FALLO_MAX_CHARS,
      );
    }
    case "gate": {
      const g = fallo.gate;
      const salida = [g.salida_estandar, g.salida_error]
        .filter((s) => s.trim().length > 0)
        .join("\n");
      const relevantes = ultimasLineas(salida, INFORME_FALLO_MAX_LINEAS).join("\n");
      const base = [
        `Gate: ${g.nombre}`,
        `Comando: ${g.comando}`,
        `Código de salida: ${g.codigo_salida ?? "null"}${g.timeout_vencido ? " (timeout)" : ""}`,
        `Salida (últimas líneas):`,
        relevantes.length > 0 ? relevantes : "(sin salida)",
      ].join("\n");
      return recortar(base, INFORME_FALLO_MAX_CHARS);
    }
    case "agente": {
      const base = [`Fallo del agente: ${fallo.motivo}`, fallo.detalle ?? ""]
        .filter((s) => s.length > 0)
        .join("\n");
      return recortar(base, INFORME_FALLO_MAX_CHARS);
    }
    case "preparacion": {
      const relevantes = ultimasLineas(fallo.salida, INFORME_FALLO_MAX_LINEAS).join("\n");
      const base = [
        `Preparación fallida`,
        `Comando: ${fallo.comando}`,
        `Código de salida: ${fallo.codigoSalida ?? "null"}`,
        `Salida (últimas líneas):`,
        relevantes.length > 0 ? relevantes : "(sin salida)",
      ].join("\n");
      return recortar(base, INFORME_FALLO_MAX_CHARS);
    }
  }
}

function normalizarParaFirma(texto: string): string {
  return texto.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Firma del fallo para detectar bucles: si el mismo error se repite dos
 * veces seguidas (misma firma), se escala de inmediato al `debugger`.
 * Compara gate y primeras líneas relevantes (sección 3.5).
 */
export function firmaFallo(fallo: FalloEvaluacion): string {
  switch (fallo.tipo) {
    case "diff": {
      const partes = [...fallo.violaciones]
        .map((v) => `${v.tipo}:${v.archivo ?? ""}:${v.mensaje}`)
        .sort();
      return `diff:${normalizarParaFirma(partes.join("|"))}`;
    }
    case "gate": {
      const g = fallo.gate;
      const salida = [g.salida_estandar, g.salida_error]
        .filter((s) => s.trim().length > 0)
        .join("\n");
      const primeras = salida
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .slice(0, 5)
        .join("\n");
      return `gate:${g.nombre}:${g.codigo_salida ?? "null"}:${normalizarParaFirma(primeras)}`;
    }
    case "agente": {
      return `agente:${fallo.motivo}:${normalizarParaFirma(fallo.detalle ?? "")}`;
    }
    case "preparacion": {
      return `preparacion:${fallo.comando}:${fallo.codigoSalida ?? "null"}`;
    }
  }
}
