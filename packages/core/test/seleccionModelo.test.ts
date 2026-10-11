import { describe, expect, it } from "vitest";
import {
  NotificadorNulo,
  firmaFallo,
  parseBatutaConfig,
  recortarInformeFallo,
  seleccionarModelo,
  type ResultadoGate,
} from "../src/index.js";

function configPrueba() {
  return parseBatutaConfig({
    proyecto: "repo",
    gates: [{ nombre: "lint", comando: "npm run lint", timeout_seg: 60 }],
    alias_modelos: {
      rapido: { modelo: "m-rapido", ventana: 100_000 },
      medio: { modelo: "m-medio", ventana: 100_000 },
      fuerte: { modelo: "m-fuerte", ventana: 200_000 },
      revisor: { modelo: "m-revisor", ventana: 100_000 },
    },
    modelos: {
      scout: "rapido",
      resumenes: "rapido",
      architect: "fuerte",
      "software-engineer": { baja: "rapido", media: "medio", alta: "fuerte" },
      debugger: "fuerte",
      revisores: "revisor",
    },
  });
}

describe("seleccionarModelo (CA-15)", () => {
  it("cubre la tabla de rol, complejidad e intento", () => {
    const config = configPrueba();

    // software-engineer según complejidad en intento 1
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "baja", intento: 1, config }),
    ).toMatchObject({ alias: "rapido", modelo: "m-rapido" });
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "media", intento: 1, config }),
    ).toMatchObject({ alias: "medio", modelo: "m-medio" });
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "alta", intento: 1, config }),
    ).toMatchObject({ alias: "fuerte", modelo: "m-fuerte" });

    // Segundo intento sube un nivel
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "baja", intento: 2, config }),
    ).toMatchObject({ alias: "medio" });
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "media", intento: 2, config }),
    ).toMatchObject({ alias: "fuerte" });
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "alta", intento: 2, config }),
    ).toMatchObject({ alias: "fuerte" });

    // Sin escalado se mantiene el modelo base
    const sinEscalar = { ...config, escalar_modelo_en_reintento: false };
    expect(
      seleccionarModelo({ rol: "software-engineer", complejidad: "baja", intento: 2, config: sinEscalar }),
    ).toMatchObject({ alias: "rapido" });

    // debugger siempre con el modelo fuerte
    expect(
      seleccionarModelo({ rol: "debugger", intento: 1, config }),
    ).toMatchObject({ alias: "fuerte", modelo: "m-fuerte" });
    expect(
      seleccionarModelo({ rol: "debugger", intento: 3, config }),
    ).toMatchObject({ alias: "fuerte" });

    // Roles fijos y revisores
    expect(seleccionarModelo({ rol: "scout", intento: 1, config })).toMatchObject({
      alias: "rapido",
    });
    expect(seleccionarModelo({ rol: "architect", intento: 1, config })).toMatchObject({
      alias: "fuerte",
    });
    expect(
      seleccionarModelo({ rol: "code-reviewer", intento: 1, config }),
    ).toMatchObject({ alias: "revisor", modelo: "m-revisor" });
    expect(
      seleccionarModelo({ rol: "security-reviewer", intento: 1, config }),
    ).toMatchObject({ alias: "revisor" });
  });
});

describe("recortarInformeFallo y firmaFallo", () => {
  it("recorta gate con comando, código y últimas líneas con tamaño máximo", () => {
    const gate: ResultadoGate = {
      nombre: "tests",
      comando: "npm test",
      resultado: "falla",
      codigo_salida: 1,
      duracion_ms: 50,
      timeout_vencido: false,
      salida_estandar: `${"línea ok\n".repeat(50)}ERROR final esperado\notra línea`,
      salida_error: "",
    };
    const informe = recortarInformeFallo({ tipo: "gate", gate });
    expect(informe).toContain("Gate: tests");
    expect(informe).toContain("Comando: npm test");
    expect(informe).toContain("Código de salida: 1");
    expect(informe).toContain("ERROR final esperado");
    expect(informe.length).toBeLessThanOrEqual(2000);
  });

  it("la misma salida produce la misma firma y distinta salida otra firma", () => {
    const gate = (salida: string): ResultadoGate => ({
      nombre: "lint",
      comando: "npm run lint",
      resultado: "falla",
      codigo_salida: 1,
      duracion_ms: 10,
      timeout_vencido: false,
      salida_estandar: salida,
      salida_error: "",
    });
    const a = firmaFallo({ tipo: "gate", gate: gate("ERROR x\nlínea 2") });
    const b = firmaFallo({ tipo: "gate", gate: gate("ERROR x\nlínea 2") });
    const c = firmaFallo({ tipo: "gate", gate: gate("ERROR distinto") });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("las violaciones de diff generan informe y firma estables", () => {
    const fallo = {
      tipo: "diff" as const,
      violaciones: [
        { tipo: "ruta_prohibida" as const, archivo: ".env", mensaje: "prohibido" },
      ],
    };
    const informe = recortarInformeFallo(fallo);
    expect(informe).toContain("ruta_prohibida");
    expect(informe).toContain(".env");
    expect(firmaFallo(fallo)).toBe(firmaFallo(fallo));
  });
});

describe("NotificadorNulo", () => {
  it("descarta los avisos sin fallar", async () => {
    const nulo = new NotificadorNulo();
    await expect(
      nulo.notificar({ tipo: "fallo", runId: "RUN-1", mensaje: "hola" }),
    ).resolves.toBeUndefined();
  });
});
