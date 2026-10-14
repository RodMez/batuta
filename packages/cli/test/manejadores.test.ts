import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AntigravityRunner,
  ClaudeCodeRunner,
  EjecutorComandosReal,
  parseBatutaConfigYaml,
  type EjecutorComandos,
  type ResultadoComando,
} from "@batuta/core";
import { ejecutarAbort } from "../src/comandos/abort.js";
import { ejecutarAnswer } from "../src/comandos/answer.js";
import { ejecutarApprove } from "../src/comandos/approve.js";
import { ejecutarDoctor } from "../src/comandos/doctor.js";
import { ejecutarResume } from "../src/comandos/resume.js";
import { ejecutarRun } from "../src/comandos/run.js";
import { asegurarExclusionBatuta } from "../src/comandos/run.js";
import { ejecutarStatus, StatusJsonSchema } from "../src/comandos/status.js";
import { crearRunner, entornoReal } from "../src/contexto.js";
import { ejecutarChequeos, parsearModelosAgy } from "../src/preflight.js";
import { CONFIG_DEMO, PLAN_UNA, crearRepoDesechable, guionEscribe } from "./utilidades.js";

const CONFIG_LIBRE = [
  "proyecto: .",
  "gates:",
  "  - { nombre: ok, comando: \"node -e \\\"process.exit(0)\\\"\", timeout_seg: 60 }",
  "aprobaciones:",
  "  H0_inicio: false",
  "  H1_spec: false",
  "  H2_plan: false",
  "  H3_merge: false",
  "",
].join("\n");

const CONFIG_H0 = [
  "proyecto: .",
  "gates:",
  "  - { nombre: ok, comando: \"node -e \\\"process.exit(0)\\\"\", timeout_seg: 60 }",
  "aprobaciones:",
  "  H0_inicio: true",
  "  H1_spec: false",
  "  H2_plan: false",
  "  H3_merge: false",
  "",
].join("\n");

describe("manejadores de la CLI", () => {
  const limpiezas: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (limpiezas.length > 0) {
      const fn = limpiezas.pop();
      if (fn) {
        try {
          await fn();
        } catch {}
      }
    }
  });

  /** Archivos de tarea fuera del repo para no ensuciar el árbol. */
  async function escribirArchivos(base: string, guion: string): Promise<{
    spec: string;
    plan: string;
    config: string;
    simulado: string;
  }> {
    const spec = join(base, "spec.md");
    const plan = join(base, "plan.json");
    const config = join(base, "batuta.yaml");
    const simulado = join(base, "guion.json");
    await writeFile(spec, "# SPEC demo\n", "utf8");
    await writeFile(plan, `${PLAN_UNA}\n`, "utf8");
    await writeFile(config, CONFIG_LIBRE, "utf8");
    await writeFile(simulado, guion, "utf8");
    return { spec, plan, config, simulado };
  }

  async function confirmarTodo(repoDir: string): Promise<void> {
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git add -A", { cwd: repoDir });
    await ejecutor.ejecutar("git commit -m 'archivos de prueba'", { cwd: repoDir });
  }

  function extraerRunId(texto: string): string {
    const runId = (texto.match(/RUN-\d{4}-\d{2}-\d{2}-\d+/) ?? [""])[0]!;
    expect(runId.length).toBeGreaterThan(0);
    return runId;
  }

  it("run pausa en H0 con código 10 y approve continúa hasta DONE con 0", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "hola\n" }));
    const entorno = entornoReal();
    const configPuertas = CONFIG_H0.replace("  H3_merge: false", "  H3_merge: true");
    await writeFile(f.config, configPuertas, "utf8");

    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(10);
    expect(r0.texto).toMatch(/H0/);
    const runId = extraerRunId(r0.texto);

    const r1 = await ejecutarApprove(
      { runId, puerta: "H0", repoDir, simulado: f.simulado, rechazar: false, soloRegistrar: false, debug: false },
      entorno,
    );
    expect(r1.codigo).toBe(10);
    expect(r1.texto).toMatch(/H3/);

    const st = await ejecutarStatus({ runId, repoDir, json: true, debug: false }, entorno);
    expect(st.codigo).toBe(0);
    expect(() => StatusJsonSchema.parse(JSON.parse(st.texto))).not.toThrow();

    const r2 = await ejecutarApprove(
      { runId, puerta: "H3", repoDir, simulado: f.simulado, rechazar: false, soloRegistrar: false, debug: false },
      entorno,
    );
    expect(r2.codigo).toBe(0);
    expect(r2.texto).toMatch(/DONE/);
  }, 90000);

  it("status sin id lista las ejecuciones y con --json valida el esquema", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "x\n" }));
    const entorno = entornoReal();
    const vacia = await ejecutarStatus({ repoDir, json: false, debug: false }, entorno);
    expect(vacia.texto).toMatch(/No hay ejecuciones/);

    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(0);
    const lista = await ejecutarStatus({ repoDir, json: false, debug: false }, entorno);
    expect(lista.texto).toMatch(/RUN-/);
    const listaJson = await ejecutarStatus({ repoDir, json: true, debug: false }, entorno);
    expect(() => StatusJsonSchema.array().parse(JSON.parse(listaJson.texto))).not.toThrow();
  }, 90000);

  it("approve rechaza con ABORTED y valida la puerta en español", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "x\n" }));
    await writeFile(f.config, CONFIG_H0, "utf8");
    const entorno = entornoReal();
    const mala = await ejecutarApprove(
      { runId: "RUN-1", puerta: "H9", repoDir, rechazar: false, soloRegistrar: false, debug: false },
      entorno,
    );
    expect(mala.codigo).toBe(2);
    expect(mala.texto).toMatch(/H0, H1, H2 o H3/);

    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(10);
    const runId = extraerRunId(r0.texto);
    const rej = await ejecutarApprove(
      { runId, puerta: "H0", repoDir, rechazar: true, comentario: "no me gusta", soloRegistrar: false, debug: false },
      entorno,
    );
    expect(rej.codigo).toBe(0);
    expect(rej.texto).toMatch(/no me gusta/);
  }, 90000);

  it("answer responde una duda crítica y continúa con código 0", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const guion = JSON.stringify({
      llamadas: [
        {
          output: {
            status: "NEEDS_INPUT",
            summary: "duda",
            files_modified: [],
            reported_checks: [],
            continuation_notes: "",
            blocking_question: "¿Sigo con X?",
          },
        },
        { archivos: { "a.txt": "ok\n" } },
      ],
    });
    const f = await escribirArchivos(base, guion);
    const entorno = entornoReal();
    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(11);
    expect(r0.texto).toMatch(/¿Sigo con X\?/);
    const runId = extraerRunId(r0.texto);
    const r1 = await ejecutarAnswer(
      { runId, texto: ["Sí,", "adelante"], repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r1.codigo).toBe(0);
  }, 90000);

  it("abort pide confirmación y limpia con --yes", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "x\n" }));
    const entorno = entornoReal();
    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(0);
    const runId = extraerRunId(r0.texto);

    const sinYes = await ejecutarAbort(
      { runId, repoDir, yes: false, debug: false },
      entorno,
      async () => false,
    );
    expect(sinYes.codigo).toBe(2);
    expect(sinYes.texto).toMatch(/--yes/);

    const conYes = await ejecutarAbort({ runId, repoDir, yes: true, debug: false }, entorno);
    expect(conYes.codigo).toBe(0);
    // Abortar un DONE limpia sin reescribir la historia: sigue DONE y el worktree ya no existe.
    const st = await ejecutarStatus({ runId, repoDir, json: true, debug: false }, entorno);
    const ficha = StatusJsonSchema.parse(JSON.parse(st.texto));
    expect(ficha.estado).toBe("DONE");
    expect(ficha.rutas.worktree).not.toBeNull();
    const { existsSync } = await import("node:fs");
    expect(existsSync(ficha.rutas.worktree!)).toBe(false);
  }, 90000);

  it("resume continúa tras registrar sin continuar", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "x\n" }));
    await writeFile(f.config, CONFIG_H0, "utf8");
    const entorno = entornoReal();
    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    const runId = extraerRunId(r0.texto);
    const reg = await ejecutarApprove(
      { runId, puerta: "H0", repoDir, simulado: f.simulado, rechazar: false, soloRegistrar: true, debug: false },
      entorno,
    );
    expect(reg.codigo).toBe(10);
    expect(reg.texto).toMatch(/resume/);
    const r1 = await ejecutarResume({ runId, repoDir, simulado: f.simulado, debug: false }, entorno);
    expect(r1.codigo).toBe(0);
  }, 90000);

  it("doctor detecta problemas", async () => {
    const entorno = entornoReal();
    const noRepo = await ejecutarDoctor({ repoDir: "/no/existe/batuta-xyz", debug: false }, entorno);
    expect(noRepo.codigo).toBe(2);
    expect(noRepo.texto).toMatch(/ERROR.*repositorio/);

    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const sinConfig = await ejecutarDoctor({ repoDir, debug: false }, entorno);
    expect(sinConfig.codigo).toBe(2);
    expect(sinConfig.texto).toMatch(/configuración/i);

    await writeFile(join(repoDir, "batuta.yaml"), "gates: []\n", "utf8");
    const invalida = await ejecutarDoctor({ repoDir, debug: false }, entorno);
    expect(invalida.codigo).toBe(2);

    await writeFile(join(repoDir, "sucio.txt"), "x", "utf8");
    await writeFile(join(repoDir, "batuta.yaml"), CONFIG_DEMO, "utf8");
    const sucio = await ejecutarDoctor({ repoDir, debug: false }, entorno);
    expect(sucio.codigo).toBe(2);
    expect(sucio.texto).toMatch(/árbol/i);
  }, 90000);

  it("doctor avisa de precios y variables solo por nombre, sin valores", async () => {
    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const entorno = entornoReal();
    process.env.BATUTA_CLI_SECRETO = "valor-ultra-secreto-123";
    const config = [
      "proyecto: .",
      "gates:",
      "  - { nombre: ok, comando: \"node -e \\\"process.exit(0)\\\"\", timeout_seg: 60 }",
      "variables_modelo: [BATUTA_CLI_SECRETO, BATUTA_CLI_FALTA_XYZ]",
      "",
    ].join("\n");
    await writeFile(join(repoDir, "batuta.yaml"), config, "utf8");
    await confirmarTodo(repoDir);
    try {
      const res = await ejecutarDoctor(
        { repoDir, simulado: join(repoDir, "nada.json"), debug: false },
        entorno,
      );
      expect(res.codigo).toBe(0);
      expect(res.texto).toMatch(/AVISO.*precios/);
      expect(res.texto).toMatch(/BATUTA_CLI_FALTA_XYZ/);
      expect(res.texto).not.toContain("valor-ultra-secreto-123");
    } finally {
      delete process.env.BATUTA_CLI_SECRETO;
    }
  }, 60000);

  it("doctor detecta herramienta ausente con ejecutor simulado", async () => {
    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    await writeFile(join(repoDir, "batuta.yaml"), CONFIG_DEMO, "utf8");
    await confirmarTodo(repoDir);
    const ejecutorRoto: EjecutorComandos = {
      ejecutar: async (): Promise<ResultadoComando> => {
        throw new Error("no usado");
      },
      ejecutarArgs: async (): Promise<ResultadoComando> => ({
        codigoSalida: 127,
        salidaEstandar: "",
        salidaError: "not found",
        duracionMs: 5,
        timeoutVencido: false,
      }),
    };
    const res = await ejecutarDoctor(
      { repoDir, debug: false },
      { ...entornoReal(), ejecutor: ejecutorRoto },
    );
    expect(res.codigo).toBe(2);
    expect(res.texto).toMatch(/herramienta/i);
  }, 60000);

  it("los errores no muestran pila salvo con --debug", async () => {
    const entorno = entornoReal();
    const sinDebug = await ejecutarRun({ debug: false }, entorno);
    expect(sinDebug.codigo).toBe(2);
    expect(sinDebug.texto).not.toMatch(/^\s*at /m);
    const conDebug = await ejecutarRun({ debug: true }, entorno);
    expect(conDebug.codigo).toBe(2);
    expect(conDebug.texto).toMatch(/--spec/);
  }, 60000);

  it("run excluye .batuta y es idempotente", async () => {
    const { base, repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const f = await escribirArchivos(base, guionEscribe({ "a.txt": "x\n" }));
    const entorno = entornoReal();
    await asegurarExclusionBatuta(entorno, repoDir);
    await asegurarExclusionBatuta(entorno, repoDir);
    const exclude = await readFile(join(repoDir, ".git", "info", "exclude"), "utf8");
    expect(exclude.split(/\r?\n/).filter((l) => l.trim() === ".batuta/")).toHaveLength(1);
    const r0 = await ejecutarRun(
      { spec: f.spec, plan: f.plan, configPath: f.config, repoDir, simulado: f.simulado, debug: false },
      entorno,
    );
    expect(r0.codigo).toBe(0);
    const ejecutor = new EjecutorComandosReal();
    const status = await ejecutor.ejecutar("git status --porcelain", { cwd: repoDir });
    expect(status.salidaEstandar.trim()).toBe("");
  }, 90000);

  it("run rechaza el brief reservado con mensaje claro", async () => {
    const res = await ejecutarRun({ brief: "brief.md", debug: false }, entornoReal());
    expect(res.codigo).toBe(2);
    expect(res.texto).toMatch(/--spec/);
  }, 60000);

  it("crearRunner preserva compatibilidad hacia atrás instanciando ClaudeCodeRunner si no hay sección runner", () => {
    const entorno = entornoReal();
    const configClaude = parseBatutaConfigYaml(
      [
        "proyecto: .",
        "ejecutor: claude-code",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
    );
    const runnerClaude = crearRunner(entorno, configClaude);
    expect(runnerClaude).toBeInstanceOf(ClaudeCodeRunner);

    const configAgy = parseBatutaConfigYaml(
      [
        "proyecto: .",
        "runner:",
        "  tipo: antigravity",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
    );
    const runnerAgy = crearRunner(entorno, configAgy);
    expect(runnerAgy).toBeInstanceOf(AntigravityRunner);
  });

  it("crearRunner lanza error explícito con ejecutor opencode (B1)", () => {
    const entorno = entornoReal();
    const configOpencode = parseBatutaConfigYaml(
      [
        "proyecto: .",
        "ejecutor: opencode",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
    );
    expect(() => crearRunner(entorno, configOpencode)).toThrow(/no soportado/);
  });

  it("parsearModelosAgy extrae identificadores de modelo ignorando lineas de carga", () => {
    const salidaEjemplo = [
      "Fetching available models...",
      "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
    ].join("\n");

    const modelos = parsearModelosAgy(salidaEjemplo);
    expect(modelos).toEqual([
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-medium",
      "gemini-3.8-flash-low",
      "claude-sonnet-4-6",
    ]);
  });

  it("parsearModelosAgy ignora cabeceras, BOM, duplicados y vacíos (M5)", () => {
    const salida = [
      "MODEL\tDESCRIPTION",
      "---",
      "gemini-3.8-flash-low\tLow",
      "gemini-3.8-flash-low\tLow duplicado",
      "",
      "Fetching available models...",
      "[2Jgemini-3.8-flash-high\tHigh",
    ].join("\n");
    expect(parsearModelosAgy(salida)).toEqual([
      "gemini-3.8-flash-low",
      "gemini-3.8-flash-high",
    ]);
    expect(parsearModelosAgy("")).toEqual([]);
  });

  it("preflight con runner antigravity valida que los modelos configurados existan en agy models", async () => {
    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);

    const configPath = join(repoDir, "batuta.yaml");
    await writeFile(
      configPath,
      [
        "proyecto: .",
        "runner:",
        "  tipo: antigravity",
        "alias_modelos:",
        "  rapido: { modelo: gemini-3.8-flash-low, ventana: 100000 }",
        "  medio: { modelo: gemini-3.8-flash-medium, ventana: 100000 }",
        "  fuerte: { modelo: modelo-inexistente-xyz, ventana: 200000 }",
        "  revisor: { modelo: gemini-3.8-flash-low, ventana: 100000 }",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
      "utf8",
    );
    await confirmarTodo(repoDir);


    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
      ejecutarArgs: async (bin, args) => {
        if (bin === "agy" && args[0] === "models") {
          return {
            codigoSalida: 0,
            salidaEstandar: [
              "Fetching available models...",
              "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
              "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
            ].join("\n"),
            salidaError: "",
            duracionMs: 10,
            timeoutVencido: false,
          };
        }
        return {
          codigoSalida: 0,
          salidaEstandar: "",
          salidaError: "",
          duracionMs: 0,
          timeoutVencido: false,
        };
      },
    };

    const entorno = { ...entornoReal(), ejecutor: ejecutorMock };
    const { chequeos } = await ejecutarChequeos(entorno, {
      repoDir,
      configPath,
      simulado: false,
    });

    const chequeoHerramienta = chequeos.find((c) => c.nombre === "herramienta");
    expect(chequeoHerramienta).toBeDefined();
    expect(chequeoHerramienta?.estado).toBe("error");
    expect(chequeoHerramienta?.detalle).toContain("modelo-inexistente-xyz");
  });

  it("preflight --skip-model-check convierte modelo faltante en aviso", async () => {
    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const configPath = join(repoDir, "batuta.yaml");
    await writeFile(
      configPath,
      [
        "proyecto: .",
        "runner:",
        "  tipo: antigravity",
        "alias_modelos:",
        "  rapido: { modelo: gemini-3.8-flash-low, ventana: 100000 }",
        "  medio: { modelo: gemini-3.8-flash-medium, ventana: 100000 }",
        "  fuerte: { modelo: modelo-inexistente-xyz, ventana: 200000 }",
        "  revisor: { modelo: gemini-3.8-flash-low, ventana: 100000 }",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
      "utf8",
    );
    await confirmarTodo(repoDir);
    const ejecutorMock: EjecutorComandos = {
      ejecutar: async () => {
        throw new Error("No debe llamar");
      },
      ejecutarArgs: async () => ({
        codigoSalida: 0,
        salidaEstandar: "gemini-3.8-flash-low\tLow",
        salidaError: "",
        duracionMs: 10,
        timeoutVencido: false,
      }),
    };
    const entorno = { ...entornoReal(), ejecutor: ejecutorMock };
    const { chequeos } = await ejecutarChequeos(entorno, {
      repoDir,
      configPath,
      simulado: false,
      skipModelCheck: true,
    });
    const h = chequeos.find((c) => c.nombre === "herramienta");
    expect(h?.estado).toBe("aviso");
    expect(h?.detalle).toContain("modelo-inexistente-xyz");
  });

  it("preflight con runner opencode devuelve error explícito (B1)", async () => {
    const { repoDir, limpiar } = await crearRepoDesechable();
    limpiezas.push(limpiar);
    const configPath = join(repoDir, "batuta.yaml");
    await writeFile(
      configPath,
      [
        "proyecto: .",
        "ejecutor: opencode",
        "gates:",
        "  - { nombre: ok, comando: 'node -v', timeout_seg: 10 }",
      ].join("\n"),
      "utf8",
    );
    await confirmarTodo(repoDir);
    const { chequeos } = await ejecutarChequeos(entornoReal(), {
      repoDir,
      configPath,
      simulado: false,
    });
    const h = chequeos.find((c) => c.nombre === "herramienta");
    expect(h?.estado).toBe("error");
    expect(h?.detalle).toMatch(/opencode.*no soportado/);
  });
});

