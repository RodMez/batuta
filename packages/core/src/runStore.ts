import { join } from "node:path";
import { pid } from "node:process";
import { z } from "zod";
import type { AgentRole } from "./agentContract.js";
import {
  indiceDeCheckpoint,
  nombreCheckpoint,
  parseCheckpoint,
  type Checkpoint,
} from "./checkpoints.js";
import { leerRegistro, leerTextoRegistro, prefijoCompleto } from "./eventLog.js";
import type { LecturaRegistro } from "./eventLog.js";
import type { BatutaEvent, EventType } from "./events.js";
import { parseEvent, serializeEvent } from "./events.js";
import { applyEvent, esEstadoTerminal, estadoInicial, rebuildState } from "./reducer.js";
import { parseRunState, type RunState } from "./state.js";
import type { Reloj, SistemaArchivos } from "./sistema.js";
import {
  detalleError,
  esNoEncontrado,
  relojSistema,
  sistemaArchivosNode,
} from "./sistema.js";

/** Identificador de ejecución `RUN-AAAA-MM-DD-NNN` (sección 19). */
export const RunIdSchema = z.string().regex(/^RUN-\d{4}-\d{2}-\d{2}-\d{3,}$/);

/** Evento a agregar: el almacén completa id, run_id y ts. */
export interface NuevoEvento {
  tipo: EventType;
  paso?: string;
  agente?: AgentRole;
  payload?: Record<string, unknown>;
  parent_id?: string;
}

/** Resultado de restaurar una ejecución tras una caída. */
export interface ResultadoRestore {
  estado: RunState;
  /** Verdadero si se partió del último checkpoint válido. */
  desdeCheckpoint: boolean;
  /** Verdadero si se descartó una última línea cortada. */
  colaDescartada: boolean;
  /** Eventos reproducidos sobre el checkpoint (0 si se reconstruyó todo). */
  eventosReproducidos: number;
}

/** Estructura en disco por ejecución (sección 6), bajo `<dirBatuta>/`. */
export function dirRuns(dirBatuta: string): string {
  return join(dirBatuta, "runs");
}

export function dirRun(dirBatuta: string, runId: string): string {
  return join(dirRuns(dirBatuta), runId);
}

export function rutaEventos(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "events.jsonl");
}

export function rutaEstado(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "state.json");
}

export function dirCheckpoints(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "checkpoints");
}

export function dirLogs(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), "logs");
}

function rutaBloqueo(dirBatuta: string, runId: string): string {
  return join(dirRun(dirBatuta, runId), ".lock");
}

/** Ruta del bloqueo de escritor único (para limpiar un bloqueo obsoleto). */
export function rutaBloqueoRun(dirBatuta: string, runId: string): string {
  return rutaBloqueo(dirBatuta, runId);
}

/**
 * Genera el siguiente `RUN-AAAA-MM-DD-NNN` (función pura, sin reloj ni
 * disco): fecha UTC del día y secuencial NNN sobre los ids existentes de
 * ese día (001 si no hay ninguno). La fecha UTC evita que el mismo
 * instante genere ids distintos según la zona horaria.
 */
export function generarRunId(
  fecha: string | Date,
  existentes: readonly string[],
): string {
  const instante = typeof fecha === "string" ? new Date(fecha) : fecha;
  if (Number.isNaN(instante.getTime())) {
    throw new Error("generarRunId: fecha inválida");
  }
  const dia = [
    String(instante.getUTCFullYear()),
    String(instante.getUTCMonth() + 1).padStart(2, "0"),
    String(instante.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const prefijo = `RUN-${dia}-`;
  let maximo = 0;
  for (const id of existentes) {
    if (id.startsWith(prefijo)) {
      const secuencial = Number.parseInt(id.slice(prefijo.length), 10);
      if (!Number.isNaN(secuencial)) {
        maximo = Math.max(maximo, secuencial);
      }
    }
  }
  return RunIdSchema.parse(`${prefijo}${String(maximo + 1).padStart(3, "0")}`);
}

/** Id de evento ordenable en el tiempo: `E-000001`, … (ver ADR 010). */
function idEvento(indice: number): string {
  return `E-${String(indice).padStart(6, "0")}`;
}

/**
 * Escritura atómica: vuelca a `destino.tmp` y renombra. Los lectores nunca
 * ven un `state.json` o checkpoint a medias aunque el proceso caiga.
 */
async function escrituraAtomica(
  fs: SistemaArchivos,
  destino: string,
  datos: string,
): Promise<void> {
  const tmp = `${destino}.tmp`;
  await fs.escribirArchivo(tmp, datos);
  await fs.renombrar(tmp, destino);
}

/**
 * Garantía de escritor único por ejecución: un archivo `.lock` creado en
 * exclusiva (`wx`). Si ya existe, otro proceso está escribiendo y se falla
 * con un mensaje explícito en vez de entrelazar líneas. Un bloqueo
 * obsoleto tras una caída se limpia borrando el `.lock`. El bloqueo se
 * libera siempre, incluso si la operación falla.
 */
async function conBloqueo<T>(
  fs: SistemaArchivos,
  bloqueo: string,
  operacion: () => Promise<T>,
): Promise<T> {
  try {
    await fs.escribirExclusivo(bloqueo, String(pid));
  } catch (error) {
    throw new Error(
      `No se pudo adquirir el bloqueo ${bloqueo} (¿otro proceso escribe esta ejecución? Si es un bloqueo obsoleto, bórralo): ${detalleError(error)}`,
    );
  }
  try {
    return await operacion();
  } finally {
    await fs.borrar(bloqueo);
  }
}

/**
 * Almacén de una ejecución sobre `<dirBatuta>/runs/<run_id>/` con
 * `events.jsonl`, `state.json`, `checkpoints/` y `logs/`. Recibe el sistema
 * de archivos y el reloj inyectados; por defecto usa los del sistema.
 */
export class RunStore {
  constructor(
    private readonly dirBatuta: string,
    private readonly fs: SistemaArchivos = sistemaArchivosNode,
    private readonly reloj: Reloj = relojSistema,
  ) {}

  /**
   * Crea la ejecución: genera el run_id, crea la estructura en disco,
   * agrega `ejecucion_iniciada` como primer evento y escribe el estado.
   */
  async iniciarEjecucion(): Promise<string> {
    const ahora = this.reloj.ahoraIso();
    let existentes: string[] = [];
    try {
      existentes = await this.fs.listarDir(dirRuns(this.dirBatuta));
    } catch (error) {
      if (!esNoEncontrado(error)) throw error;
    }
    const runId = generarRunId(ahora, existentes);
    await this.fs.crearDir(dirRun(this.dirBatuta, runId));
    await this.fs.crearDir(dirCheckpoints(this.dirBatuta, runId));
    await this.fs.crearDir(dirLogs(this.dirBatuta, runId));
    const primero = parseEvent({
      version_esquema: 1,
      id: idEvento(1),
      run_id: runId,
      ts: ahora,
      tipo: "ejecucion_iniciada",
      payload: {},
    });
    await this.fs.agregarArchivo(
      rutaEventos(this.dirBatuta, runId),
      `${serializeEvent(primero)}\n`,
    );
    const estado: RunState = { ...estadoInicial(runId), actualizada_en: ahora };
    await escrituraAtomica(
      this.fs,
      rutaEstado(this.dirBatuta, runId),
      JSON.stringify(estado),
    );
    return runId;
  }

  /**
   * Agrega un evento validado al registro (nunca reescribe lo anterior).
   * Valida el esquema, comprueba la transición con el reductor y actualiza
   * `state.json` de forma atómica. Si la última línea está cortada por una
   * caída, falla y pide `restaurar` primero en vez de soldar bytes rotos.
   */
  async agregar(runId: string, nuevo: NuevoEvento): Promise<BatutaEvent> {
    return conBloqueo(this.fs, rutaBloqueo(this.dirBatuta, runId), async () => {
      const ruta = rutaEventos(this.dirBatuta, runId);
      let texto: string;
      try {
        texto = await this.fs.leerArchivo(ruta);
      } catch (error) {
        if (esNoEncontrado(error)) {
          throw new Error(
            `No existe el registro de ${runId} (¿falta iniciarEjecucion?)`,
          );
        }
        throw error;
      }
      const lectura = leerTextoRegistro(texto);
      if (lectura.truncado) {
        throw new Error(
          `events.jsonl de ${runId} termina en una línea cortada: ejecuta restaurar antes de continuar`,
        );
      }
      const evento = parseEvent({
        version_esquema: 1,
        id: idEvento(lectura.eventos.length + 1),
        run_id: runId,
        ts: this.reloj.ahoraIso(),
        paso: nuevo.paso,
        agente: nuevo.agente,
        payload: nuevo.payload ?? {},
        parent_id: nuevo.parent_id,
        tipo: nuevo.tipo,
      });
      const estado = applyEvent(rebuildState(lectura.eventos), evento);
      await this.fs.agregarArchivo(ruta, `${serializeEvent(evento)}\n`);
      await escrituraAtomica(
        this.fs,
        rutaEstado(this.dirBatuta, runId),
        JSON.stringify(estado),
      );
      return evento;
    });
  }

  /** Lee y valida todo el registro; informa si descartó la última línea. */
  leer(runId: string): Promise<LecturaRegistro> {
    return leerRegistro(this.fs, rutaEventos(this.dirBatuta, runId));
  }

  /**
   * Devuelve el estado, con el registro como fuente de verdad: si
   * `state.json` falta se reconstruye; si discrepa del registro, gana el
   * registro y se sobrescribe.
   */
  async estado(runId: string): Promise<RunState> {
    const lectura = await this.leer(runId);
    if (lectura.truncado) {
      throw new Error(
        `events.jsonl de ${runId} termina en una línea cortada: ejecuta restaurar antes de leer el estado`,
      );
    }
    const reconstruido = rebuildState(lectura.eventos);
    const ruta = rutaEstado(this.dirBatuta, runId);
    let guardado: string;
    try {
      guardado = await this.fs.leerArchivo(ruta);
    } catch (error) {
      if (!esNoEncontrado(error)) throw error;
      await escrituraAtomica(this.fs, ruta, JSON.stringify(reconstruido));
      return reconstruido;
    }
    let valido: RunState;
    try {
      valido = parseRunState(JSON.parse(guardado) as unknown);
    } catch {
      await escrituraAtomica(this.fs, ruta, JSON.stringify(reconstruido));
      return reconstruido;
    }
    if (JSON.stringify(valido) !== JSON.stringify(reconstruido)) {
      await escrituraAtomica(this.fs, ruta, JSON.stringify(reconstruido));
      return reconstruido;
    }
    return valido;
  }

  /**
   * Guarda un checkpoint al completar una subtarea: estado serializado,
   * índice del último evento incluido y commit opaco (null hasta el hito 4).
   */
  async checkpoint(
    runId: string,
    commit: string | null,
  ): Promise<Checkpoint> {
    return conBloqueo(this.fs, rutaBloqueo(this.dirBatuta, runId), async () => {
      const lectura = await this.leer(runId);
      if (lectura.truncado) {
        throw new Error(
          `events.jsonl de ${runId} termina en una línea cortada: ejecuta restaurar antes de guardar el checkpoint`,
        );
      }
      const punto: Checkpoint = {
        version_esquema: 1,
        run_id: runId,
        ultimo_evento: lectura.eventos.length,
        estado: rebuildState(lectura.eventos),
        commit,
      };
      await escrituraAtomica(
        this.fs,
        join(dirCheckpoints(this.dirBatuta, runId), nombreCheckpoint(punto.ultimo_evento)),
        JSON.stringify(punto),
      );
      return punto;
    });
  }

  /**
   * Restaura tras una caída: descarta la última línea cortada (los únicos
   * bytes que se reescriben, pues nunca fueron un evento válido), parte
   * del último checkpoint válido y reproduce los eventos posteriores,
   * registrando `ejecucion_reanudada`. Deja `state.json` reconstruido.
   * Si el registro ya está en estado terminal no hay nada que continuar:
   * no agrega el evento de reanudación y devuelve el estado tal cual.
   */
  async restaurar(runId: string): Promise<ResultadoRestore> {
    return conBloqueo(this.fs, rutaBloqueo(this.dirBatuta, runId), async () => {
      const ruta = rutaEventos(this.dirBatuta, runId);
      let texto: string;
      try {
        texto = await this.fs.leerArchivo(ruta);
      } catch (error) {
        if (esNoEncontrado(error)) {
          throw new Error(
            `No existe el registro de ${runId} (¿falta iniciarEjecucion?)`,
          );
        }
        throw error;
      }
      const lectura = leerTextoRegistro(texto);
      if (lectura.truncado) {
        await this.fs.escribirArchivo(ruta, prefijoCompleto(texto));
      }
      const eventos = lectura.eventos;
      let nombres: string[] = [];
      try {
        nombres = await this.fs.listarDir(dirCheckpoints(this.dirBatuta, runId));
      } catch (error) {
        if (!esNoEncontrado(error)) throw error;
      }
      let base: RunState | null = null;
      let desde = 1;
      for (const nombre of nombres) {
        if (indiceDeCheckpoint(nombre) === null) continue;
        const punto = await this.leerCheckpoint(runId, nombre);
        if (punto === null || punto.run_id !== runId) continue;
        if (punto.ultimo_evento > eventos.length) continue;
        if (base === null || punto.ultimo_evento > desde) {
          base = punto.estado;
          desde = punto.ultimo_evento;
        }
      }
      let estado: RunState;
      if (base === null) {
        estado = rebuildState(eventos);
      } else {
        estado = base;
        eventos.slice(desde).forEach((evento: BatutaEvent): void => {
          estado = applyEvent(estado, evento);
        });
      }
      if (esEstadoTerminal(estado.estado)) {
        await escrituraAtomica(
          this.fs,
          rutaEstado(this.dirBatuta, runId),
          JSON.stringify(estado),
        );
        return {
          estado,
          desdeCheckpoint: base !== null,
          colaDescartada: lectura.truncado,
          eventosReproducidos: eventos.length - desde,
        };
      }
      const reanudacion = parseEvent({
        version_esquema: 1,
        id: idEvento(eventos.length + 1),
        run_id: runId,
        ts: this.reloj.ahoraIso(),
        tipo: "ejecucion_reanudada",
        payload: { eventos_reproducidos: eventos.length - desde },
      });
      await this.fs.agregarArchivo(ruta, `${serializeEvent(reanudacion)}\n`);
      estado = applyEvent(estado, reanudacion);
      await escrituraAtomica(
        this.fs,
        rutaEstado(this.dirBatuta, runId),
        JSON.stringify(estado),
      );
      return {
        estado,
        desdeCheckpoint: base !== null,
        colaDescartada: lectura.truncado,
        eventosReproducidos: eventos.length - desde,
      };
    });
  }

  private async leerCheckpoint(
    runId: string,
    nombre: string,
  ): Promise<Checkpoint | null> {
    try {
      const texto = await this.fs.leerArchivo(
        join(dirCheckpoints(this.dirBatuta, runId), nombre),
      );
      return parseCheckpoint(JSON.parse(texto) as unknown);
    } catch {
      return null;
    }
  }
}
