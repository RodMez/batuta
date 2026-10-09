import { describe, expect, it } from "vitest";
import {
  EventSchema,
  parseEvent,
  parseEventLine,
  serializeEvent,
} from "../src/index.js";

const EVENTO_VALIDO = {
  id: "evt-001",
  run_id: "RUN-2026-10-09-001",
  ts: "2026-10-09T12:00:00Z",
  tipo: "gate_ejecutado",
  paso: "SUB-01",
  agente: "software-engineer",
  payload: { gate: "lint", ok: true },
  parent_id: "evt-000",
} as const;

describe("registro de eventos (CA-1, CA-5)", () => {
  it("expone el esquema de evento", () => {
    expect(EventSchema).toBeDefined();
  });

  it("una línea del registro se serializa y se vuelve a leer validada", () => {
    const leido = parseEventLine(serializeEvent({ ...EVENTO_VALIDO }));
    expect(leido).toMatchObject({
      id: "evt-001",
      run_id: "RUN-2026-10-09-001",
      tipo: "gate_ejecutado",
      paso: "SUB-01",
    });
    expect(leido.payload).toEqual({ gate: "lint", ok: true });
  });

  it("aplica valores por defecto de versión y payload", () => {
    const minimo = parseEvent({
      id: "evt-002",
      run_id: "RUN-2026-10-09-001",
      ts: "2026-10-09T12:00:00Z",
      tipo: "ejecucion_iniciada",
    });
    expect(minimo.version_esquema).toBe(1);
    expect(minimo.payload).toEqual({});
  });

  it("un tipo de evento desconocido se rechaza indicando la ruta", () => {
    const linea = JSON.stringify({ ...EVENTO_VALIDO, tipo: "tipo_inexistente" });
    expect(() => parseEventLine(linea)).toThrow(/tipo/);
  });

  it("una línea que no es JSON falla con mensaje claro", () => {
    expect(() => parseEventLine("{no es json")).toThrow(/JSON/);
  });
});
