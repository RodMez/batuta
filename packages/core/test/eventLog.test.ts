import { describe, expect, it } from "vitest";
import {
  leerRegistro,
  leerTextoRegistro,
  rutaEventos,
  serializeEvent,
  type BatutaEvent,
} from "../src/index.js";
import { SistemaArchivosMemoria } from "./helpers.js";

function eventoBase(sobrescribe: Partial<BatutaEvent> = {}): BatutaEvent {
  return {
    version_esquema: 1,
    id: "E-000001",
    run_id: "RUN-2026-10-09-001",
    ts: "2026-10-09T12:00:00.000Z",
    tipo: "ejecucion_iniciada",
    payload: {},
    ...sobrescribe,
  };
}

describe("lector del registro (CA-2)", () => {
  it("lee líneas válidas en orden", () => {
    const texto = [
      serializeEvent(eventoBase()),
      serializeEvent(
        eventoBase({ id: "E-000002", tipo: "spec_creada" }),
      ),
    ].join("\n").concat("\n");
    const lectura = leerTextoRegistro(texto);
    expect(lectura.truncado).toBe(false);
    expect(lectura.eventos.map((e) => e.id)).toEqual(["E-000001", "E-000002"]);
  });

  it("descarta la última línea cortada e informa", () => {
    const texto = `${serializeEvent(eventoBase())}\n{"id": "E-000002", "incom`;
    const lectura = leerTextoRegistro(texto);
    expect(lectura.truncado).toBe(true);
    expect(lectura.eventos).toHaveLength(1);
  });

  it("un registro con una sola línea cortada queda vacío pero truncado", () => {
    const lectura = leerTextoRegistro('{"id": "cort');
    expect(lectura).toEqual({ eventos: [], truncado: true });
  });

  it("un registro vacío no está truncado", () => {
    expect(leerTextoRegistro("")).toEqual({ eventos: [], truncado: false });
  });

  it("una línea inválida en medio falla con su número", () => {
    const texto = [
      serializeEvent(eventoBase()),
      "{no es json}",
      serializeEvent(eventoBase({ id: "E-000003", tipo: "plan_creado" })),
    ].join("\n").concat("\n");
    expect(() => leerTextoRegistro(texto)).toThrow(/línea 2/);
  });

  it("una línea con tipo desconocido falla con su número y la ruta", () => {
    const texto = [
      serializeEvent(eventoBase()),
      JSON.stringify({ ...eventoBase(), id: "E-000002", tipo: "inexistente" }),
    ].join("\n").concat("\n");
    expect(() => leerTextoRegistro(texto)).toThrow(/línea 2.*tipo/);
  });

  it("leer en disco tolera la cola cortada y falla en medio", async () => {
    const fs = new SistemaArchivosMemoria();
    const ruta = rutaEventos(".batuta", "RUN-2026-10-09-001");
    await fs.escribirArchivo(ruta, `${serializeEvent(eventoBase())}\n{"id":`);
    const lectura = await leerRegistro(fs, ruta);
    expect(lectura.truncado).toBe(true);
    expect(lectura.eventos).toHaveLength(1);
  });

  it("un registro inexistente en disco equivale a vacío", async () => {
    const fs = new SistemaArchivosMemoria();
    const lectura = await leerRegistro(fs, rutaEventos(".batuta", "RUN-x"));
    expect(lectura).toEqual({ eventos: [], truncado: false });
  });
});
