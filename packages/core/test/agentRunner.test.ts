import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentCallContext,
  AgentInput,
  AgentOutputJsonSchema,
  BatutaConfig,
  calcularCostoEstimado,
  cargarPlantillaPrompt,
  ClaudeCodeRunner,
  construirInvocacionClaudeCode,
  EjecutorComandos,
  EjecutorComandosReal,
  FakeRunner,
  ofuscarSecretos,
  parsearSalidaClaudeCode,
  verificarPreflightClaudeCode,
} from "../src/index.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "claude-outputs", "sinteticos");

function crearInputPrueba(override?: Partial<AgentInput>): AgentInput {
  return {
    task_id: "TASK-001",
    agent_role: "software-engineer",
    spec_path: "docs/specs/spec-01.md",
    allowed_files: ["src/user.ts"],
    budget_limit_usd: 2.0,
    max_steps: 10,
    ...override,
  };
}

function crearContextoPrueba(override?: Partial<AgentCallContext>): AgentCallContext {
  return {
    directorioTrabajo: tmpdir(),
    rol: "software-engineer",
    modelo: "claude-3-7-sonnet-20250219",
    aliasModelo: "medio",
    permisos: {
      soloLectura: false,
      comandosPermitidos: ["npm test"],
      archivosPermitidos: ["src/user.ts"],
    },
    prompt: "Por favor implementa la subtarea",
    runId: "RUN-TEST-001",
    ...override,
  };
}

describe("FakeRunner (CA-2)", () => {
  it("simula éxito, FAILED, NEEDS_INPUT y NEEDS_CONTINUATION registrando las llamadas recibidas", async () => {
    const runner = new FakeRunner();
    const input = crearInputPrueba();
    const contexto = crearContextoPrueba();

    // 1. Simular SUCCESS
    runner.guionarSiguienteLlamada(
      runner.simularExito({
        status: "SUCCESS",
        summary: "Todo listo",
        files_modified: ["src/user.ts"],
      }),
    );
    const res1 = await runner.ejecutar(input, contexto);
    expect(res1.exito).toBe(true);
    expect(res1.output?.status).toBe("SUCCESS");
    expect(res1.output?.summary).toBe("Todo listo");

    // 2. Simular FAILED
    runner.guionarSiguienteLlamada(
      runner.simularExito({
        status: "FAILED",
        summary: "No fue posible cumplir la spec",
      }),
    );
    const res2 = await runner.ejecutar(input, contexto);
    expect(res2.exito).toBe(true);
    expect(res2.output?.status).toBe("FAILED");

    // 3. Simular NEEDS_INPUT
    runner.guionarSiguienteLlamada(
      runner.simularExito({
        status: "NEEDS_INPUT",
        summary: "Duda crítica de seguridad",
        blocking_question: "¿Permitir acceso root?",
      }),
    );
    const res3 = await runner.ejecutar(input, contexto);
    expect(res3.exito).toBe(true);
    expect(res3.output?.status).toBe("NEEDS_INPUT");
    expect(res3.output?.blocking_question).toBe("¿Permitir acceso root?");

    // 4. Simular NEEDS_CONTINUATION
    runner.guionarSiguienteLlamada(
      runner.simularExito({
        status: "NEEDS_CONTINUATION",
        summary: "Pasos agotados",
        continuation_notes: "Falta terminar tests",
      }),
    );
    const res4 = await runner.ejecutar(input, contexto);
    expect(res4.exito).toBe(true);
    expect(res4.output?.status).toBe("NEEDS_CONTINUATION");

    // Afirmación sobre llamadas registradas
    expect(runner.llamadasRecibidas).toHaveLength(4);
    expect(runner.llamadasRecibidas[0]?.input.task_id).toBe("TASK-001");
  });

  it("simula fallos de timeout, presupuesto agotado y salida inválida", async () => {
    const runner = new FakeRunner();
    const input = crearInputPrueba();
    const contexto = crearContextoPrueba();

    runner.guionarSiguienteLlamada(runner.simularFallo("timeout"));
    const resTimeout = await runner.ejecutar(input, contexto);
    expect(resTimeout.exito).toBe(false);
    expect(resTimeout.motivoFallo).toBe("timeout");

    runner.guionarSiguienteLlamada(runner.simularFallo("presupuesto_agotado"));
    const resPresupuesto = await runner.ejecutar(input, contexto);
    expect(resPresupuesto.exito).toBe(false);
    expect(resPresupuesto.motivoFallo).toBe("presupuesto_agotado");

    runner.guionarSiguienteLlamada(runner.simularFallo("salida_invalida"));
    const resInvalida = await runner.ejecutar(input, contexto);
    expect(resInvalida.exito).toBe(false);
    expect(resInvalida.motivoFallo).toBe("salida_invalida");
  });
});

describe("construirInvocacionClaudeCode (CA-3)", () => {
  it("construye invocación para rol de solo lectura sin herramientas de escritura ni comandos", () => {
    const { ejecutable, args } = construirInvocacionClaudeCode({
      modelo: "claude-3-7-sonnet-20250219",
      prompt: "Inspecciona el repositorio",
      permisos: { soloLectura: true },
      limites: { budgetLimitUsd: 1.5, maxSteps: 5 },
    });

    expect(ejecutable).toBe("claude");
    expect(args).toContain("--print");
    expect(args).toContain("--verbose");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--bare");
    expect(args).toContain("--model");
    expect(args).toContain("claude-3-7-sonnet-20250219");
    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("1.5");
    // Solo lectura
    expect(args).toContain("--tools");
    expect(args).toContain("Read,Grep,Glob");
    expect(args).not.toContain("Edit");
    expect(args).not.toContain("Bash");
    expect(args).not.toContain("--allowed-tools");
    // El prompt siempre va tras `--` como último posicional
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("Inspecciona el repositorio");
  });

  it("separa el prompt con `--` sin prompt de sistema ni esquema", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "m-test",
      prompt: "hola",
      permisos: { soloLectura: true },
    });

    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("hola");
    expect(args).not.toContain("--append-system-prompt");
    expect(args).not.toContain("--json-schema");
  });

  it("un prompt que empieza por `--` no se interpreta como flag gracias al separador", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "m-test",
      prompt: "--help me with this",
      permisos: { soloLectura: true },
    });

    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("--help me with this");
  });

  it("construye invocación para rol con escritura y comandos permitidos", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "claude-3-5-sonnet-20241022",
      prompt: "Implementa el cambio",
      permisos: {
        soloLectura: false,
        comandosPermitidos: ["npm test", "npm run lint"],
      },
    });

    // Herramientas disponibles definidas con --tools
    expect(args).toContain("--tools");
    const toolsArg = args[args.indexOf("--tools") + 1];
    expect(toolsArg).toBe("Bash,Edit,Write,Read,Grep,Glob");

    // Y además restringidas con --allowed-tools
    expect(args).toContain("--allowed-tools");
    const allowedToolsArg = args[args.indexOf("--allowed-tools") + 1];
    expect(allowedToolsArg).toMatch(/Read/);
    expect(allowedToolsArg).toMatch(/Edit/);
    expect(allowedToolsArg).toMatch(/Bash\(npm test\)/);
    expect(allowedToolsArg).toMatch(/Bash\(npm run lint\)/);
    // El prompt va tras `--`
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("Implementa el cambio");
  });

  it("rol con escritura sin comandos: sin Bash en --tools pero con --allowed-tools", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "m-test",
      prompt: "Edita sin comandos",
      permisos: { soloLectura: false },
    });

    const toolsArg = args[args.indexOf("--tools") + 1];
    expect(toolsArg).toBe("Edit,Write,Read,Grep,Glob");
    expect(toolsArg).not.toMatch(/Bash/);

    expect(args).toContain("--allowed-tools");
    const allowedToolsArg = args[args.indexOf("--allowed-tools") + 1];
    expect(allowedToolsArg).toBe("Read Grep Glob Edit Write");
    expect(args[args.length - 2]).toBe("--");
    expect(args[args.length - 1]).toBe("Edita sin comandos");
  });

  it("rol con escritura con lista vacía equivale a sin comandos", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "m-test",
      prompt: "Edita",
      permisos: { soloLectura: false, comandosPermitidos: [] },
    });

    const toolsArg = args[args.indexOf("--tools") + 1];
    expect(toolsArg).not.toMatch(/Bash/);
    expect(args).toContain("--allowed-tools");
  });

  it("construye invocación con esquema estructurado AgentOutput y prompt de sistema", () => {
    const { args } = construirInvocacionClaudeCode({
      modelo: "claude-3-5-haiku-20241022",
      prompt: "Ejecuta y responde",
      promptSistema: "Reglas estrictas del repositorio",
      permisos: { soloLectura: true },
      esquemaJson: AgentOutputJsonSchema,
    });

    expect(args).toContain("--append-system-prompt");
    expect(args).toContain("Reglas estrictas del repositorio");

    expect(args).toContain("--json-schema");
    const schemaIdx = args.indexOf("--json-schema");
    const jsonStr = args[schemaIdx + 1]!;
    expect(jsonStr).toContain("files_modified");
    expect(jsonStr).toContain("reported_checks");
    expect(JSON.parse(jsonStr)).toBeDefined();
  });
});

describe("Lectura de salidas reales grabadas (CA-4)", () => {
  it("convierte salida real de éxito en resultado exitoso con tokens y salida validada", async () => {
    const contenido = await readFile(join(FIXTURES_DIR, "exito.json"), "utf8");
    const res = parsearSalidaClaudeCode(contenido);

    expect(res.exito).toBe(true);
    expect(res.motivoFallo).toBeNull();
    expect(res.agentOutput?.status).toBe("SUCCESS");
    expect(res.agentOutput?.summary).toMatch(/exitosa/i);
    expect(res.uso.tokensEntrada).toBe(1500);
    expect(res.uso.tokensSalida).toBe(420);
    expect(res.uso.turnos).toBe(3);
  });

  it("convierte salida de turnos agotados en fallo por turnos_agotados", async () => {
    const contenido = await readFile(
      join(FIXTURES_DIR, "turnos_agotados.json"),
      "utf8",
    );
    const res = parsearSalidaClaudeCode(contenido);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("turnos_agotados");
    expect(res.agentOutput).toBeNull();
    expect(res.uso.turnos).toBe(15);
  });

  it("convierte salida de presupuesto agotado en fallo por presupuesto_agotado", async () => {
    const contenido = await readFile(
      join(FIXTURES_DIR, "presupuesto_agotado.json"),
      "utf8",
    );
    const res = parsearSalidaClaudeCode(contenido);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("presupuesto_agotado");
  });

  it("convierte salida estructurada inválida en fallo por salida_invalida con error", async () => {
    const contenido = await readFile(
      join(FIXTURES_DIR, "salida_invalida.json"),
      "utf8",
    );
    const res = parsearSalidaClaudeCode(contenido);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("salida_invalida");
    expect(res.errorValidacion).toBeDefined();
  });

  it("convierte error de herramienta en fallo por error_herramienta", async () => {
    const contenido = await readFile(
      join(FIXTURES_DIR, "error_herramienta.json"),
      "utf8",
    );
    const res = parsearSalidaClaudeCode(contenido);

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("error_herramienta");
  });
});

describe("ClaudeCodeRunner reintentos y límites (CA-5, CA-6, CA-7, CA-8, CA-9)", () => {
  it("reintenta una sola vez ante salida inválida y si el segundo intento es válido, devuelve éxito (CA-5)", async () => {
    const salidaInvalida = await readFile(
      join(FIXTURES_DIR, "salida_invalida.json"),
      "utf8",
    );
    const salidaExitosa = await readFile(
      join(FIXTURES_DIR, "exito.json"),
      "utf8",
    );

    let intentos = 0;
    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async () => {
        intentos++;
        return {
          codigoSalida: 0,
          salidaEstandar: intentos === 1 ? salidaInvalida : salidaExitosa,
          salidaError: "",
          duracionMs: 100,
          timeoutVencido: false,
        };
      },
    };

    const runner = new ClaudeCodeRunner(ejecutorMock);
    const input = crearInputPrueba();
    const contexto = crearContextoPrueba();

    const res = await runner.ejecutar(input, contexto);
    expect(intentos).toBe(2);
    expect(res.reintentos).toBe(1);
    expect(res.exito).toBe(true);
    expect(res.output?.status).toBe("SUCCESS");

    // Limpieza de log generado
    if (existsSync(res.rutaLog)) {
      await rm(res.rutaLog, { force: true });
    }
  });

  it("si el reintento vuelve a fallar con salida inválida, devuelve fallo con salida_invalida (CA-5)", async () => {
    const salidaInvalida = await readFile(
      join(FIXTURES_DIR, "salida_invalida.json"),
      "utf8",
    );

    let intentos = 0;
    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async () => {
        intentos++;
        return {
          codigoSalida: 0,
          salidaEstandar: salidaInvalida,
          salidaError: "",
          duracionMs: 100,
          timeoutVencido: false,
        };
      },
    };

    const runner = new ClaudeCodeRunner(ejecutorMock);
    const res = await runner.ejecutar(crearInputPrueba(), crearContextoPrueba());

    expect(intentos).toBe(2);
    expect(res.reintentos).toBe(1);
    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("salida_invalida");
    expect(res.output).toBeNull();

    if (existsSync(res.rutaLog)) {
      await rm(res.rutaLog, { force: true });
    }
  });

  it("el proceso del agente solo recibe la lista blanca y las variables de variables_modelo (CA-6)", async () => {
    let entornoCapturado: Record<string, string> | undefined;

    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async (_bin, _args, opciones) => {
        entornoCapturado = opciones?.entornoExtra;
        return {
          codigoSalida: 0,
          salidaEstandar: await readFile(join(FIXTURES_DIR, "exito.json"), "utf8"),
          salidaError: "",
          duracionMs: 50,
          timeoutVencido: false,
        };
      },
    };

    // Simular secreto en process.env
    process.env.MI_TOKEN_ULTRA_SECRETO = "token_prohibido_12345";
    process.env.API_KEY_MODELO_PERMITIDA = "modelo_key_valida";

    const configPrueba = {
      proyecto: "repo",
      gates: [{ nombre: "lint", comando: "npm run lint", timeout_seg: 60 }],
      variables_modelo: ["API_KEY_MODELO_PERMITIDA"],
    } as unknown as BatutaConfig;

    const runner = new ClaudeCodeRunner(ejecutorMock, configPrueba);
    const res = await runner.ejecutar(crearInputPrueba(), crearContextoPrueba());

    delete process.env.MI_TOKEN_ULTRA_SECRETO;
    delete process.env.API_KEY_MODELO_PERMITIDA;

    expect(entornoCapturado).toBeDefined();
    // Variable permitida en variables_modelo sí llega
    expect(entornoCapturado?.API_KEY_MODELO_PERMITIDA).toBe("modelo_key_valida");
    // Variable fuera de lista blanca y no listada en variables_modelo NO llega
    expect(entornoCapturado?.MI_TOKEN_ULTRA_SECRETO).toBeUndefined();

    if (existsSync(res.rutaLog)) {
      await rm(res.rutaLog, { force: true });
    }
  });

  it("el costo se calcula con los precios del alias y es desconocido cuando no hay precios (CA-7)", () => {
    // 1. Con precios definidos
    const costoConPrecios = calcularCostoEstimado(
      { entrada: 1_000_000, salida: 500_000 },
      { entrada: 3.0, salida: 15.0 },
    );
    expect(costoConPrecios.desconocido).toBe(false);
    expect(costoConPrecios.montoUsd).toBe(10.5); // 3.0 + 7.5

    // 2. Sin precios definidos
    const costoDesconocido = calcularCostoEstimado(
      { entrada: 1000, salida: 500 },
      undefined,
    );
    expect(costoDesconocido.desconocido).toBe(true);
    expect(costoDesconocido.montoUsd).toBeNull();

    // 3. Con precios parciales faltantes
    const costoParcial = calcularCostoEstimado(
      { entrada: 1000, salida: 500 },
      { entrada: 3.0, salida: undefined },
    );
    expect(costoParcial.desconocido).toBe(true);
    expect(costoParcial.montoUsd).toBeNull();
  });

  it("Batuta aplica el límite de turnos aunque la herramienta reporte éxito (CA-8)", async () => {
    const salidaMuchosTurnos = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 20, // Supera max_steps de 10
      usage: { input_tokens: 1000, output_tokens: 200 },
      result: JSON.stringify({
        status: "SUCCESS",
        summary: "Terminado pero tomó 20 turnos",
        files_modified: [],
        reported_checks: [],
        continuation_notes: "",
        blocking_question: "",
      }),
    });

    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async () => ({
        codigoSalida: 0,
        salidaEstandar: salidaMuchosTurnos,
        salidaError: "",
        duracionMs: 100,
        timeoutVencido: false,
      }),
    };

    const runner = new ClaudeCodeRunner(ejecutorMock);
    const input = crearInputPrueba({ max_steps: 10 });
    const res = await runner.ejecutar(input, crearContextoPrueba());

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("turnos_agotados");
    expect(res.output).toBeNull();

    if (existsSync(res.rutaLog)) {
      await rm(res.rutaLog, { force: true });
    }
  });

  it("termina el árbol de procesos y devuelve turnos_agotados mientras corre si las líneas de streaming superan max_steps (CA-8)", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "batuta-stream-test-"));
    const scriptPath = join(tmpDir, "mock-stream.cjs");

    // Script que emite eventos de streaming con pausas para simular ejecución continua
    const scriptCode = `
      async function main() {
        console.log(JSON.stringify({ type: "system", subtype: "init" }));
        for (let i = 1; i <= 6; i++) {
          await new Promise((r) => setTimeout(r, 60));
          console.log(JSON.stringify({
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "turno " + i }] }
          }));
        }
        console.log(JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          num_turns: 6,
          result: JSON.stringify({ status: "SUCCESS", summary: "terminado tarde" })
        }));
      }
      main();
    `;
    await writeFile(scriptPath, scriptCode, "utf8");

    const ejecutorReal = new EjecutorComandosReal();
    const ejecutorStream: EjecutorComandos = {
      ejecutar: (cmd, opts) => ejecutorReal.ejecutar(cmd, opts),
      ejecutarArgs: (_bin, _args, opts) =>
        ejecutorReal.ejecutarArgs(process.execPath, [scriptPath], opts),
    };

    const runner = new ClaudeCodeRunner(ejecutorStream);
    const input = crearInputPrueba({ max_steps: 2 });
    const res = await runner.ejecutar(input, crearContextoPrueba());

    expect(res.exito).toBe(false);
    expect(res.motivoFallo).toBe("turnos_agotados");
    expect(res.output).toBeNull();
    expect(res.uso.turnos).toBeGreaterThanOrEqual(2);

    if (existsSync(res.rutaLog)) {
      await rm(res.rutaLog, { force: true });
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("el registro de la llamada oculta patrones de claves y secretos conocidos (CA-9)", async () => {
    const textoConSecretos = [
      'Clave OpenAI: sk-1234567890abcdef1234567890abcdef',
      'Clave Anthropic: sk-ant-1234567890abcdef1234567890',
      'Token GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'AWS: AKIAIOSFODNN7EXAMPLE',
      'Asignación: api_key = "abcdef1234567890claveprivadareal"',
    ].join("\n");

    const ofuscado = ofuscarSecretos(textoConSecretos);

    expect(ofuscado).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(ofuscado).not.toContain("sk-ant-1234567890abcdef1234567890");
    expect(ofuscado).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwxyz");
    expect(ofuscado).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(ofuscado).not.toContain("abcdef1234567890claveprivadareal");
    expect(ofuscado).toContain("[REDACTADO]");
  });
});

describe("verificarPreflightClaudeCode (CA-10)", () => {
  it("detecta CLI ausente con mensaje claro", async () => {
    const ejecutorAusente: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async () => ({
        codigoSalida: 127,
        salidaEstandar: "",
        salidaError: "claude: command not found",
        duracionMs: 10,
        timeoutVencido: false,
      }),
    };

    const res = await verificarPreflightClaudeCode(ejecutorAusente);
    expect(res.ok).toBe(false);
    expect(res.version).toBeNull();
    expect(res.mensaje).toMatch(/no está instalada/i);
  });

  it("detecta versión que no admite los flags requeridos", async () => {
    const ejecutorSinFlags: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async (_bin, args) => {
        if (args[0] === "--version") {
          return {
            codigoSalida: 0,
            salidaEstandar: "claude version 0.9.0",
            salidaError: "",
            duracionMs: 10,
            timeoutVencido: false,
          };
        }
        return {
          codigoSalida: 0,
          salidaEstandar: "Usage: claude [options]\n--help",
          salidaError: "",
          duracionMs: 10,
          timeoutVencido: false,
        };
      },
    };

    const res = await verificarPreflightClaudeCode(ejecutorSinFlags);
    expect(res.ok).toBe(false);
    expect(res.flagsAdmitidos).toBe(false);
    expect(res.mensaje).toMatch(/no admite los flags requeridos/i);
  });

  it("detecta instalación compatible con versión y flags correctos", async () => {
    const ejecutorValido: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No usado");
      },
      ejecutarArgs: async (_bin, args) => {
        if (args[0] === "--version") {
          return {
            codigoSalida: 0,
            salidaEstandar: "2.1.282 (Claude Code)",
            salidaError: "",
            duracionMs: 10,
            timeoutVencido: false,
          };
        }
        return {
          codigoSalida: 0,
          salidaEstandar: "Options: --print -p --output-format <format> --json-schema <schema>",
          salidaError: "",
          duracionMs: 10,
          timeoutVencido: false,
        };
      },
    };

    const res = await verificarPreflightClaudeCode(ejecutorValido);
    expect(res.ok).toBe(true);
    expect(res.version).toBe("2.1.282");
    expect(res.flagsAdmitidos).toBe(true);
  });
});

describe("cargarPlantillaPrompt", () => {
  it("sustituye variables en la plantilla de software-engineer y architect", async () => {
    const promptSE = await cargarPlantillaPrompt("software-engineer", {
      subtarea: "SUB-101: Crear endpoint",
      spec: "SPEC-001 de usuarios",
      reglas_repo: "Seguir reglas estrictas de AGENTS.md",
      archivos_permitidos: "src/endpoint.ts",
      esquema_salida: '{"type":"object"}',
    });

    expect(promptSE).toContain("SUB-101: Crear endpoint");
    expect(promptSE).toContain("SPEC-001 de usuarios");
    expect(promptSE).toContain("src/endpoint.ts");
    expect(promptSE).toContain('{"type":"object"}');
    expect(promptSE).toContain("NEEDS_INPUT");
    expect(promptSE).not.toContain("{{subtarea}}");

    const promptArch = await cargarPlantillaPrompt("architect", {
      subtarea: "Crear spec de pagos",
      spec: "Contexto general",
      reglas_repo: "Reglas de arquitectura",
      archivos_permitidos: "docs/specs/",
      esquema_salida: '{"type":"object"}',
    });

    expect(promptArch).toContain("Crear spec de pagos");
    expect(promptArch).toContain("SOLO LECTURA");
    expect(promptArch).not.toContain("{{subtarea}}");
  });
});
