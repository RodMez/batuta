import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import {
  AntigravityRunner,
  esWorktreeValido,
  LIMITE_LONGITUD_PROMPT_AGY,
  obtenerVariablesSesionAgy,
  sanitizarTaskIdParaArchivo,
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

  it("esWorktreeValido no da falsos positivos con nombres con puntos ni raíz vacía", () => {
    // Nombres legítimos con puntos deben aceptarse en modo canónico.
    expect(esWorktreeValido("/repo/.batuta/worktrees/my..dir")).toBe(true);
    expect(esWorktreeValido("/repo/.batuta/worktrees/...")).toBe(true);
    expect(esWorktreeValido("/repo/.batuta/worktrees/..foo")).toBe(true);
    // Escape real por segmento debe rechazarse (sale de worktrees).
    expect(esWorktreeValido("/repo/.batuta/worktrees/../afuera")).toBe(false);
    // Raíz vacía se trata como no especificada (canónico).
    expect(esWorktreeValido("/repo/.batuta/worktrees/run-1", "")).toBe(true);
  });

  it("sanitizarTaskIdParaArchivo confina nombres de log (H-A1)", () => {
    expect(sanitizarTaskIdParaArchivo("tarea-1")).toBe("tarea-1");
    expect(sanitizarTaskIdParaArchivo("ABC_123-xyz")).toBe("ABC_123-xyz");
    const traversal = sanitizarTaskIdParaArchivo("../../evil");
    expect(traversal).not.toContain("/");
    expect(traversal).not.toContain(".");
    expect(traversal).toHaveLength(16);
    expect(sanitizarTaskIdParaArchivo("a/b")).toHaveLength(16);
    expect(sanitizarTaskIdParaArchivo("..\\evil")).toHaveLength(16);
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

  it("asegurarExclude resuelve gitdir relativo y no omite .batuta/ por substring (B2)", async () => {
    const archivos = new Map<string, string>();
    const worktree = join(tmpdir(), "fake-work-run-1");
    const gitdirAbs = join(worktree, "..", "..", ".git", "worktrees", "run-1");
    const excludeAbs = join(gitdirAbs, "info", "exclude");
    // .git vinculado con gitdir relativo + exclude preexistente solo con contexto.
    archivos.set(join(worktree, ".git"), "gitdir: ../../.git/worktrees/run-1\n");
    archivos.set(excludeAbs, ".batuta/contexto/\n");
    const agregados: string[] = [];
    const fsMock = {
      crearDir: async () => undefined,
      leerArchivo: async (ruta: string) => {
        const v = archivos.get(ruta);
        if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return v;
      },
      escribirArchivo: async (ruta: string, datos: string) => {
        archivos.set(ruta, datos);
      },
      escribirExclusivo: async () => undefined,
      agregarArchivo: async (ruta: string, datos: string) => {
        agregados.push(`${ruta}::${datos}`);
        archivos.set(ruta, (archivos.get(ruta) ?? "") + datos);
      },
      renombrar: async () => undefined,
      listarDir: async () => [],
      borrar: async () => undefined,
    };
    await escribirContextoEnWorktree(
      fsMock,
      worktree,
      {
        spec: "spec",
        plan: {},
        subtarea: {
          id: "sub-1",
          titulo: "T",
          complejidad: "baja",
          archivos: [],
          criterios: [],
        },
      },
    );
    // Debe haber resuelto contra el worktree, no contra cwd, y agregar .batuta/ faltante.
    expect(agregados.length).toBe(1);
    const rutaNorm = agregados[0]!.replace(/\\/g, "/");
    expect(rutaNorm).toContain("worktrees/run-1/info/exclude");
    expect(agregados[0]).toContain(".batuta/");
    expect(archivos.get(excludeAbs)).toContain(".batuta/");
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

  it("no reintenta internamente ante salida inválida y devuelve salida_invalida (responsabilidad del motor)", async () => {
    let llamadas = 0;
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => {
        llamadas++;
        return {
          codigoSalida: 0,
          salidaEstandar: JSON.stringify({
            status: "SUCCESS",
            structured_output: { status: "INVALIDO" }, // status inválido según esquema
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

    expect(llamadas).toBe(1);
    expect(res.reintentos).toBe(0);
    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("salida_invalida");
  });

  it("detecta el error de terminal bloqueada por sandbox EOF y devuelve error_herramienta", async () => {
    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async () => ({
        codigoSalida: 1,
        salidaEstandar: "",
        salidaError: "Error during tool call: connecting to sandbox server: EOF",
        duracionMs: 150,
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
    expect(res.motivoFallo).toBe("error_herramienta");
    expect(res.output).toBeNull();
  });

  it("mapea variables de sesión requeridas por plataforma (ADR 021)", () => {
    const varsWindows = obtenerVariablesSesionAgy("win32");
    expect(varsWindows).toEqual(["USERPROFILE", "APPDATA", "LOCALAPPDATA"]);

    const varsLinux = obtenerVariablesSesionAgy("linux");
    expect(varsLinux).toEqual(["HOME"]);

    const varsDarwin = obtenerVariablesSesionAgy("darwin");
    expect(varsDarwin).toEqual(["HOME"]);
  });

  it("pasa variables de entorno según la plataforma configurada en el runner", async () => {
    let entornoCapturado: Record<string, string> | undefined;

    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async (_cmd, _args, opciones) => {
        entornoCapturado = opciones?.entornoExtra;
        return {
          codigoSalida: 0,
          salidaEstandar: JSON.stringify({
            status: "SUCCESS",
            structured_output: OUTPUT_VALIDO,
          }),
          salidaError: "",
          duracionMs: 50,
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

    // En plataforma linux solo debe incluir HOME de entre las variables de sesión agy
    const runnerLinux = new AntigravityRunner(
      { validarRutaWorktree: false, plataforma: "linux" },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    await runnerLinux.ejecutar(INPUT_TEST, CONTEXTO_TEST);

    expect(entornoCapturado).toBeDefined();
    expect(entornoCapturado?.USERPROFILE).toBeUndefined();
    expect(entornoCapturado?.APPDATA).toBeUndefined();
  });

  it("construye los argumentos con --sandbox, --output-format json, --json-schema y -p", async () => {
    let ejecutableLlamado = "";
    let argsLlamados: readonly string[] = [];

    const ejecutorMock: EjecutorComandos = {
      ejecutarArgs: async (ejecutable, args) => {
        ejecutableLlamado = ejecutable;
        argsLlamados = args;
        return {
          codigoSalida: 0,
          salidaEstandar: JSON.stringify({
            status: "SUCCESS",
            structured_output: OUTPUT_VALIDO,
          }),
          salidaError: "",
          duracionMs: 50,
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
      { binPath: "agy-custom", validarRutaWorktree: false },
      { ejecutor: ejecutorMock, cuotaManager: cuotaManagerMock },
    );

    await runner.ejecutar(INPUT_TEST, {
      ...CONTEXTO_TEST,
      modelo: "gemini-3.8-flash-low",
      prompt: "Mi prompt de prueba",
    });

    expect(ejecutableLlamado).toBe("agy-custom");
    expect(argsLlamados).toContain("--sandbox");
    expect(argsLlamados).not.toContain("--dangerously-skip-permissions");
    expect(argsLlamados).toContain("--output-format");
    expect(argsLlamados).toContain("json");
    expect(argsLlamados).toContain("--model");
    expect(argsLlamados).toContain("gemini-3.8-flash-low");
    expect(argsLlamados).toContain("-p");
    expect(argsLlamados).toContain("Mi prompt de prueba");
  });
});

