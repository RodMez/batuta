import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeCodeRunner,
  crearContextoCaptura,
  crearInputCaptura,
  MODELO_CAPTURA_POR_DEFECTO,
  modeloCapturaDesdeEntorno,
  VARIABLES_MODELO_CAPTURA,
  type EjecutorComandos,
} from "../src/index.js";

const FIXTURAS = join(
  import.meta.dirname,
  "fixtures",
  "claude-outputs",
  "sinteticos",
);

describe("script de captura (humo con claude falso)", () => {
  it("el modelo se lee de BATUTA_MODELO con valor por defecto", () => {
    expect(modeloCapturaDesdeEntorno({})).toBe(MODELO_CAPTURA_POR_DEFECTO);
    expect(modeloCapturaDesdeEntorno({ BATUTA_MODELO: "mi-modelo-proxy" })).toBe(
      "mi-modelo-proxy",
    );
    expect(modeloCapturaDesdeEntorno({ BATUTA_MODELO: "  " })).toBe(
      MODELO_CAPTURA_POR_DEFECTO,
    );
    expect(MODELO_CAPTURA_POR_DEFECTO).toBe("claude-haiku-5-5");
  });

  it("reenvía clave de API y base del proxy como variables de modelo", () => {
    expect(VARIABLES_MODELO_CAPTURA).toContain("ANTHROPIC_API_KEY");
    expect(VARIABLES_MODELO_CAPTURA).toContain("ANTHROPIC_BASE_URL");
  });

  it("el contexto usa PermisosRol con soloLectura para architect", () => {
    const contexto = crearContextoCaptura("/tmp/repo", "mi-modelo");
    expect(contexto.rol).toBe("architect");
    expect(contexto.modelo).toBe("mi-modelo");
    expect(contexto.permisos.soloLectura).toBe(true);
    expect(contexto.permisos.comandosPermitidos).toBeUndefined();
    // Sin restos de la forma antigua { lectura, escritura }
    expect(contexto.permisos).not.toHaveProperty("lectura");
    expect(contexto.permisos).not.toHaveProperty("escritura");
    expect(contexto.directorioTrabajo).toBe("/tmp/repo");
  });

  it("la entrada de captura cumple el contrato AgentInput", () => {
    const input = crearInputCaptura();
    expect(input.agent_role).toBe("architect");
    expect(input.max_steps).toBeGreaterThan(0);
    expect(input.budget_limit_usd).toBeGreaterThan(0);
    expect(input.task_id).toBe("CAPTURE-01");
  });

  it("ejecuta el runner con un claude falso sin red ni secretos", async () => {
    const salidaExitosa = await readFile(join(FIXTURAS, "exito.json"), "utf8");
    const ejecutorFalso: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado en captura");
      },
      ejecutarArgs: async (bin, args, opciones) => {
        expect(bin).toBe("claude");
        // El prompt va tras `--` para no confundirse con flags
        expect(args[args.length - 2]).toBe("--");
        // Solo lectura: sin Bash ni Edit en --tools
        const idx = args.indexOf("--tools");
        expect(args[idx + 1]).toBe("Read,Grep,Glob");
        expect(opciones?.entornoExtra?.["MI_SECRETO"]).toBeUndefined();
        return {
          codigoSalida: 0,
          salidaEstandar: salidaExitosa,
          salidaError: "",
          duracionMs: 20,
          timeoutVencido: false,
        };
      },
    };

    const config = {
      proyecto: "repo",
      gates: [{ nombre: "noop", comando: "node -e \"1\"", timeout_seg: 30 }],
      variables_modelo: [...VARIABLES_MODELO_CAPTURA],
    } as unknown as import("../src/index.js").BatutaConfig;

    const runner = new ClaudeCodeRunner(ejecutorFalso, config);
    const input = { ...crearInputCaptura(), max_steps: 10 };
    const contexto = {
      ...crearContextoCaptura("/tmp/repo", "modelo-falso"),
      limites: { budgetLimitUsd: 0.05, maxSteps: 10, timeoutMs: 30_000 },
    };
    const res = await runner.ejecutar(input, contexto);
    expect(res.exito).toBe(true);
    expect(res.output?.status).toBe("SUCCESS");
  });
});
