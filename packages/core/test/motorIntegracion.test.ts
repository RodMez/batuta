import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EjecutorComandosReal,
  ModuloGitReal,
  MotorFlujo,
  NotificadorNulo,
  RunStore,
  parseBatutaConfig,
  sistemaArchivosNode,
  type AgentCallContext,
  type AgentInput,
  type AgentRunResult,
  type AgentRunner,
  type Aviso,
  type BatutaConfig,
  type Notificador,
} from "../src/index.js";
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

class NotificadorGrabador implements Notificador {
  readonly avisos: Aviso[] = [];
  async notificar(aviso: Aviso): Promise<void> {
    this.avisos.push(aviso);
  }
}

function resultadoExito(
  summary = "hecho",
  files: string[] = [],
  extra?: Partial<AgentRunResult>,
): AgentRunResult {
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
    ...extra,
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
    aprobaciones: { H0_inicio: true, H1_spec: true, H2_plan: false, H3_merge: true },
    ...over,
  });
}

const PLAN_DOS = {
  subtareas: [
    { id: "SUB-01", titulo: "Primera", archivos: ["a.txt"], criterios: ["c1"], complejidad: "baja" },
    { id: "SUB-02", titulo: "Segunda", archivos: ["b.txt"], criterios: ["c2"], complejidad: "media" },
  ],
};

describe("motor integración", () => {
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
    const base = await mkdtemp(join(tmpdir(), "batuta-motor-"));
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

  function crearMotor(
    base: string,
    runner: AgentRunner,
    notificador?: Notificador,
  ): { motor: MotorFlujo; store: RunStore; dirBatuta: string; avisos: NotificadorGrabador } {
    const dirBatuta = join(base, "batuta-data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const avisos = new NotificadorGrabador();
    const motor = new MotorFlujo({
      runner,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(),
      store,
      reloj,
      notificador: notificador ?? avisos,
      fs: sistemaArchivosNode,
    });
    return { motor, store, dirBatuta, avisos };
  }

  it("CA-2 camino feliz: dos subtareas, H0/H1/H3, DONE con un commit por subtarea y main intacta", async () => {
    const { base, repoDir } = await crearRepo();
    const ejecutor = new EjecutorComandosReal();
    const headInicial = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();

    const runner = new RunnerGuionado(async (_n, input, contexto) => {
      if (input.task_id === "SUB-01") {
        await writeFile(join(contexto.directorioTrabajo, "a.txt"), "contenido A\n", "utf8");
        return resultadoExito("sub1 lista", ["a.txt"]);
      }
      await writeFile(join(contexto.directorioTrabajo, "b.txt"), "contenido B\n", "utf8");
      return resultadoExito("sub2 lista", ["b.txt"]);
    });
    const { motor, store, dirBatuta, avisos } = crearMotor(base, runner);
    const config = configBase();
    config.proyecto = repoDir;

    const r0 = await motor.iniciar({
      config,
      specContenido: "# SPEC demo\n",
      planContenido: PLAN_DOS,
      reglasRepo: "Reglas",
      directorioRepo: repoDir,
      dirBatuta,
    });
    expect(r0.resultado).toBe("pausa-aprobacion");
    if (r0.resultado !== "pausa-aprobacion") throw new Error("esperaba H0");
    expect(r0.puerta).toBe("H0");
    const runId = r0.runId;

    const r1 = await motor.aprobar(runId, dirBatuta, "H0");
    expect(r1.resultado).toBe("pausa-aprobacion");
    const r2 = await motor.aprobar(runId, dirBatuta, "H1");
    expect(r2.resultado).toBe("pausa-aprobacion");
    if (r2.resultado !== "pausa-aprobacion") throw new Error("esperaba H3");
    expect(r2.puerta).toBe("H3");

    const r3 = await motor.aprobar(runId, dirBatuta, "H3");
    expect(r3.resultado).toBe("terminada");

    const estado = await store.estado(runId);
    expect(estado.estado).toBe("DONE");

    // summary.md con los datos pedidos
    const resumen = await readFile(join(dirBatuta, "runs", runId, "summary.md"), "utf8");
    expect(resumen).toMatch(/SUB-01/);
    expect(resumen).toMatch(/SUB-02/);
    expect(resumen).toMatch(/intentos/i);
    expect(resumen).toMatch(/tokens/i);

    // Un commit por subtarea en la rama de la ejecución
    const progreso = JSON.parse(
      await readFile(join(dirBatuta, "runs", runId, "motor.json"), "utf8"),
    ) as { worktree: { ruta: string } };
    const log = await ejecutor.ejecutar("git log --oneline", { cwd: progreso.worktree.ruta });
    expect(log.salidaEstandar.trim().split(/\r?\n/)).toHaveLength(3); // init + 2 subtareas

    // La rama principal queda intacta
    const headFinal = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(headFinal).toBe(headInicial);
    expect(existsSync(join(repoDir, "a.txt"))).toBe(false);
    expect(existsSync(join(repoDir, "b.txt"))).toBe(false);

    // Notificador invocado en pausas y final
    expect(avisos.avisos.length).toBeGreaterThan(0);

    // Limpieza del worktree para no dejar restos
    const git = new ModuloGitReal(new EjecutorComandosReal());
    try {
      await git.eliminarWorktree(progreso.worktree.ruta);
    } catch {}
  }, 60000);

  it("usa NotificadorNulo sin fallar", async () => {
    expect(new NotificadorNulo()).toBeDefined();
  });
});
