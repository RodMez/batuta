import { describe, expect, it } from "vitest";
import { CLI_VERSION, createProgram } from "../src/index.js";
import {
  CODIGO_PAUSA_APROBACION,
  CODIGO_PAUSA_CUOTA,
  CODIGO_PAUSA_ENTRADA,
  presentarResultado,
} from "../src/salida.js";

describe("@batuta/cli", () => {
  it("expone la versión de la CLI sincronizada con el núcleo", () => {
    expect(CLI_VERSION).toBe("0.1.0");
    const program = createProgram();
    expect(program.version()).toBe("0.1.0");
  });

  it("responde con la versión al pasar la opción --version", () => {
    const program = createProgram();
    program.exitOverride();

    let output = "";
    program.configureOutput({
      writeOut: (str) => {
        output += str;
      },
    });

    expect(() => {
      program.parse(["node", "batuta", "--version"]);
    }).toThrow();

    expect(output.trim()).toBe("0.1.0");
  });

  it("pausa por cuota (12) es pausa normal como 10/11, no error fatal (G-03)", () => {
    const pausa = presentarResultado(
      { resultado: "pausa-cuota", runId: "RUN-1", resetTime: null, bucketIds: [] },
      ".batuta",
    );
    expect(pausa.codigo).toBe(CODIGO_PAUSA_CUOTA);
    expect(pausa.codigo).toBe(12);
    // Los 3 códigos de pausa van por stdout en actuar(), no por stderr.
    for (const codigo of [CODIGO_PAUSA_APROBACION, CODIGO_PAUSA_ENTRADA, CODIGO_PAUSA_CUOTA]) {
      expect([0, 10, 11, 12]).toContain(codigo);
    }
  });
});
