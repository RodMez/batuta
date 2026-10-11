import {
  verificarPreflightClaudeCode,
  type BatutaConfig,
} from "@batuta/core";
import { cargarConfiguracion, type EntornoCLI } from "./contexto.js";

/** Un chequeo del entorno: correcto, aviso o error, siempre con detalle. */
export interface Chequeo {
  nombre: string;
  estado: "correcto" | "aviso" | "error";
  detalle: string;
}

export interface OpcionesPreflight {
  repoDir: string;
  configPath: string;
  refBase?: string;
  simulado: boolean;
}

/**
 * Comprueba el entorno sin gastar nada: repositorio, Git, árbol (sin contar
 * `.batuta/`), referencia base, configuración, herramienta de agentes (solo
 * si se usará), precios y variables de modelo (solo nombres, nunca valores).
 */
export async function ejecutarChequeos(
  entorno: EntornoCLI,
  opciones: OpcionesPreflight,
): Promise<{ chequeos: Chequeo[]; config?: BatutaConfig }> {
  const chequeos: Chequeo[] = [];

  const previas = await entorno.git.comprobacionesPrevias(
    opciones.repoDir,
    opciones.refBase ?? "HEAD",
  );
  if (!previas.esRepo) {
    chequeos.push({
      nombre: "repositorio",
      estado: "error",
      detalle: `El directorio "${opciones.repoDir}" no es un repositorio Git.`,
    });
    return { chequeos };
  }
  chequeos.push({
    nombre: "repositorio",
    estado: "correcto",
    detalle: `Repositorio en "${opciones.repoDir}".`,
  });

  if (!previas.versionSuficiente) {
    chequeos.push({
      nombre: "git",
      estado: "error",
      detalle: `Versión de Git insuficiente (${previas.versionGit ?? "desconocida"}); se requiere ${"2.28.0"} o superior.`,
    });
  } else {
    chequeos.push({
      nombre: "git",
      estado: "correcto",
      detalle: `Git ${previas.versionGit} compatible.`,
    });
  }

  const sucios = await rutasSucias(entorno, opciones.repoDir);
  if (sucios.length > 0) {
    const muestra = sucios.slice(0, 5).join(", ");
    chequeos.push({
      nombre: "arbol",
      estado: "error",
      detalle: `El árbol tiene ${sucios.length} cambio(s) sin confirmar (${muestra}${sucios.length > 5 ? ", …" : ""}). Confírmalos o descártalos antes de continuar.`,
    });
  } else {
    chequeos.push({
      nombre: "arbol",
      estado: "correcto",
      detalle: "Árbol limpio (sin contar .batuta/).",
    });
  }

  if (!previas.referenciaExiste) {
    chequeos.push({
      nombre: "base",
      estado: "error",
      detalle: `La referencia base "${opciones.refBase ?? "HEAD"}" no existe en el repositorio.`,
    });
  } else {
    chequeos.push({
      nombre: "base",
      estado: "correcto",
      detalle: `Referencia base "${opciones.refBase ?? "HEAD"}" válida.`,
    });
  }

  let config: BatutaConfig | undefined;
  try {
    config = await cargarConfiguracion(opciones.configPath, entorno);
    chequeos.push({
      nombre: "configuracion",
      estado: "correcto",
      detalle: `Configuración válida en "${opciones.configPath}".`,
    });
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    chequeos.push({ nombre: "configuracion", estado: "error", detalle });
    return { chequeos };
  }

  if (!opciones.simulado && config.ejecutor === "claude-code") {
    const preflight = await verificarPreflightClaudeCode(entorno.ejecutor);
    if (!preflight.ok) {
      chequeos.push({
        nombre: "herramienta",
        estado: "error",
        detalle: preflight.mensaje ?? "La herramienta de agentes no está disponible.",
      });
    } else {
      chequeos.push({
        nombre: "herramienta",
        estado: "correcto",
        detalle: `Herramienta compatible (versión ${preflight.version ?? "desconocida"}).`,
      });
    }
  } else {
    chequeos.push({
      nombre: "herramienta",
      estado: "correcto",
      detalle: "Agentes simulados: no se necesita herramienta externa.",
    });
  }

  const sinPrecios = Object.entries(config.alias_modelos)
    .filter(([, alias]) => alias.entrada === undefined || alias.salida === undefined)
    .map(([nombre]) => nombre);
  if (sinPrecios.length > 0) {
    chequeos.push({
      nombre: "precios",
      estado: "aviso",
      detalle: `Sin precios en: ${sinPrecios.join(", ")}. Sin precios no hay límite en dólares, solo en tokens.`,
    });
  } else {
    chequeos.push({
      nombre: "precios",
      estado: "correcto",
      detalle: "Todos los alias tienen precios.",
    });
  }

  const sinDefinir = config.variables_modelo.filter(
    (nombre) => process.env[nombre] === undefined,
  );
  if (sinDefinir.length > 0) {
    chequeos.push({
      nombre: "variables",
      estado: "aviso",
      detalle: `Variables no definidas en el entorno: ${sinDefinir.join(", ")}.`,
    });
  } else if (config.variables_modelo.length > 0) {
    chequeos.push({
      nombre: "variables",
      estado: "correcto",
      detalle: `Variables de modelo definidas: ${config.variables_modelo.join(", ")}.`,
    });
  } else {
    chequeos.push({
      nombre: "variables",
      estado: "correcto",
      detalle: "Sin variables de modelo requeridas.",
    });
  }

  return { chequeos, config };
}

/** Rutas con cambios sin confirmar, excluyendo `.batuta/`. */
async function rutasSucias(
  entorno: EntornoCLI,
  repoDir: string,
): Promise<string[]> {
  const res = await entorno.ejecutor.ejecutarArgs(
    "git",
    ["status", "--porcelain=v1", "-z", "-uall"],
    { cwd: repoDir },
  );
  if (res.codigoSalida !== 0) return [];
  const sucias: string[] = [];
  for (const token of res.salidaEstandar.split("\0")) {
    if (token.length < 4) continue;
    // Formato `XY ruta`; en renombres el origen viene sin prefijo y se ignora.
    if (token[2] !== " ") continue;
    const ruta = token.slice(3).replace(/\\/g, "/");
    if (ruta === ".batuta" || ruta.startsWith(".batuta/")) continue;
    sucias.push(ruta);
  }
  return sucias;
}

/** Formatea los chequeos en líneas sobrias para la terminal. */
export function formatearChequeos(chequeos: Chequeo[]): string {
  return chequeos
    .map((c) => {
      const marca =
        c.estado === "correcto" ? "ok" : c.estado === "aviso" ? "AVISO" : "ERROR";
      return `${marca} - ${c.nombre}: ${c.detalle}`;
    })
    .join("\n");
}
