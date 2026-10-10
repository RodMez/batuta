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

function resultadoExito(files: string[] = []): AgentRunResult {
  return {
    exito: true,
    output: {
      status: "SUCCESS",
      summary: "hecho",
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

describe("abortar tras el final", () => {
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

  it("limpia el worktree de una ejecución DONE sin lanzar ni tocar main", async () => {
    const base = await mkdtemp(join(tmpdir(), "batuta-abort-"));
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
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();

    const config = parseBatutaConfig({
      proyecto: repoDir,
      gates: [{ nombre: "ok", comando: "node -e \"process.exit(0)\"", timeout_seg: 60 }],
      aprobaciones: { H0_inicio: false, H1_spec: false, H2_plan: false, H3_merge: false },
    }) as BatutaConfig;
    const runner = new RunnerGuionado(async (_n, _input, contexto) => {
      await writeFile(join(contexto.directorioTrabajo, "a.txt"), "x\n", "utf8");
      return resultadoExito(["a.txt"]);
    });
    const dirBatuta = join(base, "data");
    const reloj = crearRelojFijo();
    const store = new RunStore(dirBatuta, sistemaArchivosNode, reloj);
    const motor = new MotorFlujo({
      runner,
      git: new ModuloGitReal(new EjecutorComandosReal()),
      ejecutor: new EjecutorComandosReal(),
      store,
      reloj,
      notificador: new NotificadorNulo(),
      fs: sistemaArchivosNode,
    });
    const r0 = await motor.iniciar({
      config,
      specContenido: "s",
      planContenido: {
        subtareas: [
          { id: "SUB-01", titulo: "U", archivos: ["a.txt"], criterios: ["c"], complejidad: "baja" },
        ],
      },
      reglasRepo: "R",
      directorioRepo: repoDir,
      dirBatuta,
    });
    expect(r0.resultado).toBe("terminada");
    expect((await store.estado(r0.runId)).estado).toBe("DONE");

    const prog = JSON.parse(
      await readFile(join(dirBatuta, "runs", r0.runId, "motor.json"), "utf8"),
    ) as { worktree: { ruta: string } };
    const ab = await motor.abortar(r0.runId, dirBatuta);
    expect(ab.resultado).toBe("abortada");
    expect(existsSync(prog.worktree.ruta)).toBe(false);
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
  }, 60000);
});
