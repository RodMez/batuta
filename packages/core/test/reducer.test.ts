import { describe, expect, it } from "vitest";
import {
  applyEvent,
  estadoInicial,
  rebuildState,
  type BatutaEvent,
} from "../src/index.js";

const RUN = "RUN-2026-10-09-001";
const TS = "2026-10-09T12:00:00.000Z";

let contador = 0;

function evento(
  tipo: BatutaEvent["tipo"],
  extra: Partial<BatutaEvent> = {},
): BatutaEvent {
  contador += 1;
  return {
    version_esquema: 1,
    id: `E-${String(contador).padStart(6, "0")}`,
    run_id: RUN,
    ts: TS,
    tipo,
    payload: {},
    ...extra,
  };
}

function oportunidad(): BatutaEvent {
  return evento("ejecucion_iniciada");
}

describe("reductor puro (CA-3, CA-4)", () => {
  it("reconstruye el ciclo de vida con reintento, entrada y aprobación", () => {
    const eventos: BatutaEvent[] = [
      oportunidad(),
      evento("aprobacion_solicitada", { payload: { puerta: "H0" } }),
      evento("aprobacion_otorgada", { payload: { puerta: "H0" } }),
      evento("spec_creada"),
      evento("aprobacion_solicitada", { payload: { puerta: "H1" } }),
      evento("aprobacion_otorgada", { payload: { puerta: "H1" } }),
      evento("plan_creado"),
      evento("subtarea_iniciada"),
      evento("agente_completado", {
        payload: { costo_usd: 0.4, modelo: "m-fuerte" },
      }),
      evento("gate_ejecutado"),
      evento("reintento_programado"),
      evento("subtarea_iniciada"),
      evento("agente_completado", {
        payload: { costo_usd: 0.6, modelo: "m-fuerte" },
      }),
      evento("checkpoint_creado"),
      evento("entrada_requerida"),
      evento("entrada_recibida", { payload: { retomar_en: "CHECKPOINT" } }),
      evento("revision_completada"),
      evento("pr_creada"),
      evento("aprobacion_solicitada", { payload: { puerta: "H3" } }),
      evento("aprobacion_otorgada", { payload: { puerta: "H3" } }),
      evento("ejecucion_completada"),
    ];
    const estado = rebuildState(eventos);
    expect(estado).toMatchObject({
      run_id: RUN,
      estado: "DONE",
      puerta_pendiente: null,
      presupuesto_acumulado_usd: 1,
      modelo_activo: "m-fuerte",
      actualizada_en: TS,
    });
  });

  it("el límite alcanzado interrumpe en FAILED", () => {
    const estado = rebuildState([
      oportunidad(),
      evento("limite_alcanzado", { payload: { limite: "tokens_por_ejecucion" } }),
    ]);
    expect(estado.estado).toBe("FAILED");
  });

  it("admite campos extra en los payloads tipados", () => {
    const trasSubtarea = applyEvent(
      rebuildState([oportunidad(), evento("spec_creada"), evento("plan_creado")]),
      evento("subtarea_iniciada"),
    );
    expect(trasSubtarea.estado).toBe("IMPLEMENT");
    const verificado = applyEvent(trasSubtarea, evento("agente_completado", {
      payload: { costo_usd: 1, modelo: "m", tokens: 500 },
    }));
    expect(verificado.presupuesto_acumulado_usd).toBe(1);
  });

  it("rechaza el plan creado directamente en INTAKE", () => {
    expect(() =>
      rebuildState([oportunidad(), evento("plan_creado")]),
    ).toThrow(/Transición imposible.*plan_creado.*INTAKE/);
  });

  it("rechaza un segundo ejecucion_iniciada y un inicio ausente", () => {
    expect(() =>
      applyEvent(estadoInicial(RUN), oportunidad()),
    ).toThrow(/primer evento/);
    expect(() => rebuildState([evento("spec_creada")])).toThrow(
      /primer evento debe ser ejecucion_iniciada/,
    );
    expect(() => rebuildState([])).toThrow(/Registro vacío/);
  });

  it("rechaza eventos tras el terminal y run_id ajeno", () => {
    const hecho = rebuildState([
      oportunidad(),
      evento("ejecucion_fallida"),
    ]);
    expect(hecho.estado).toBe("FAILED");
    expect(() => applyEvent(hecho, evento("spec_creada"))).toThrow(
      /terminó en FAILED/,
    );
    expect(() =>
      applyEvent(estadoInicial(RUN), evento("spec_creada", { run_id: "RUN-otra" })),
    ).toThrow(/run_id/);
  });

  it("rechaza aprobaciones incoherentes", () => {
    expect(() =>
      rebuildState([
        oportunidad(),
        evento("aprobacion_solicitada", { payload: { puerta: "H1" } }),
      ]),
    ).toThrow(/corresponde pedir H0/);
    expect(() =>
      rebuildState([
        oportunidad(),
        evento("aprobacion_solicitada", { payload: { puerta: "H0" } }),
        evento("aprobacion_otorgada", { payload: { puerta: "H1" } }),
      ]),
    ).toThrow(/pendiente es H0/);
    expect(() =>
      rebuildState([oportunidad(), evento("aprobacion_otorgada", { payload: { puerta: "H0" } })]),
    ).toThrow(/ninguna puerta pendiente/);
  });

  it("rechaza payloads tipados inválidos con su ruta", () => {
    const base = rebuildState([
      oportunidad(),
      evento("spec_creada"),
      evento("plan_creado"),
      evento("subtarea_iniciada"),
    ]);
    expect(() =>
      applyEvent(base, evento("agente_completado", { payload: { modelo: "m" } })),
    ).toThrow(/costo_usd/);
    expect(() =>
      applyEvent(
        applyEvent(base, evento("entrada_requerida")),
        evento("entrada_recibida", { payload: { retomar_en: "DONE" } }),
      ),
    ).toThrow(/terminal DONE/);
  });
});
