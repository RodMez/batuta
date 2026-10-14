import { describe, expect, it } from "vitest";
import {
  evaluarCuota,
  obtenerBucketsParaModelo,
  parsearRespuestaUso,
  CuotaManager,
} from "../src/cuotaManager.js";
import { EjecutorComandos } from "../src/commandRunner.js";

const FIXTURE_USAGE_REAL = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "...",
  command: {
    name: "usage",
    data: {
      description: "Limits test",
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.8355071544647217,
              reset_time: "2026-10-15T05:21:27Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9687673449516296,
              reset_time: "2026-10-14T05:24:32Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.001422800007276237,
              reset_time: "2026-10-15T05:20:12Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9770287871360779,
              reset_time: "2026-10-14T05:34:28Z",
            },
            {
              id: "nuevo-bucket-futuro",
              remaining_fraction: 0.5,
              extra_data: "desconocido",
            },
          ],
        },
      ],
    },
  },
});

describe("Módulo de Cuotas (cuotaManager)", () => {
  it("mapea nombres de modelos a sus buckets correspondientes", () => {
    expect(obtenerBucketsParaModelo("gemini-3.8-flash-low")).toEqual([
      "gemini-5h",
      "gemini-weekly",
    ]);
    expect(obtenerBucketsParaModelo("claude-sonnet-4-6")).toEqual([
      "3p-5h",
      "3p-weekly",
    ]);
    expect(obtenerBucketsParaModelo("claude-opus-4-6-thinking")).toEqual([
      "3p-5h",
      "3p-weekly",
    ]);
    expect(obtenerBucketsParaModelo("gpt-oss-120b-medium")).toEqual([
      "3p-5h",
      "3p-weekly",
    ]);
  });

  it("parsea la respuesta real de /usage tolerando campos nuevos y buckets desconocidos", () => {
    const buckets = parsearRespuestaUso(FIXTURE_USAGE_REAL);
    expect(buckets.length).toBe(5);
    const semanal3p = buckets.find((b) => b.id === "3p-weekly");
    expect(semanal3p).toBeDefined();
    expect(semanal3p?.remaining_fraction).toBeCloseTo(0.00142, 4);
    expect(semanal3p?.reset_time).toBe("2026-10-15T05:20:12Z");
  });

  it("evalúa cuota proactiva: detecta 0.0014 bajo el umbral 0.05 y escoge el reset_time más tardío", () => {
    const buckets = parsearRespuestaUso(FIXTURE_USAGE_REAL);

    // Con umbral de 0.05, 3p-weekly (0.0014) está por debajo
    const evaluacion3p = evaluarCuota(buckets, "claude-sonnet-4-6", 0.05);
    expect(evaluacion3p.suficiente).toBe(false);
    expect(evaluacion3p.bucketsBajoUmbral.length).toBe(1);
    expect(evaluacion3p.bucketsBajoUmbral[0].id).toBe("3p-weekly");
    expect(evaluacion3p.resetTimeMasTardio).toBe("2026-10-15T05:20:12Z");

    // Con umbral de 0.001, 0.0014 está por encima
    const evaluacionPermisiva = evaluarCuota(buckets, "claude-sonnet-4-6", 0.001);
    expect(evaluacionPermisiva.suficiente).toBe(true);
    expect(evaluacionPermisiva.bucketsBajoUmbral.length).toBe(0);

    // Gemini tiene ~83% y ~96%, supera con creces el 0.05
    const evaluacionGemini = evaluarCuota(buckets, "gemini-3.8-flash-low", 0.05);
    expect(evaluacionGemini.suficiente).toBe(true);
    expect(evaluacionGemini.bucketsBajoUmbral.length).toBe(0);
  });

  it("selecciona el reset_time más tardío cuando dos buckets están bajo el umbral", () => {
    const bucketsSimulados = [
      {
        id: "3p-5h",
        remaining_fraction: 0.02,
        reset_time: "2026-10-14T05:00:00Z",
      },
      {
        id: "3p-weekly",
        remaining_fraction: 0.01,
        reset_time: "2026-10-15T12:00:00Z", // Este es el más tardío
      },
    ];

    const res = evaluarCuota(bucketsSimulados, "claude-sonnet-4-6", 0.05);
    expect(res.suficiente).toBe(false);
    expect(res.bucketsBajoUmbral.length).toBe(2);
    expect(res.resetTimeMasTardio).toBe("2026-10-15T12:00:00Z");
  });

  it("CuotaManager lanza error real si la llamada a /usage falla", async () => {
    const simulador: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: 1,
        salidaEstandar: "",
        salidaError: "Error de red al consultar cuota",
        duracionMs: 100,
        timeoutVencido: false,
      }),
      ejecutar: async () => ({
        codigoSalida: 1,
        salidaEstandar: "",
        salidaError: "Error de red al consultar cuota",
        duracionMs: 100,
        timeoutVencido: false,
      }),
    };

    const manager = new CuotaManager({ ejecutor: simulador });
    await expect(manager.consultarBuckets()).rejects.toThrow(
      "Error al consultar /usage de agy (código 1): Error de red al consultar cuota",
    );
  });

  it("CuotaManager cachea resultados y los invalida cuando se pide forzar fresca", async () => {
    let llamadas = 0;
    const simulador: EjecutorComandos = {
      ejecutarArgs: async () => {
        llamadas++;
        return {
          codigoSalida: 0,
          salidaEstandar: FIXTURE_USAGE_REAL,
          salidaError: "",
          duracionMs: 10,
          timeoutVencido: false,
        };
      },
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const manager = new CuotaManager({
      ejecutor: simulador,
      cacheTtlMs: 5000,
    });

    await manager.verificarCuotaModelo("gemini-3.8-flash-low");
    expect(llamadas).toBe(1);

    // Segunda llamada dentro del TTL no repite invocación
    await manager.verificarCuotaModelo("gemini-3.8-flash-low");
    expect(llamadas).toBe(1);

    // Forzar fresca sí invoca
    await manager.verificarCuotaModelo("gemini-3.8-flash-low", 0.05, true);
    expect(llamadas).toBe(2);
  });
});
