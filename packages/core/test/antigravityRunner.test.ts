import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  AntigravityRunner,
  esWorktreeValido,
  LIMITE_LONGITUD_PROMPT_AGY,
  construirPromptCortoAgy,
  escribirContextoEnWorktree,
  sistemaArchivosNode,
} from "../src/index.js";
import { AgentInput, AgentOutput } from "../src/agentContract.js";
import { AgentCallContext } from "../src/agentRunner.js";
import { EjecutorComandos } from "../src/commandRunner.js";
import { CuotaManager } from "../src/cuotaManager.js";

const INPUT_TEST: AgentInput = {
  task_id: "tarea-1",
  agent_role: "software-engineer",
  spec_path: "spec.md",
  allowed_files: ["src/index.ts"],
  budget_limit_usd: 1.0,
  max_steps: 10,
};

const WORKTREE_DIR = join(tmpdir(), ".batuta", "worktrees", "run-123");

const CONTEXTO_TEST: AgentCallContext = {
  directorioTrabajo: WORKTREE_DIR,
  rol: "software-engineer",
  modelo: "gemini-3.8-flash-low",
  permisos: { soloLectura: false },
  prompt: "Implementa la función suma",
};

const OUTPUT_VALIDO: AgentOutput = {
  status: "SUCCESS",
  summary: "Función suma implementada",
  files_modified: ["src/index.ts"],
  reported_checks: [{ command: "npm test", exit_code: 0 }],
  continuation_notes: "",
  blocking_question: "",
};

describe("AntigravityRunner (Hito 8 - ADR 021)", () => {
  it("valida estrictamente que el cwd sea un hijo del directorio de worktrees", () => {
    // 1. Canónico por defecto (.batuta/worktrees/<run_id>)
    expect(esWorktreeValido("/repo/.batuta/worktrees/run-1")).toBe(true);
    expect(esWorktreeValido("C:\\repo\\.batuta\\worktrees\\run-1")).toBe(true);

    // Debe rechazar la carpeta raíz compartida de worktrees
    expect(esWorktreeValido("/repo/.batuta/worktrees")).toBe(false);
    expect(esWorktreeValido("/repo/.batuta/worktrees/")).toBe(false);
    expect(esWorktreeValido("C:\\repo\\.batuta\\worktrees")).toBe(false);

    // Debe rechazar rutas que no estén dentro de worktrees
    expect(esWorktreeValido("/repo")).toBe(false);
    expect(esWorktreeValido("C:\\Users\\admin\\Desktop\\batuta")).toBe(false);

    // 2. Con raíz de worktrees configurada (por ejemplo fuera del repo)
    const raizCustom = "/var/batuta/worktrees-compartidos";
    expect(esWorktreeValido("/var/batuta/worktrees-compartidos/run-456", raizCustom)).toBe(true);
    // La raíz misma se rechaza
    expect(esWorktreeValido(raizCustom, raizCustom)).toBe(false);
    // Escapes con .. se rechazan
    expect(esWorktreeValido("/var/batuta/worktrees-compartidos/../afuera", raizCustom)).toBe(false);
    // Rutas totalmente ajenas se rechazan
    expect(esWorktreeValido("/tmp/otro-lado", raizCustom)).toBe(false);
  });

  it("rechaza la ejecución si el directorio de trabajo no es un worktree válido hijo", async () => {
    const runner = new AntigravityRunner();
    const res = await runner.ejecutar(INPUT_TEST, {
      ...CONTEXTO_TEST,
      directorioTrabajo: join(tmpdir(), "directorio-inseguro"),
    });

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("error_proceso");
    expect(res.output).toBeNull();
  });

  it("rechaza la ejecución si el prompt supera el límite de longitud segura en Windows", async () => {
    const runner = new AntigravityRunner({ validarRutaWorktree: false });
    const promptGigante = "A".repeat(LIMITE_LONGITUD_PROMPT_AGY + 500);

    const res = await runner.ejecutar(INPUT_TEST, {
      ...CONTEXTO_TEST,
      prompt: promptGigante,
    });

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("error_proceso");
    expect(res.output).toBeNull();
  });

  it("escribe contexto en .batuta/contexto/ y construye prompt corto para agy", async () => {
    const dirBase = await mkdtemp(join(tmpdir(), "batuta-test-contexto-"));
    try {
      const resultadoContexto = await escribirContextoEnWorktree(
        sistemaArchivosNode,
        dirBase,
        {
          spec: "# Mi Spec\nObjetivo de la spec",
          plan: { subtareas: [{ id: "sub-1", titulo: "Tarea 1" }] },
          subtarea: {
            id: "sub-1",
            titulo: "Tarea 1",
            complejidad: "baja",
            archivos: ["src/index.ts"],
            criterios: ["criterio-1"],
          },
          ultimoInforme: "Fallo en gate test previo",
          reglasRepo: "Reglas del repositorio",
        },
      );

      expect(resultadoContexto.specRutaRel).toBe(".batuta/contexto/spec.md");
      expect(resultadoContexto.planRutaRel).toBe(".batuta/contexto/plan.json");
      expect(resultadoContexto.feedbackRutaRel).toBe(".batuta/contexto/feedback.md");

      const promptCorto = construirPromptCortoAgy(
        "software-engineer",
        {
          id: "sub-1",
          titulo: "Tarea 1",
          complejidad: "baja",
          archivos: ["src/index.ts"],
          criterios: ["criterio-1"],
        },
        {
          specRel: resultadoContexto.specRutaRel,
          planRel: resultadoContexto.planRutaRel,
          feedbackRel: resultadoContexto.feedbackRutaRel,
        },
      );

      // El prompt debe ser corto (muy por debajo de 500 caracteres)
      expect(promptCorto.length).toBeLessThan(500);
      expect(promptCorto).toContain('.batuta/contexto/spec.md');
      expect(promptCorto).toContain('.batuta/contexto/plan.json');
      expect(promptCorto).toContain('.batuta/contexto/feedback.md');
      expect(promptCorto).toContain('src/index.ts');
    } finally {
      await rm(dirBase, { recursive: true, force: true });
    }
  });

  it("ejecuta con éxito cuando structured_output es válido y reporta tokens", async () => {
    let argsCapturados: readonly string[] = [];

    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async (_ejecutable, args) => {
        argsCapturados = args;
        const salida = JSON.stringify({
          status: "SUCCESS",
          structured_output: OUTPUT_VALIDO,
          usage: {
            input_tokens: 15000,
            output_tokens: 120,
          },
          num_turns: 1,
        });
        return {
          codigoSalida: 0,
          salidaEstandar: salida,
          salidaError: "",
          duracionMs: 250,
          timeoutVencido: false,
        };
      },
      ejecutar: async () => {
        throw new Error("No debe llamar a ejecutar() con shell");
      },
    };

    // Mock de cuota que reporta suficiente
    const cuotaManagerMock = {
      verificarCuotaModelo: async () => ({
        suficiente: true,
        bucketsBajoUmbral: [],
        resetTimeMasTardio: null,
      }),
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(res.exito).toBe(true);
    expect(res.output).toEqual(OUTPUT_VALIDO);
    expect(res.uso.tokensEntrada).toBe(15000);
    expect(res.uso.tokensSalida).toBe(120);

    // Verificaciones estrictas de flags de seguridad en los argumentos
    expect(argsCapturados).toContain("--sandbox");
    expect(argsCapturados).not.toContain("--dangerously-skip-permissions");
    expect(argsCapturados).toContain("--output-format");
    expect(argsCapturados).toContain("json");
    expect(argsCapturados).toContain("--json-schema");
  });

  it("falla si status es SUCCESS pero structured_output está ausente (ADR 011)", async () => {
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: 0,
        // status externo es SUCCESS, pero falta structured_output
        salidaEstandar: JSON.stringify({
          status: "SUCCESS",
          response: "Tarea completada pero sin json de contrato",
        }),
        salidaError: "",
        duracionMs: 100,
        timeoutVencido: false,
      }),
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const cuotaManagerMock = {
      verificarCuotaModelo: async () => ({
        suficiente: true,
        bucketsBajoUmbral: [],
        resetTimeMasTardio: null,
      }),
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(res.exito).toBe(false);
    expect(res.output).toBeNull();
    expect(res.motivoFallo).toBe("salida_invalida");
  });

  it("detecta cuota agotada de forma proactiva y devuelve motivoFallo cuota_agotada", async () => {
    let ejecutoComando = false;
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => {
        ejecutoComando = true;
        return {
          codigoSalida: 0,
          salidaEstandar: "",
          salidaError: "",
          duracionMs: 0,
          timeoutVencido: false,
        };
      },
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const cuotaManagerMock = {
      verificarCuotaModelo: async () => ({
        suficiente: false,
        bucketsBajoUmbral: [
          {
            id: "3p-weekly",
            remaining_fraction: 0.0014,
            reset_time: "2026-10-15T05:20:12Z",
          },
        ],
        resetTimeMasTardio: "2026-10-15T05:20:12Z",
      }),
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("cuota_agotada");
    expect(ejecutoComando).toBe(false); // No debió lanzar la llamada al modelo
  });

  it("detecta cuota reactiva ante salida no-cero cuando /usage confirma agotamiento", async () => {
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: 1,
        salidaEstandar: "",
        salidaError: "Resource exhausted",
        duracionMs: 150,
        timeoutVencido: false,
      }),
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    let proactivaLlamada = false;
    const cuotaManagerMock = {
      verificarCuotaModelo: async (_modelo: string, _umbral: number, forzarFresca: boolean) => {
        if (!forzarFresca) {
          proactivaLlamada = true;
          return { suficiente: true, bucketsBajoUmbral: [], resetTimeMasTardio: null };
        }
        // Llamada reactiva con forzarFresca: true confirma agotamiento
        return {
          suficiente: false,
          bucketsBajoUmbral: [
            { id: "3p-5h", remaining_fraction: 0.0, reset_time: "2026-10-14T05:00:00Z" },
          ],
          resetTimeMasTardio: "2026-10-14T05:00:00Z",
        };
      },
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(proactivaLlamada).toBe(true);
    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("cuota_agotada");
  });

  it("trata salida no-cero como error_proceso si /usage falla o no reporta agotamiento", async () => {
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: 2,
        salidaEstandar: "",
        salidaError: "Syntax error in script",
        duracionMs: 100,
        timeoutVencido: false,
      }),
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const cuotaManagerMock = {
      verificarCuotaModelo: async (_m: string, _u: number, forzarFresca: boolean) => {
        if (forzarFresca) {
          // /usage falla con error real
          throw new Error("Fallo de red en usage");
        }
        return { suficiente: true, bucketsBajoUmbral: [], resetTimeMasTardio: null };
      },
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("error_proceso");
  });

  it("devuelve timeout si el ejecutor reporta timeoutVencido", async () => {
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: null,
        salidaEstandar: "",
        salidaError: "Command timed out",
        duracionMs: 5000,
        timeoutVencido: true,
      }),
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const cuotaManagerMock = {
      verificarCuotaModelo: async () => ({
        suficiente: true,
        bucketsBajoUmbral: [],
        resetTimeMasTardio: null,
      }),
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("timeout");
  });

  it("reintenta una sola vez ante salida inválida y devuelve éxito si el segundo intento es válido", async () => {
    let intento = 0;
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => {
        intento++;
        if (intento === 1) {
          return {
            codigoSalida: 0,
            salidaEstandar: JSON.stringify({
              status: "SUCCESS",
              structured_output: { status: "INVALIDO" }, // status inválido
            }),
            salidaError: "",
            duracionMs: 100,
            timeoutVencido: false,
          };
        }
        return {
          codigoSalida: 0,
          salidaEstandar: JSON.stringify({
            status: "SUCCESS",
            structured_output: OUTPUT_VALIDO,
          }),
          salidaError: "",
          duracionMs: 100,
          timeoutVencido: false,
        };
      },
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
    };

    const cuotaManagerMock = {
      verificarCuotaModelo: async () => ({
        suficiente: true,
        bucketsBajoUmbral: [],
        resetTimeMasTardio: null,
      }),
    } as unknown as CuotaManager;

    const runner = new AntigravityRunner(
      { validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    const res = await runner.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(intento).toBe(2);
    expect(res.reintentos).toBe(1);
    expect(res.exito).toBe(true);
    expect(res.output).toEqual(OUTPUT_VALIDO);
  });
});
