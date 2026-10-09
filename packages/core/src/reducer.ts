import { z } from "zod";
import type { BatutaEvent } from "./events.js";
import {
  PuertaSchema,
  RunStatusSchema,
  type Puerta,
  type RunState,
  type RunStatus,
} from "./state.js";
import { formatZodError } from "./validation.js";

/**
 * Payloads tipados que usa el reductor (cambios de estado, presupuesto,
 * modelo activo, aprobaciones y límites). Admiten campos extra para no
 * acoplarlos a hitos futuros; los eventos que el reductor no necesita
 * mantienen su payload libre.
 */
export const AprobacionPayloadSchema = z
  .strictObject({ puerta: PuertaSchema })
  .catchall(z.unknown());

export const AgenteCompletadoPayloadSchema = z
  .strictObject({
    costo_usd: z.number().min(0),
    modelo: z.string().min(1),
  })
  .catchall(z.unknown());

export const EntradaRecibidaPayloadSchema = z
  .strictObject({ retomar_en: RunStatusSchema })
  .catchall(z.unknown());

export const LimitePayloadSchema = z
  .strictObject({ limite: z.string().min(1) })
  .catchall(z.unknown());

export type AprobacionPayload = z.infer<typeof AprobacionPayloadSchema>;
export type AgenteCompletadoPayload = z.infer<
  typeof AgenteCompletadoPayloadSchema
>;
export type EntradaRecibidaPayload = z.infer<
  typeof EntradaRecibidaPayloadSchema
>;
export type LimitePayload = z.infer<typeof LimitePayloadSchema>;

const TERMINALES: readonly RunStatus[] = ["DONE", "FAILED", "ABORTED"];

/** Indica si un estado es terminal (DONE, FAILED o ABORTED). */
export function esEstadoTerminal(estado: RunStatus): boolean {
  return TERMINALES.includes(estado);
}

function esTerminal(estado: RunStatus): boolean {
  return esEstadoTerminal(estado);
}

/** Estado al que vuelve cada puerta tras ser otorgada (sección 4). */
function estadoDePuerta(puerta: Puerta): RunStatus {
  switch (puerta) {
    case "H0":
      return "INTAKE";
    case "H1":
      return "SPEC";
    case "H2":
      return "PLAN";
    case "H3":
      return "FINALIZE";
  }
}

/** Puerta que corresponde pedir en cada estado previo (sección 4). */
function puertaDeEstado(estado: RunStatus): Puerta | null {
  switch (estado) {
    case "INTAKE":
      return "H0";
    case "SPEC":
      return "H1";
    case "PLAN":
      return "H2";
    case "FINALIZE":
      return "H3";
    default:
      return null;
  }
}

function leerPayload<T>(
  esquema: z.ZodType<T>,
  evento: BatutaEvent,
): T {
  const resultado = esquema.safeParse(evento.payload);
  if (!resultado.success) {
    throw new Error(
      `Evento ${evento.id} (${evento.tipo}): payload inválido: ${formatZodError(resultado.error)}`,
    );
  }
  return resultado.data;
}

function imposible(evento: BatutaEvent, estado: RunState, ayuda: string): Error {
  return new Error(
    `Transición imposible: ${evento.tipo} no puede seguir a ${estado.estado} (evento ${evento.id}). ${ayuda}`,
  );
}

/** Estado inicial de una ejecución recién creada (función pura). */
export function estadoInicial(runId: string): RunState {
  return {
    version_esquema: 1,
    run_id: runId,
    estado: "INTAKE",
    puerta_pendiente: null,
    presupuesto_acumulado_usd: 0,
    modelo_activo: null,
  };
}

/**
 * Reductor puro `(estado, evento) => estado`: reconstruye el `RunState`
 * evento a evento sin leer reloj ni disco. Suma presupuestos (redondeados
 * a 6 decimales), fija el modelo activo y la puerta pendiente, sella cada
 * estado con el `ts` del evento y rechaza con un error explícito las
 * transiciones imposibles según la sección 4. `ejecucion_iniciada` solo
 * es válida como primer evento: se construye con `rebuildState`.
 */
export function applyEvent(estado: RunState, evento: BatutaEvent): RunState {
  if (evento.run_id !== estado.run_id) {
    throw new Error(
      `Evento ${evento.id}: run_id "${evento.run_id}" no coincide con la ejecución "${estado.run_id}"`,
    );
  }
  if (evento.tipo === "ejecucion_iniciada") {
    throw new Error(
      `Evento ${evento.id}: ejecucion_iniciada solo es válida como primer evento del registro`,
    );
  }
  if (esTerminal(estado.estado)) {
    throw imposible(
      evento,
      estado,
      `La ejecución terminó en ${estado.estado}.`,
    );
  }

  const base: RunState = {
    ...estado,
    actualizada_en: evento.ts,
  };

  switch (evento.tipo) {
    case "aprobacion_solicitada": {
      const esperada = puertaDeEstado(estado.estado);
      if (esperada === null) {
        throw imposible(
          evento,
          estado,
          "Las aprobaciones solo se piden en INTAKE, SPEC, PLAN o FINALIZE.",
        );
      }
      const { puerta } = leerPayload(AprobacionPayloadSchema, evento);
      if (puerta !== esperada) {
        throw imposible(
          evento,
          estado,
          `En ${estado.estado} corresponde pedir ${esperada}, no ${puerta}.`,
        );
      }
      return { ...base, estado: "AWAITING_APPROVAL", puerta_pendiente: puerta };
    }
    case "aprobacion_otorgada": {
      if (estado.estado !== "AWAITING_APPROVAL" || estado.puerta_pendiente === null) {
        throw imposible(evento, estado, "No hay ninguna puerta pendiente.");
      }
      const { puerta } = leerPayload(AprobacionPayloadSchema, evento);
      if (puerta !== estado.puerta_pendiente) {
        throw imposible(
          evento,
          estado,
          `La puerta pendiente es ${estado.puerta_pendiente}, no ${puerta}.`,
        );
      }
      return {
        ...base,
        estado: estadoDePuerta(puerta),
        puerta_pendiente: null,
      };
    }
    case "spec_creada": {
      if (estado.estado !== "INTAKE") throw imposible(evento, estado, "La spec se crea en INTAKE.");
      return { ...base, estado: "SPEC" };
    }
    case "plan_creado": {
      if (estado.estado !== "SPEC") throw imposible(evento, estado, "El plan se crea en SPEC.");
      return { ...base, estado: "PLAN" };
    }
    case "subtarea_iniciada": {
      if (
        estado.estado !== "PLAN" &&
        estado.estado !== "CHECKPOINT" &&
        estado.estado !== "RETRY" &&
        estado.estado !== "DEBUG"
      ) {
        throw imposible(
          evento,
          estado,
          "Una subtarea arranca en PLAN, CHECKPOINT, RETRY o DEBUG.",
        );
      }
      return { ...base, estado: "IMPLEMENT" };
    }
    case "agente_completado": {
      if (estado.estado !== "IMPLEMENT") {
        throw imposible(evento, estado, "El agente completa en IMPLEMENT.");
      }
      const { costo_usd, modelo } = leerPayload(
        AgenteCompletadoPayloadSchema,
        evento,
      );
      const acumulado =
        Math.round((estado.presupuesto_acumulado_usd + costo_usd) * 1_000_000) /
        1_000_000;
      return {
        ...base,
        estado: "VERIFY",
        presupuesto_acumulado_usd: acumulado,
        modelo_activo: modelo,
      };
    }
    case "gate_ejecutado": {
      if (estado.estado !== "VERIFY") throw imposible(evento, estado, "Los gates se ejecutan en VERIFY.");
      return base;
    }
    case "reintento_programado": {
      if (estado.estado !== "VERIFY") {
        throw imposible(evento, estado, "El reintento se programa en VERIFY.");
      }
      return { ...base, estado: "RETRY" };
    }
    case "depuracion_iniciada": {
      if (estado.estado !== "VERIFY" && estado.estado !== "RETRY") {
        throw imposible(
          evento,
          estado,
          "La depuración escala desde VERIFY o RETRY.",
        );
      }
      return { ...base, estado: "DEBUG" };
    }
    case "checkpoint_creado": {
      if (estado.estado !== "VERIFY") {
        throw imposible(evento, estado, "El checkpoint se guarda en VERIFY.");
      }
      return { ...base, estado: "CHECKPOINT" };
    }
    case "revision_completada": {
      if (estado.estado !== "CHECKPOINT") {
        throw imposible(evento, estado, "La revisión llega tras CHECKPOINT.");
      }
      return { ...base, estado: "REVIEW" };
    }
    case "pr_creada": {
      if (estado.estado !== "REVIEW") throw imposible(evento, estado, "El PR se crea en REVIEW.");
      return { ...base, estado: "FINALIZE" };
    }
    case "ejecucion_completada": {
      if (estado.estado !== "FINALIZE") {
        throw imposible(evento, estado, "La ejecución se completa en FINALIZE.");
      }
      return { ...base, estado: "DONE" };
    }
    case "ejecucion_fallida": {
      return { ...base, estado: "FAILED", puerta_pendiente: null };
    }
    case "ejecucion_abortada": {
      return { ...base, estado: "ABORTED", puerta_pendiente: null };
    }
    case "limite_alcanzado": {
      leerPayload(LimitePayloadSchema, evento);
      return { ...base, estado: "FAILED", puerta_pendiente: null };
    }
    case "entrada_requerida": {
      if (estado.estado === "WAITING_INPUT") {
        throw imposible(evento, estado, "Ya hay una espera de entrada abierta.");
      }
      if (estado.estado === "AWAITING_APPROVAL") {
        throw imposible(
          evento,
          estado,
          "Hay una puerta pendiente: no se puede abrir una espera de entrada sin resolverla.",
        );
      }
      return { ...base, estado: "WAITING_INPUT", puerta_pendiente: null };
    }
    case "entrada_recibida": {
      if (estado.estado !== "WAITING_INPUT") {
        throw imposible(evento, estado, "No hay ninguna espera de entrada abierta.");
      }
      const { retomar_en } = leerPayload(EntradaRecibidaPayloadSchema, evento);
      if (esTerminal(retomar_en)) {
        throw imposible(
          evento,
          estado,
          `No se puede retomar en el estado terminal ${retomar_en}.`,
        );
      }
      return { ...base, estado: retomar_en };
    }
    case "ejecucion_reanudada":
    case "contexto_resumido": {
      return base;
    }
  }
}

/**
 * Reconstruye el estado desde cero plegando el registro (función pura).
 * Exige un registro no vacío cuyo primer evento sea `ejecucion_iniciada`
 * y que todos los eventos pertenezcan a la misma ejecución.
 */
export function rebuildState(eventos: readonly BatutaEvent[]): RunState {
  const primero = eventos[0];
  if (primero === undefined) {
    throw new Error("Registro vacío: no se puede reconstruir el estado");
  }
  if (primero.tipo !== "ejecucion_iniciada") {
    throw new Error(
      `Registro inválido: el primer evento debe ser ejecucion_iniciada, no ${primero.tipo} (${primero.id})`,
    );
  }
  let estado: RunState = { ...estadoInicial(primero.run_id), actualizada_en: primero.ts };
  eventos.slice(1).forEach((evento: BatutaEvent): void => {
    estado = applyEvent(estado, evento);
  });
  return estado;
}
