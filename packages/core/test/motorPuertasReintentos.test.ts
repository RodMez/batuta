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
  type Notificador,
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

describe("motor puertas y reintentos", () => {
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
    const base = await mkdtemp(join(tmpdir(), "batuta-motor2-"));
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

  function crearMotor(base: string, runner: AgentRunner, noti: Notificador = new NotificadorNulo()): { motor: MotorFlujo; store: RunStore; dirBatuta: string } {
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const motor = new MotorFlujo({
      runner,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(),
      store,
      reloj,
      notificador: noti,
      fs: sistemaArchivosNode,
    });
    return { motor, store, dirBatuta };
  }

  async function limpiarWorktree(base: string, dirBatuta: string, runId: string): Promise<void> {
    try {
      const prog = JSON.parse(
        await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8"),
      ) as { worktree: { ruta: string } };
      await new ModuloGitReal(new EjecutorComandosReal()).eliminarWorktree(prog.worktree.ruta);
    } catch {}
    void base;
  }

  it("CA-3 pausas, reanudación, cambio de spec y rechazo", async () => {
    const { base, repoDir } = await crearRepo();
    const runner = new RunnerGuionado(async (_n, input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("hecho", ["a.txt"]);
    });
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const config = configBase({
      aprobaciones: { H0_inicio: true, H1_spec: true, H2_plan: false, H3_merge: false },
    });
    config.proyecto = repoDir;

    const r0 = await motor.iniciar({
      config,
      specContenido: "# SPEC v1\n",
      planContenido: PLAN_UNA,
      reglasRepo: "R",
      directorioRepo: repoDir,
      dirBatuta,
    });
    expect(r0.resultado).toBe("pausa-aprobacion");
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H0");
    const runId = r0.runId;
    // Solicitud legible en la carpeta
    expect(existsSync(join(dirBatuta, "runs", runId, "aprobacion-H0.md"))).toBe(true);

    const r1 = await motor.aprobar(runId, dirBatuta, "H0");
    expect(r1.resultado).toBe("pausa-aprobacion");
    if (r1.resultado !== "pausa-aprobacion") throw new Error("H1");
    expect(r1.puerta).toBe("H1");

    // La spec cambia mientras está pausada en H1: la primera aprobación pide de nuevo.
    await writeFile(join(dirBatuta, "runs", runId, "spec.md"), "# SPEC v2\n", "utf8");
    const r1b = await motor.aprobar(runId, dirBatuta, "H1");
    expect(r1b.resultado).toBe("pausa-aprobacion");
    if (r1b.resultado !== "pausa-aprobacion") throw new Error("re-H1");
    expect(r1b.puerta).toBe("H1");
    // Segunda llamada aprueba la versión nueva y termina (sin H3).
    const r1c = await motor.aprobar(runId, dirBatuta, "H1");
    expect(r1c.resultado).toBe("terminada");
    const est = await store.estado(runId);
    expect(est.estado).toBe("DONE");
    await limpiarWorktree(base, dirBatuta, runId);
  }, 60000);

  it("CA-3 un rechazo termina en ABORTED y limpia", async () => {
    const { base, repoDir } = await crearRepo();
    const ejecutor = new EjecutorComandosReal();
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    const runner = new RunnerGuionado(async () => resultadoExito());
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const config = configBase({
      aprobaciones: { H0_inicio: true, H1_spec: true, H2_plan: false, H3_merge: false },
    });
    config.proyecto = repoDir;
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H0");
    const runId = r0.runId;
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    const rutaWt = prog.worktree.ruta;
    const rej = await motor.rechazar(runId, dirBatuta, "H0", "no me gusta");
    expect(rej.resultado).toBe("abortada");
    expect((await store.estado(runId)).estado).toBe("ABORTED");
    expect(existsSync(rutaWt)).toBe(false);
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
  }, 60000);

  it("CA-4 un fallo de gates provoca segundo intento con modelo superior", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({
      gates: [{ nombre: "contenido", comando: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8').includes('OK')?0:1)\"", timeout_seg: 30 }],
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (n, _input, contexto) => {
      if (n === 0) {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "BAD\n", "utf8");
        return resultadoExito("intento 1", ["a.txt"]);
      }
      // Segundo intento: el worktree conserva el fallo anterior; se corrige.
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "OK\n", "utf8");
      return resultadoExito("intento 2", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    expect(runner.llamadas).toHaveLength(2);
    expect(runner.llamadas[0]?.contexto.modelo).toBe("m-rapido");
    expect(runner.llamadas[1]?.contexto.modelo).toBe("m-medio");
    expect(runner.llamadas[0]?.contexto.rol).toBe("software-engineer");
    expect(runner.llamadas[1]?.contexto.rol).toBe("software-engineer");
    await limpiarWorktree(base, dirBatuta, r0.runId);
  }, 60000);

  it("CA-5 tras dos fallos entra el debugger con el modelo fuerte y continúa", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({
      gates: [{ nombre: "contenido", comando: "node -e \"const fs=require('fs');process.exit(fs.readFileSync('a.txt','utf8').includes('OK')?0:1)\"", timeout_seg: 30 }],
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (n, _input, contexto) => {
      if (n < 2) {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "BAD\n", "utf8");
        return resultadoExito(`fallo ${n + 1}`, ["a.txt"]);
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "OK\n", "utf8");
      return resultadoExito("debugger lo arregla", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    expect(runner.llamadas).toHaveLength(3);
    expect(runner.llamadas[2]?.contexto.rol).toBe("debugger");
    expect(runner.llamadas[2]?.contexto.modelo).toBe("m-fuerte");
    await limpiarWorktree(base, dirBatuta, r0.runId);
  }, 60000);

  it("CA-6 agotados los intentos falla, resetea y deja main intacta", async () => {
    const { base, repoDir } = await crearRepo();
    const ejecutor = new EjecutorComandosReal();
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    const config = configBase({
      gates: [{ nombre: "siempre-falla", comando: "node -e \"process.exit(1)\"", timeout_seg: 30 }],
      limites: {
        intentos_por_subtarea: 2, tokens_por_ejecucion: 1_000_000, minutos_por_ejecucion: 120,
        lineas_de_diff_max: 800, usd_por_agente: 2, pasos_por_agente: 5, timeout_comando_seg: 60,
        preguntas_bloqueantes: 3, continuaciones_por_subtarea: 2, timeout_preparacion_seg: 60,
      },
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("siempre mal", ["a.txt"]);
    });
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("fallida");
    if (r0.resultado !== "fallida") throw new Error("fallida");
    expect(r0.motivo).toMatch(/SUB-01/);
    expect((await store.estado(r0.runId)).estado).toBe("FAILED");
    expect(runner.llamadas).toHaveLength(2);
    // Worktree vuelve al último commit: sin a.txt
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    expect(existsSync(join(prog.worktree.ruta, "a.txt"))).toBe(false);
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
    await limpiarWorktree(base, dirBatuta, r0.runId);
  }, 60000);

  it("CA-8 ruta prohibida cuenta como fallo, resetea y el siguiente prompt trae las violaciones", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({ rutas_prohibidas: [".env"] });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (n, _input, contexto) => {
      if (n === 0) {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
        await writeFile(join(contexto.directorioTrabajo, ".env"), "SECRETO=1\n", "utf8");
        return resultadoExito("toca prohibido", ["a.txt", ".env"]);
      }
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("corregido", ["a.txt"]);
    });
    const { motor, dirBatuta } = crearMotor(base, runner);
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    expect(runner.llamadas).toHaveLength(2);
    expect(runner.llamadas[1]?.contexto.prompt).toMatch(/\.env/);
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    expect(existsSync(join(prog.worktree.ruta, ".env"))).toBe(false);
    await limpiarWorktree(base, dirBatuta, r0.runId);
  }, 60000);

  it("H2 activada: pausa, aprobación y continuación hasta DONE", async () => {
    const { base, repoDir } = await crearRepo();
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("hecho", ["a.txt"]);
    });
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const config = configBase({
      aprobaciones: { H0_inicio: false, H1_spec: true, H2_plan: true, H3_merge: false },
    });
    config.proyecto = repoDir;

    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("pausa-aprobacion");
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H1");
    const runId = r0.runId;

    const r1 = await motor.aprobar(runId, dirBatuta, "H1");
    expect(r1.resultado).toBe("pausa-aprobacion");
    if (r1.resultado !== "pausa-aprobacion") throw new Error("H2");
    expect(r1.puerta).toBe("H2");
    expect(existsSync(join(dirBatuta, "runs", runId, "aprobacion-H2.md"))).toBe(true);

    const r2 = await motor.aprobar(runId, dirBatuta, "H2");
    expect(r2.resultado).toBe("terminada");
    expect((await store.estado(runId)).estado).toBe("DONE");
    await limpiarWorktree(base, dirBatuta, runId);
  }, 60000);

  it("H2 activada: cambio de plan.json mientras está pausada pide aprobar de nuevo", async () => {
    const { base, repoDir } = await crearRepo();
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("hecho", ["a.txt"]);
    });
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const config = configBase({
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: true, H3_merge: false },
    });
    config.proyecto = repoDir;

    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("pausa-aprobacion");
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H2");
    const runId = r0.runId;

    const planV2 = {
      subtareas: [
        { id: "SUB-01", titulo: "Unica v2", archivos: ["a.txt"], criterios: ["c1"], complejidad: "baja" },
      ],
    };
    await writeFile(join(dirBatuta, "runs", runId, "plan.json"), `${JSON.stringify(planV2, null, 2)}\n`, "utf8");
    const r1 = await motor.aprobar(runId, dirBatuta, "H2");
    expect(r1.resultado).toBe("pausa-aprobacion");
    if (r1.resultado !== "pausa-aprobacion") throw new Error("re-H2");
    expect(r1.puerta).toBe("H2");
    const r2 = await motor.aprobar(runId, dirBatuta, "H2");
    expect(r2.resultado).toBe("terminada");
    expect((await store.estado(runId)).estado).toBe("DONE");
    await limpiarWorktree(base, dirBatuta, runId);
  }, 60000);

  it("H2 activada: un rechazo termina en ABORTED y limpia", async () => {
    const { base, repoDir } = await crearRepo();
    const ejecutor = new EjecutorComandosReal();
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    const runner = new RunnerGuionado(async () => resultadoExito());
    const { motor, store, dirBatuta } = crearMotor(base, runner);
    const config = configBase({
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: true, H3_merge: false },
    });
    config.proyecto = repoDir;
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H2");
    const runId = r0.runId;
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    const rej = await motor.rechazar(runId, dirBatuta, "H2", "plan insuficiente");
    expect(rej.resultado).toBe("abortada");
    expect((await store.estado(runId)).estado).toBe("ABORTED");
    expect(existsSync(prog.worktree.ruta)).toBe(false);
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
  }, 60000);

  it("H2 activada: interrupción en PLAN reanuda pidiendo H2", async () => {
    const { base, repoDir } = await crearRepo();
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "ok\n", "utf8");
      return resultadoExito("hecho", ["a.txt"]);
    });
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const motor = new MotorFlujo({
      runner, git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(), store, reloj,
      notificador: new NotificadorNulo(), fs: sistemaArchivosNode,
    });
    const config = configBase({
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: true, H3_merge: false },
    });
    config.proyecto = repoDir;

    const realAgregar = store.agregar.bind(store);
    let roto = false;
    (store as unknown as { agregar: unknown }).agregar = async (rid: string, ev: never) => {
      const res = await realAgregar(rid, ev as never);
      const e = ev as { tipo?: string };
      if (!roto && e.tipo === "plan_creado") {
        roto = true;
        throw new Error("caída simulada justo después de emitir el plan");
      }
      return res;
    };
    let runId = "";
    try {
      const r = await motor.iniciar({
        config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
        directorioRepo: repoDir, dirBatuta,
      });
      runId = r.runId;
    } catch (e) {
      const { readdir } = await import("node:fs/promises");
      runId = (await readdir(join(dirBatuta, "runs")))[0]!;
      expect(String(e)).toMatch(/caída simulada/);
    }
    (store as unknown as { agregar: unknown }).agregar = realAgregar;

    const r2 = await motor.reanudar(runId, dirBatuta);
    expect(r2.resultado).toBe("pausa-aprobacion");
    if (r2.resultado !== "pausa-aprobacion") throw new Error("H2 tras reanudar");
    expect(r2.puerta).toBe("H2");
    const r3 = await motor.aprobar(runId, dirBatuta, "H2");
    expect(r3.resultado).toBe("terminada");
    expect((await store.estado(runId)).estado).toBe("DONE");
    await limpiarWorktree(base, dirBatuta, runId);
  }, 90000);
});
