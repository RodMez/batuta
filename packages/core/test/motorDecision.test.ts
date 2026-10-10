import { describe, expect, it } from "vitest";
import { parseBatutaConfig, siguientePaso, type ProgresoMotor } from "../src/index.js";
import type { RunState } from "../src/index.js";

function configBase() {
  return parseBatutaConfig({
    proyecto: "repo",
    gates: [{ nombre: "ok", comando: "node -e \"1\"", timeout_seg: 30 }],
  });
}

function progresoBase(over: Partial<ProgresoMotor> = {}): ProgresoMotor {
  return {
    version: 1,
    runId: "RUN-2026-10-10-001",
    inicioIso: "2026-10-10T10:00:00.000Z",
    specHash: "s",
    planHash: "p",
    aprobaciones: {
      H0: { aprobada: false },
      H1: { aprobada: false },
      H2: { aprobada: false },
      H3: { aprobada: false },
    },
    subtareaIndice: 0,
    totalSubtareas: 2,
    subtareas: [],
    tokensAcumulados: 0,
    usdAcumulado: 0,
    usdDesconocido: false,
    advertenciaEmitida: false,
    preguntasUsadas: 0,
    usoPorRol: {},
    gatesFallidosGlobal: [],
    worktree: null,
    ...over,
  };
}

function estado(estadoName: RunState["estado"], puerta?: RunState["puerta_pendiente"]): RunState {
  return {
    version_esquema: 1,
    run_id: "RUN-2026-10-10-001",
    estado: estadoName,
    puerta_pendiente: puerta ?? null,
    presupuesto_acumulado_usd: 0,
    modelo_activo: null,
  };
}

describe("siguientePaso (pauta del planificador)", () => {
  it("pide H0 en INTAKE y emite spec cuando está aprobada", () => {
    const config = configBase();
    expect(siguientePaso(estado("INTAKE"), progresoBase(), config)).toEqual({
      paso: "solicitar-aprobacion",
      puerta: "H0",
    });
    const conH0 = progresoBase({ aprobaciones: { H0: { aprobada: true }, H1: { aprobada: false }, H2: { aprobada: false }, H3: { aprobada: false } } });
    expect(siguientePaso(estado("INTAKE"), conH0, config)).toEqual({ paso: "emitir-spec" });
  });

  it("respeta H2 opcional: con H2 deshabilitada va a subtareas", () => {
    const config = parseBatutaConfig({
      proyecto: "repo",
      gates: [{ nombre: "ok", comando: "node -e \"1\"", timeout_seg: 30 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: false },
    });
    expect(siguientePaso(estado("PLAN"), progresoBase(), config)).toEqual({
      paso: "ejecutar-subtarea",
      indice: 0,
    });
  });

  it("pide H2 en PLAN cuando está habilitada y sin aprobar", () => {
    const conH2 = parseBatutaConfig({
      proyecto: "repo",
      gates: [{ nombre: "ok", comando: "node -e \"1\"", timeout_seg: 30 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: true, H3_merge: false },
    });
    expect(siguientePaso(estado("PLAN"), progresoBase(), conH2)).toEqual({
      paso: "solicitar-aprobacion",
      puerta: "H2",
    });
    const aprobada = progresoBase({ aprobaciones: { H0: { aprobada: true }, H1: { aprobada: true }, H2: { aprobada: true, hash: "h" }, H3: { aprobada: false } } });
    expect(siguientePaso(estado("PLAN"), aprobada, conH2)).toEqual({
      paso: "ejecutar-subtarea",
      indice: 0,
    });
  });

  it("en espera devuelve la pausa sin bloquear", () => {
    const config = configBase();
    expect(
      siguientePaso(estado("AWAITING_APPROVAL", "H1"), progresoBase(), config),
    ).toEqual({ paso: "esperar-aprobacion", puerta: "H1" });
    expect(
      siguientePaso(
        estado("WAITING_INPUT"),
        progresoBase({ esperaEntrada: { pregunta: "¿?", subtareaId: "S1" } }),
        config,
      ),
    ).toEqual({ paso: "esperar-entrada", pregunta: "¿?" });
  });

  it("tras la última subtarea genera el cierre", () => {
    const config = configBase();
    const p = progresoBase({ subtareaIndice: 2, totalSubtareas: 2 });
    expect(siguientePaso(estado("CHECKPOINT"), p, config)).toEqual({ paso: "generar-cierre" });
  });

  it("la pausa H3 se decide en la función pura", () => {
    const conH3 = parseBatutaConfig({
      proyecto: "repo",
      gates: [{ nombre: "ok", comando: "node -e \"1\"", timeout_seg: 30 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: true },
    });
    const p = progresoBase({ subtareaIndice: 2, totalSubtareas: 2 });
    expect(siguientePaso(estado("FINALIZE"), p, conH3)).toEqual({
      paso: "solicitar-aprobacion",
      puerta: "H3",
    });
    const aprobada = progresoBase({
      subtareaIndice: 2,
      totalSubtareas: 2,
      aprobaciones: { H0: { aprobada: true }, H1: { aprobada: true }, H2: { aprobada: true }, H3: { aprobada: true } },
    });
    expect(siguientePaso(estado("FINALIZE"), aprobada, conH3)).toEqual({ paso: "generar-cierre" });
    const sinH3 = parseBatutaConfig({
      proyecto: "repo",
      gates: [{ nombre: "ok", comando: "node -e \"1\"", timeout_seg: 30 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: false },
    });
    expect(siguientePaso(estado("FINALIZE"), p, sinH3)).toEqual({ paso: "generar-cierre" });
  });
});
