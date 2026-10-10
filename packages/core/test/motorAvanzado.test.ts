import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EjecutorComandosReal,
  ModuloGitReal,
  MotorFlujo,
  RunStore,
  parseBatutaConfig,
  sistemaArchivosNode,
  type AgentCallContext,
  type AgentInput,
  type AgentRunResult,
  type AgentRunner,
  type BatutaConfig,
  type EjecutorComandos,
} from "../src/index.js";
import { NotificadorNulo } from "../src/index.js";
import { crearRelojFijo } from "./helpers.js";

class RunnerGuionado implements AgentRunner {
  readonly llamadas: Array<{ input: AgentInput; contexto: AgentCallContext }> = [];
  constructor(
    private readonly guion: (
      n: number,
      input: AgentInput,
      contexto: AgentCallContext,
    ) => Promise<AgentRunResult> | AgentRunResult,
  ) {}
  async ejecutar(input: AgentInput, contexto: AgentCallContext): Promise<AgentRunResult> {
    const n = this.llamadas.length;
    this.llamadas.push({ input, contexto });
    return this.guion(n, input, contexto);
  }
}

function resultadoExito(summary = "hecho", files: string[] = []): AgentRunResult {
  return {
    exito: true,
    output: {
      status: "SUCCESS",
      summary,
      files_modified: files,
      reported_checks: [],
      continuation_notes: "",
      blocking_question: "",
    },
    motivoFallo: null,
    uso: { tokensEntrada: 100, tokensSalida: 50, turnos: 1 },
    costoEstimado: { montoUsd: 0.001, desconocido: false },
    modeloEfectivo: "fake",
    duracionMs: 10,
    rutaLog: "",
    reintentos: 0,
  };
}

function configBase(over: Record<string, unknown> = {}): BatutaConfig {
  return parseBatutaConfig({
    proyecto: "repo",
    gates: [{ nombre: "ok", comando: "node -e \"process.exit(0)\"", timeout_seg: 60 }],
    alias_modelos: {
      rapido: { modelo: "m-rapido", entrada: 1, salida: 2, ventana: 100_000 },
      medio: { modelo: "m-medio", entrada: 1, salida: 2, ventana: 100_000 },
      fuerte: { modelo: "m-fuerte", entrada: 1, salida: 2, ventana: 200_000 },
      revisor: { modelo: "m-revisor", entrada: 1, salida: 2, ventana: 100_000 },
    },
    modelos: {
      scout: "rapido",
      resumenes: "rapido",
      architect: "fuerte",
      "software-engineer": { baja: "rapido", media: "medio", alta: "fuerte" },
      debugger: "fuerte",
      revisores: "revisor",
    },
    limites: {
      intentos_por_subtarea: 3,
      tokens_por_ejecucion: 1_000_000,
      minutos_por_ejecucion: 120,
      lineas_de_diff_max: 800,
      usd_por_agente: 2,
      pasos_por_agente: 5,
      timeout_comando_seg: 60,
      preguntas_bloqueantes: 3,
      continuaciones_por_subtarea: 2,
      timeout_preparacion_seg: 60,
    },
    aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: false },
    ...over,
  });
}

const PLAN_UNA = {
  subtareas: [
    { id: "SUB-01", titulo: "Unica", archivos: ["a.txt"], criterios: ["c1"], complejidad: "baja" },
  ],
};

describe("motor avanzado", () => {
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

  async function crearRepo(): Promise<{ base: string; repoDir: string }> {
    const base = await mkdtemp(join(tmpdir(), "batuta-motor3-"));
    const repoDir = join(base, "repo");
    await mkdir(repoDir, { recursive: true });
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git init -b main", { cwd: repoDir });
    await ejecutor.ejecutar("git config core.autocrlf false", { cwd: repoDir });
    await ejecutor.ejecutar("git config user.name 'Test'", { cwd: repoDir });
    await ejecutor.ejecutar("git config user.email 't@example.com'", { cwd: repoDir });
    await writeFile(join(repoDir, "README.md"), "# base\n", "utf8");
    await ejecutor.ejecutar("git add README.md", { cwd: repoDir });
    await ejecutor.ejecutar("git commit -m 'init'", { cwd: repoDir });
    limpiezas.push(async () => {
      try {
        await ejecutor.ejecutar("git worktree prune", { cwd: repoDir });
      } catch {}
      await rm(base, { recursive: true, force: true });
    });
    return { base, repoDir };
  }

  function crearMotor(base: string, runner: AgentRunner, ejecutor?: EjecutorComandos): { motor: MotorFlujo; store: RunStore; dirBatuta: string } {
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const motor = new MotorFlujo({
      runner,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: ejecutor ?? new EjecutorComandosReal(),
      store,
      reloj,
      notificador: new NotificadorNulo(),
      fs: sistemaArchivosNode,
    });
    return { motor, store, dirBatuta };
  }

  async function limpiar(base: string, dirBatuta: string, runId: string): Promise<void> {
    void base;
    try {
      const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
      await new ModuloGitReal(new EjecutorComandosReal()).eliminarWorktree(prog.worktree.ruta);
    } catch {}
  }

  it("CA-7 el mismo error dos veces escala al debugger", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({
      gates: [{ nombre: "falla-igual", comando: "node -e \"console.log('ERROR-XYZ-123');process.exit(1)\"", timeout_seg: 30 }],
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (n, _input, contexto) => {
      if (n < 2) {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
        return resultadoExito(`f${n}`, ["a.txt"]);
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      // El debugger también falla aquí para agotar; lo que importa es el rol.
      return resultadoExito("dbg", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    // Con 3 intentos y gates que siempre fallan igual, termina fallida pero el 3º es debugger.
    expect(r0.resultado).toBe("fallida");
    expect(runner.llamadas).toHaveLength(3);
    expect(runner.llamadas[2]?.contexto.rol).toBe("debugger");
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8")) as { subtareas: Array<{ firmas: string[] }> };
    expect(prog.subtareas[0]?.firmas[0]).toBe(prog.subtareas[0]?.firmas[1]);
    await limpiar(base, dirBatuta, r0.runId);
  }, 60000);

  it("CA-9 NEEDS_INPUT pausa, incluye la respuesta y respeta el máximo", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase();
    config.proyecto = repoDir;
    let llamadas = 0;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      llamadas += 1;
      if (llamadas === 1) {
        return {
          ...resultadoExito("duda"),
          output: {
            status: "NEEDS_INPUT",
            summary: "duda crítica",
            files_modified: [],
            reported_checks: [],
            continuation_notes: "",
            blocking_question: "¿Puedo usar la librería X?",
          },
        };
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("resuelto", ["a.txt"]);
    });
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("pausa-entrada");
    if (r0.resultado !== "pausa-entrada") throw new Error("esperaba entrada");
    expect(r0.pregunta).toMatch(/librería X/);
    expect((await store.estado(r0.runId)).estado).toBe("WAITING_INPUT");
    const runId = r0.runId;

    const r1 = await motor.responderEntrada(runId, dirBatuta, "Sí, usa X versión 2.");
    expect(r1.resultado).toBe("terminada");
    expect(runner.llamadas[1]?.contexto.prompt).toMatch(/Sí, usa X versión 2/);
    await limpiar(base, dirBatuta, runId);

    // Máximo de preguntas: con 1 permitida y dos dudas seguidas, falla.
    const config1 = configBase({
      limites: {
        intentos_por_subtarea: 3, tokens_por_ejecucion: 1_000_000, minutos_por_ejecucion: 120,
        lineas_de_diff_max: 800, usd_por_agente: 2, pasos_por_agente: 5, timeout_comando_seg: 60,
        preguntas_bloqueantes: 1, continuaciones_por_subtarea: 2, timeout_preparacion_seg: 60,
      },
    });
    config1.proyecto = repoDir;
    const runner2 = new RunnerGuionado(async () => ({
      ...resultadoExito("duda"),
      output: {
        status: "NEEDS_INPUT", summary: "duda", files_modified: [], reported_checks: [],
        continuation_notes: "", blocking_question: "¿Otra duda?",
      },
    }));
    const m2 = crearMotor(base, runner2);
    const s2 = await m2.motor.iniciar({
      config: config1, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: m2.dirBatuta,
    });
    expect(s2.resultado).toBe("pausa-entrada");
    if (s2.resultado !== "pausa-entrada") throw new Error("pausa");
    const f2 = await m2.motor.responderEntrada(s2.runId, m2.dirBatuta, "respuesta 1");
    expect(f2.resultado).toBe("fallida");
    await limpiar(base, m2.dirBatuta, s2.runId);
  }, 90000);

  it("CA-10 NEEDS_CONTINUATION abre sesión nueva con resumen y respeta el máximo", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase();
    config.proyecto = repoDir;
    let n = 0;
    const runner = new RunnerGuionado(async (_i, _input, contexto) => {
      n += 1;
      if (n === 1) {
        return {
          ...resultadoExito("a medias"),
          output: {
            status: "NEEDS_CONTINUATION", summary: "Hecho el 50%",
            files_modified: [], reported_checks: [], continuation_notes: "Falta el resto",
            blocking_question: "",
          },
        };
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("completo", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    expect(runner.llamadas).toHaveLength(2);
    expect(runner.llamadas[1]?.contexto.prompt).toMatch(/Hecho el 50%/);
    expect(runner.llamadas[1]?.contexto.prompt).toMatch(/Falta el resto/);
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8")) as { subtareas: Array<{ continuaciones: number }> };
    expect(prog.subtareas[0]?.continuaciones).toBe(1);
    await limpiar(base, dirBatuta, r0.runId);
  }, 60000);

  it("CA-11 límites de tokens y dólares, y advertencia sin precios", async () => {
    const { base, repoDir } = await crearRepo();
    // Tokens: límite ínfimo frente al uso real (150 por llamada).
    const configTok = configBase({
      limites: {
        intentos_por_subtarea: 3, tokens_por_ejecucion: 10, minutos_por_ejecucion: 120,
        lineas_de_diff_max: 800, usd_por_agente: 2, pasos_por_agente: 5, timeout_comando_seg: 60,
        preguntas_bloqueantes: 3, continuaciones_por_subtarea: 2, timeout_preparacion_seg: 60,
      },
    });
    configTok.proyecto = repoDir;
    const runnerTok = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("x", ["a.txt"]);
    });
    const mTok = crearMotor(base, runnerTok);
    const rTok = await mTok.motor.iniciar({
      config: configTok, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mTok.dirBatuta,
    });
    expect(rTok.resultado).toBe("fallida");
    if (rTok.resultado === "fallida") expect(rTok.motivo).toMatch(/tokens/i);
    await limpiar(base, mTok.dirBatuta, rTok.runId);

    // Dólares con precios conocidos: tope ínfimo.
    const configUsd = configBase({
      limites: {
        intentos_por_subtarea: 3, tokens_por_ejecucion: 1_000_000, minutos_por_ejecucion: 120,
        lineas_de_diff_max: 800, usd_por_agente: 0.000001, pasos_por_agente: 5, timeout_comando_seg: 60,
        preguntas_bloqueantes: 3, continuaciones_por_subtarea: 2, timeout_preparacion_seg: 60,
      },
    });
    configUsd.proyecto = repoDir;
    const runnerUsd = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("x", ["a.txt"]);
    });
    const mUsd = crearMotor(base, runnerUsd);
    const rUsd = await mUsd.motor.iniciar({
      config: configUsd, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mUsd.dirBatuta,
    });
    expect(rUsd.resultado).toBe("fallida");
    if (rUsd.resultado === "fallida") expect(rUsd.motivo).toMatch(/dólar/i);
    await limpiar(base, mUsd.dirBatuta, rUsd.runId);

    // Sin precios: solo tokens + evento de advertencia, termina bien.
    const configSin = parseBatutaConfig({
      proyecto: repoDir,
      gates: [{ nombre: "ok", comando: "node -e \"process.exit(0)\"", timeout_seg: 60 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: false },
    });
    const runnerSin = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("x", ["a.txt"]);
    });
    const mSin = crearMotor(base, runnerSin);
    const rSin = await mSin.motor.iniciar({
      config: configSin, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mSin.dirBatuta,
    });
    expect(rSin.resultado).toBe("terminada");
    const lectura = await mSin.store.leer(rSin.runId);
    expect(lectura.eventos.some((e) => e.tipo === "advertencia")).toBe(true);
    await limpiar(base, mSin.dirBatuta, rSin.runId);
  }, 90000);

  it("CA-12 abortar elimina worktree y rama y deja main intacta", async () => {
    const { base, repoDir } = await crearRepo();
    const ejecutor = new EjecutorComandosReal();
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    const config = configBase({
      aprobaciones: { H0_inicio: true, H1_spec: false, H2_plan: false, H3_merge: false },
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async () => resultadoExito());
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H0");
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    const ab = await motor.abortar(r0.runId, dirBatuta);
    expect(ab.resultado).toBe("abortada");
    expect((await store.estado(r0.runId)).estado).toBe("ABORTED");
    expect(existsSync(prog.worktree.ruta)).toBe(false);
    const ramas = await ejecutor.ejecutar("git branch --list \"batuta/*\"", { cwd: repoDir });
    expect(ramas.salidaEstandar.trim()).toBe("");
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
  }, 60000);

  it("CA-14 la preparación corre en el worktree y su fallo es claro", async () => {
    const { base, repoDir } = await crearRepo();
    // La preparación no debe dejar cambios versionables (p. ej. installs van a
    // ignorados); aquí un no-op que queda registrado en reports/preparacion.log.
    const configOk = configBase({ preparacion: ["node -e \"process.exit(0)\""] });
    configOk.proyecto = repoDir;
    const runnerOk = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("x", ["a.txt"]);
    });
    const mOk = crearMotor(base, runnerOk);
    const rOk = await mOk.motor.iniciar({
      config: configOk, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mOk.dirBatuta,
    });
    expect(rOk.resultado).toBe("terminada");
    const logPrep = await readFile(join(mOk.dirBatuta, "runs", rOk.runId, "reports", "preparacion.log"), "utf8");
    expect(logPrep).toMatch(/process\.exit\(0\)/);
    await limpiar(base, mOk.dirBatuta, rOk.runId);

    const configMal = configBase({ preparacion: ["node -e \"process.exit(3)\""] });
    configMal.proyecto = repoDir;
    const runnerMal = new RunnerGuionado(async () => resultadoExito());
    const mMal = crearMotor(base, runnerMal);
    const rMal = await mMal.motor.iniciar({
      config: configMal, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mMal.dirBatuta,
    });
    expect(rMal.resultado).toBe("fallida");
    if (rMal.resultado === "fallida") expect(rMal.motivo).toMatch(/Preparación fallida/);
    await limpiar(base, mMal.dirBatuta, rMal.runId);
  }, 60000);

  it("CA-16 summary.md con todos los datos", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({
      gates: [
        { nombre: "lint", comando: "node -e \"process.exit(0)\"", timeout_seg: 30 },
        { nombre: "tests", comando: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8').includes('OK')?0:1)\"", timeout_seg: 30 },
      ],
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (n, _input, contexto) => {
      if (n === 0) {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "BAD\n", "utf8");
        return resultadoExito("mal", ["a.txt"]);
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "OK\n", "utf8");
      return resultadoExito("bien", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    const resumen = await readFile(join(dirBatuta, "runs", r0.runId, "summary.md"), "utf8");
    expect(resumen).toMatch(/SUB-01/);
    expect(resumen).toMatch(/intentos/i);
    expect(resumen).toMatch(/tests/);
    expect(resumen).toMatch(/software-engineer/);
    expect(resumen).toMatch(/Duración/);
    await limpiar(base, dirBatuta, r0.runId);
  }, 60000);
});
