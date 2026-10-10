import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
  type Reloj,
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

describe("motor reanudación y minutos", () => {
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
    const base = await mkdtemp(join(tmpdir(), "batuta-motor4-"));
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

  function crearMotor(base: string, runner: AgentRunner, ejecutor?: EjecutorComandos, reloj?: Reloj): { motor: MotorFlujo; store: RunStore; dirBatuta: string } {
    const dirBatuta = join(base, "data");
    const rj = reloj ?? crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, rj);
    const motor = new MotorFlujo({
      runner,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: ejecutor ?? new EjecutorComandosReal(),
      store,
      reloj: rj,
      notificador: new NotificadorNulo(),
      fs: sistemaArchivosNode,
    });
    return { motor, store, dirBatuta };
  }

  async function contenidoFinal(dirBatuta: string, runId: string): Promise<string> {
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
    return readFile(join(prog.worktree.ruta, "a.txt"), "utf8");
  }

  async function limpiar(base: string, dirBatuta: string, runId: string): Promise<void> {
    void base;
    try {
      const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { worktree: { ruta: string } };
      await new ModuloGitReal(new EjecutorComandosReal()).eliminarWorktree(prog.worktree.ruta);
    } catch {}
  }

  it("CA-13 a mitad de implementar: el intento interrumpido no cuenta y el final es igual", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase();
    config.proyecto = repoDir;

    // Referencia limpia sin interrupción.
    const runnerLimpio = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "contenido final\n", "utf8");
      return resultadoExito("ok", ["a.txt"]);
    });
    const mLimpio = crearMotor(base, runnerLimpio);
    const rLimpio = await mLimpio.motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta: mLimpio.dirBatuta,
    });
    expect(rLimpio.resultado).toBe("terminada");
    const contenidoLimpio = await contenidoFinal(mLimpio.dirBatuta, rLimpio.runId);
    await limpiar(base, mLimpio.dirBatuta, rLimpio.runId);

    // Con interrupción en la primera llamada al runner.
    let fallos = 0;
    const runnerRoto = new RunnerGuionado(async (_n, _input, contexto) => {
      fallos += 1;
      if (fallos === 1) throw new Error("caída simulada a mitad de implementar");
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "contenido final\n", "utf8");
      return resultadoExito("ok tras reanudar", ["a.txt"]);
    });
    // dirBatuta distinto para no chocar runIds: usa subcarpeta propia.
    const dirBatuta2 = join(base, "data2");
    const reloj2 = crearRelojFijo();
    const store2 = new RunStore(dirBatuta2, sistemaArchivosNode, reloj2);
    const motor2 = new MotorFlujo({
      runner: runnerRoto,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(),
      store: store2,
      reloj: reloj2,
      notificador: new NotificadorNulo(),
      fs: sistemaArchivosNode,
    });
    let runId = "";
    try {
      const r = await motor2.iniciar({
        config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
        directorioRepo: repoDir, dirBatuta: dirBatuta2,
      });
      runId = r.runId;
    } catch (e) {
      // Recuperar el runId creado antes de la caída.
      const { readdir } = await import("node:fs/promises");
      const runs = await readdir(join(dirBatuta2, "runs"));
      runId = runs[0]!;
      expect(String(e)).toMatch(/caída simulada/);
    }
    const r2 = await motor2.reanudar(runId, dirBatuta2);
    expect(r2.resultado).toBe("terminada");
    expect(await contenidoFinal(dirBatuta2, runId)).toBe(contenidoLimpio);
    const prog = JSON.parse(await readFile(join(dirBatuta2, "runs", runId, "motor.json"), "utf8")) as { subtareas: Array<{ intentos: number }> };
    expect(prog.subtareas[0]?.intentos).toBe(0);
    await limpiar(base, dirBatuta2, runId);
  }, 90000);

  it("CA-13 a mitad de evaluar y tras el commit: mismo final sin contar intento", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase();
    config.proyecto = repoDir;

    // Interrupción en gates (a mitad de evaluar).
    const runnerOk = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "v\n", "utf8");
      return resultadoExito("ok", ["a.txt"]);
    });
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    let fallosGate = 0;
    const ejecutorRoto: EjecutorComandos = {
      ejecutar: async (comando, opciones) => {
        fallosGate += 1;
        if (fallosGate === 1) throw new Error("caída simulada a mitad de evaluar");
        return new EjecutorComandosReal().ejecutar(comando, opciones);
      },
      ejecutarArgs: (bin, args, opciones) =>
        new EjecutorComandosReal().ejecutarArgs(bin, args, opciones),
    };
    const motor = new MotorFlujo({
      runner: runnerOk, git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: ejecutorRoto, store, reloj,
      notificador: new NotificadorNulo(), fs: sistemaArchivosNode,
    });
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
    const r2 = await motor.reanudar(runId, dirBatuta);
    expect(r2.resultado).toBe("terminada");
    const prog = JSON.parse(await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8")) as { subtareas: Array<{ intentos: number }> };
    expect(prog.subtareas[0]?.intentos).toBe(0);
    await limpiar(base, dirBatuta, runId);

    // Interrupción tras el commit y antes del checkpoint.
    const dirBatuta2 = join(base, "data2");
    const reloj2 = crearRelojFijo();
    const store2 = new RunStore(dirBatuta2, sistemaArchivosNode, reloj2);
    const runner2 = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "v\n", "utf8");
      return resultadoExito("ok", ["a.txt"]);
    });
    const motor2 = new MotorFlujo({
      runner: runner2, git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(), store: store2, reloj: reloj2,
      notificador: new NotificadorNulo(), fs: sistemaArchivosNode,
    });
    const realAgregar = store2.agregar.bind(store2);
    let roto = false;
    (store2 as unknown as { agregar: unknown }).agregar = async (rid: string, ev: never) => {
      const e = ev as { tipo?: string };
      if (!roto && e.tipo === "checkpoint_creado") {
        roto = true;
        throw new Error("caída simulada tras el commit");
      }
      return realAgregar(rid, ev as never);
    };
    let runId2 = "";
    try {
      const r = await motor2.iniciar({
        config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
        directorioRepo: repoDir, dirBatuta: dirBatuta2,
      });
      runId2 = r.runId;
    } catch (e) {
      const { readdir } = await import("node:fs/promises");
      runId2 = (await readdir(join(dirBatuta2, "runs")))[0]!;
      expect(String(e)).toMatch(/caída simulada/);
    }
    const r3 = await motor2.reanudar(runId2, dirBatuta2);
    expect(r3.resultado).toBe("terminada");
    const prog2 = JSON.parse(await readFile(join(dirBatuta2, "runs", runId2, "motor.json"), "utf8")) as { subtareas: Array<{ intentos: number }> };
    expect(prog2.subtareas[0]?.intentos).toBe(0);
    await limpiar(base, dirBatuta2, runId2);
  }, 120000);

  it("CA-13 después de una aprobación: reanuda sin repetir la puerta", async () => {
    const { base, repoDir } = await crearRepo();
    const config = configBase({
      aprobaciones: { H0_inicio: true, H1_spec: false, H2_plan: false, H3_merge: false },
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "v\n", "utf8");
      return resultadoExito("ok", ["a.txt"]);
    });
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const motor = new MotorFlujo({
      runner, git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(), store, reloj,
      notificador: new NotificadorNulo(), fs: sistemaArchivosNode,
    });
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    if (r0.resultado !== "pausa-aprobacion") throw new Error("H0");
    const runId = r0.runId;
    // Interrumpir justo después de otorgar H0: el wrapper persiste y luego lanza.
    const realAgregar = store.agregar.bind(store);
    let roto = false;
    (store as unknown as { agregar: unknown }).agregar = async (rid: string, ev: never) => {
      const res = await realAgregar(rid, ev as never);
      const e = ev as { tipo?: string };
      if (!roto && e.tipo === "aprobacion_otorgada") {
        roto = true;
        throw new Error("caída simulada tras aprobar");
      }
      return res;
    };
    try {
      await motor.aprobar(runId, dirBatuta, "H0");
    } catch (e) {
      expect(String(e)).toMatch(/caída simulada/);
    }
    (store as unknown as { agregar: unknown }).agregar = realAgregar;
    const r2 = await motor.reanudar(runId, dirBatuta);
    expect(r2.resultado).toBe("terminada");
    const lectura = await store.leer(runId);
    expect(lectura.eventos.filter((e) => e.tipo === "aprobacion_otorgada").length).toBe(1);
    await limpiar(base, dirBatuta, runId);
  }, 90000);

  it("CA-11 el límite de minutos termina en FAILED", async () => {
    const { base, repoDir } = await crearRepo();
    let t = Date.parse("2026-10-10T10:00:00.000Z");
    const relojAvance: Reloj = { ahoraIso: () => { t += 60_000; return new Date(t).toISOString(); } };
    const config = configBase({
      limites: {
        intentos_por_subtarea: 3, tokens_por_ejecucion: 1_000_000, minutos_por_ejecucion: 0.05,
        lineas_de_diff_max: 800, usd_por_agente: 2, pasos_por_agente: 5, timeout_comando_seg: 60,
        preguntas_bloqueantes: 3, continuaciones_por_subtarea: 2, timeout_preparacion_seg: 60,
      },
    });
    config.proyecto = repoDir;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito("x", ["a.txt"]);
    });
    const dirBatuta = join(base, "data");
    const store = new RunStore(dirBatuta, sistemaArchivosNode, relojAvance);
    const motor = new MotorFlujo({
      runner, git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(), store, reloj: relojAvance,
      notificador: new NotificadorNulo(), fs: sistemaArchivosNode,
    });
    const r0 = await motor.iniciar({
      config, specContenido: "s", planContenido: PLAN_UNA, reglasRepo: "R",
      directorioRepo: repoDir, dirBatuta,
    });
    expect(r0.resultado).toBe("fallida");
    if (r0.resultado === "fallida") expect(r0.motivo).toMatch(/minutos/i);
    await limpiar(base, dirBatuta, r0.runId);
  }, 60000);
});
