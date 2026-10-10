import { describe, expect, it } from "vitest";
import {
  crearPayloadGate,
  ejecutarGates,
  GateEjecutadoPayloadSchema,
  InformeGatesSchema,
  type EjecutorComandos,
  type Gate,
  type OpcionesEjecucionComando,
  type ResultadoComando,
} from "../src/index.js";

/** Mock del ejecutor de comandos para pruebas deterministas y rápidas. */
class EjecutorMock implements EjecutorComandos {
  readonly llamadas: Array<{ comando: string; opciones?: OpcionesEjecucionComando }> = [];

  constructor(
    private readonly respuestas: Record<
      string,
      Partial<ResultadoComando>
    > = {},
  ) {}

  async ejecutar(
    comando: string,
    opciones?: OpcionesEjecucionComando,
  ): Promise<ResultadoComando> {
    this.llamadas.push({ comando, opciones });
    const respuesta = this.respuestas[comando] ?? {};

    return {
      codigoSalida: respuesta.codigoSalida ?? 0,
      salidaEstandar: respuesta.salidaEstandar ?? "",
      salidaError: respuesta.salidaError ?? "",
      duracionMs: respuesta.duracionMs ?? 10,
      timeoutVencido: respuesta.timeoutVencido ?? false,
      bytesDescartadosStdout: respuesta.bytesDescartadosStdout,
      bytesDescartadosStderr: respuesta.bytesDescartadosStderr,
    };
  }
}

describe("ejecutarGates (CA-7)", () => {
  const gatesPiloto: Gate[] = [
    { nombre: "lint", comando: "npm run lint", timeout_seg: 60 },
    { nombre: "tipos", comando: "npm run typecheck", timeout_seg: 60 },
    { nombre: "tests", comando: "npm test", timeout_seg: 120 },
  ];

  it("respeta el orden de los gates y valida el informe contra el esquema Zod (CA-7)", async () => {
    const ejecutor = new EjecutorMock({
      "npm run lint": { salidaEstandar: "lint ok" },
      "npm run typecheck": { salidaEstandar: "types ok" },
      "npm test": { salidaEstandar: "tests pass" },
    });

    const informe = await ejecutarGates(gatesPiloto, "/dir/proyecto", {
      ejecutor,
      entornoExtra: { DATABASE_URL: "file:./test.db" },
    });

    // Validar contra el esquema Zod
    expect(InformeGatesSchema.safeParse(informe).success).toBe(true);
    expect(informe.exito).toBe(true);
    expect(informe.gates).toHaveLength(3);

    // Orden respetado
    expect(ejecutor.llamadas.map((l) => l.comando)).toEqual([
      "npm run lint",
      "npm run typecheck",
      "npm test",
    ]);
    expect(informe.gates.map((g) => g.nombre)).toEqual(["lint", "tipos", "tests"]);
    expect(informe.gates.map((g) => g.resultado)).toEqual(["pasa", "pasa", "pasa"]);

    // Parámetros pasados correctamente
    expect(ejecutor.llamadas[0]?.opciones?.cwd).toBe("/dir/proyecto");
    expect(ejecutor.llamadas[0]?.opciones?.timeoutMs).toBe(60_000);
    expect(ejecutor.llamadas[2]?.opciones?.timeoutMs).toBe(120_000);
    expect(ejecutor.llamadas[0]?.opciones?.entornoExtra).toEqual({
      DATABASE_URL: "file:./test.db",
    });
    expect(ejecutor.llamadas[0]?.opciones?.shell).toBe(true);
    expect(ejecutor.llamadas[1]?.opciones?.shell).toBe(true);
    expect(ejecutor.llamadas[2]?.opciones?.shell).toBe(true);
  });

  it("se detiene en el primer fallo por defecto y no ejecuta los siguientes (CA-7)", async () => {
    const ejecutor = new EjecutorMock({
      "npm run lint": { salidaEstandar: "lint ok", codigoSalida: 0 },
      "npm run typecheck": {
        salidaError: "TS2322 error",
        codigoSalida: 2,
      },
      "npm test": { salidaEstandar: "tests pass", codigoSalida: 0 },
    });

    const informe = await ejecutarGates(gatesPiloto, "/dir/proyecto", {
      ejecutor,
    });

    expect(informe.exito).toBe(false);
    expect(informe.gates).toHaveLength(2);
    expect(informe.gates[0]?.resultado).toBe("pasa");
    expect(informe.gates[1]?.resultado).toBe("falla");
    expect(informe.gates[1]?.codigo_salida).toBe(2);

    // El tercer gate no fue ejecutado
    expect(ejecutor.llamadas).toHaveLength(2);
    expect(ejecutor.llamadas.map((l) => l.comando)).toEqual([
      "npm run lint",
      "npm run typecheck",
    ]);
  });

  it("permite continuar tras un fallo si la opción continuarTrasFallo es true (CA-7)", async () => {
    const ejecutor = new EjecutorMock({
      "npm run lint": { salidaError: "lint error", codigoSalida: 1 },
      "npm run typecheck": { salidaEstandar: "types ok", codigoSalida: 0 },
      "npm test": { salidaError: "test failed", timeoutVencido: true },
    });

    const informe = await ejecutarGates(gatesPiloto, "/dir/proyecto", {
      ejecutor,
      continuarTrasFallo: true,
    });

    expect(informe.exito).toBe(false);
    expect(informe.gates).toHaveLength(3);
    expect(ejecutor.llamadas).toHaveLength(3);

    expect(informe.gates[0]?.resultado).toBe("falla");
    expect(informe.gates[1]?.resultado).toBe("pasa");
    expect(informe.gates[2]?.resultado).toBe("falla");
    expect(informe.gates[2]?.timeout_vencido).toBe(true);
  });

  it("tipa el payload del evento gate_ejecutado y valida contra su esquema (CA-7)", async () => {
    const ejecutor = new EjecutorMock({
      "npm run lint": {
        salidaEstandar: "ok",
        salidaError: "",
        codigoSalida: 0,
        duracionMs: 1500,
        bytesDescartadosStdout: 50,
      },
    });

    const informe = await ejecutarGates([gatesPiloto[0]!], "/dir", { ejecutor });
    const gateRes = informe.gates[0]!;

    const payload = crearPayloadGate(gateRes);
    expect(GateEjecutadoPayloadSchema.safeParse(payload).success).toBe(true);

    expect(payload).toEqual({
      nombre: "lint",
      comando: "npm run lint",
      resultado: "pasa",
      codigo_salida: 0,
      duracion_ms: gateRes.duracion_ms,
      timeout_vencido: false,
      salida_estandar: "ok",
      salida_error: "",
      bytes_descartados_stdout: 50,
      bytes_descartados_stderr: undefined,
    });
  });

  it("una lista vacía de gates devuelve informe exitoso", async () => {
    const ejecutor = new EjecutorMock();
    const informe = await ejecutarGates([], "/dir", { ejecutor });

    expect(informe.exito).toBe(true);
    expect(informe.gates).toHaveLength(0);
    expect(ejecutor.llamadas).toHaveLength(0);
  });
});
