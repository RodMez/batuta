import { describe, expect, it } from "vitest";
import {
  parsePlan,
  parseRunState,
  PlanSchema,
  RUN_STATUSES,
  RunStateSchema,
} from "../src/index.js";

describe("estado de la ejecución (CA-1)", () => {
  it("expone el esquema de estado", () => {
    expect(RunStateSchema).toBeDefined();
  });

  it("cubre los estados del ciclo de vida de la sección 4", () => {
    expect(RUN_STATUSES).toEqual(
      expect.arrayContaining([
        "INTAKE",
        "SPEC",
        "PLAN",
        "IMPLEMENT",
        "VERIFY",
        "RETRY",
        "DEBUG",
        "CHECKPOINT",
        "REVIEW",
        "FINALIZE",
        "DONE",
        "FAILED",
        "ABORTED",
        "WAITING_INPUT",
        "AWAITING_APPROVAL",
      ]),
    );
  });

  it("acepta un estado válido con valores por defecto", () => {
    expect(
      parseRunState({ run_id: "RUN-2026-10-09-001", estado: "IMPLEMENT" }),
    ).toMatchObject({
      version_esquema: 1,
      run_id: "RUN-2026-10-09-001",
      estado: "IMPLEMENT",
      presupuesto_acumulado_usd: 0,
      modelo_activo: null,
    });
  });

  it("rechaza un estado desconocido indicando la ruta", () => {
    expect(() =>
      parseRunState({ run_id: "RUN-2026-10-09-001", estado: "INVENTADO" }),
    ).toThrow(/estado/);
  });

  it("AWAITING_APPROVAL exige puerta pendiente e indica su ruta (CA-7)", () => {
    const espera = parseRunState({
      run_id: "RUN-2026-10-09-001",
      estado: "AWAITING_APPROVAL",
      puerta_pendiente: "H1",
    });
    expect(espera.puerta_pendiente).toBe("H1");
    expect(() =>
      parseRunState({
        run_id: "RUN-2026-10-09-001",
        estado: "AWAITING_APPROVAL",
      }),
    ).toThrow(/puerta_pendiente/);
    expect(() =>
      parseRunState({
        run_id: "RUN-2026-10-09-001",
        estado: "AWAITING_APPROVAL",
        puerta_pendiente: "H9",
      }),
    ).toThrow(/puerta_pendiente/);
    expect(() =>
      parseRunState({
        run_id: "RUN-2026-10-09-001",
        estado: "SPEC",
        puerta_pendiente: "H1",
      }),
    ).toThrow(/puerta_pendiente/);
  });
});

describe("plan (CA-1)", () => {
  it("expone el esquema de plan", () => {
    expect(PlanSchema).toBeDefined();
  });

  it("acepta un plan válido con archivos, criterios y complejidad", () => {
    const plan = parsePlan({
      spec_id: "SPEC-001",
      subtareas: [
        {
          id: "SUB-01",
          titulo: "Añadir pruebas de rutas",
          archivos: ["src/routes.ts"],
          criterios: ["CA-1"],
          complejidad: "media",
        },
      ],
    });
    expect(plan.subtareas).toHaveLength(1);
    expect(plan.subtareas[0]?.complejidad).toBe("media");
  });

  it("rechaza subtareas con id repetido indicando la ruta", () => {
    expect(() =>
      parsePlan({
        subtareas: [
          {
            id: "SUB-01",
            titulo: "Una",
            archivos: ["a.ts"],
            criterios: ["CA-1"],
            complejidad: "baja",
          },
          {
            id: "SUB-01",
            titulo: "Otra",
            archivos: ["b.ts"],
            criterios: ["CA-2"],
            complejidad: "alta",
          },
        ],
      }),
    ).toThrow(/subtareas/);
  });

  it("rechaza una complejidad desconocida indicando la ruta", () => {
    expect(() =>
      parsePlan({
        subtareas: [
          {
            id: "SUB-01",
            titulo: "Una",
            archivos: ["a.ts"],
            criterios: ["CA-1"],
            complejidad: "extrema",
          },
        ],
      }),
    ).toThrow(/complejidad/);
  });
});
