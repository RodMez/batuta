import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  EjecutorComandosReal,
  existeProceso,
  matarArbolProcesos,
  ModuloGitReal,
} from "@batuta/core";
import { StatusJsonSchema } from "../src/comandos/status.js";

const RAIZ = join(import.meta.dirname, "..", "..", "..");
const DEMO = join(RAIZ, "examples", "demo");

async function asegurarBinario(): Promise<string> {
  const bin = join(RAIZ, "packages", "cli", "dist", "index.js");
  try {
    await access(bin);
    return bin;
  } catch {
    const tsc = join(RAIZ, "node_modules", "typescript", "bin", "tsc");
    const res = spawnSync(process.execPath, [tsc, "--build"], {
      cwd: RAIZ,
      encoding: "utf8",
      timeout: 300000,
    });
    if (res.status !== 0) {
      throw new Error(`No se pudo compilar el CLI: ${res.stderr}`);
    }
    return bin;
  }
}

function ejecutarBin(
  bin: string,
  args: string[],
  cwd: string,
): { codigo: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [bin, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { codigo: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function crearRepo(): Promise<{ base: string; repoDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "batuta-e2e-"));
  const repoDir = join(base, "repo");
  await mkdir(repoDir, { recursive: true });
  const ejecutor = new EjecutorComandosReal();
  const git = (c: string): Promise<unknown> => ejecutor.ejecutar(c, { cwd: repoDir });
  await git("git init -b main");
  await git("git config core.autocrlf false");
  await git("git config user.name 'E2E'");
  await git("git config user.email 'e2e@example.com'");
  await writeFile(join(repoDir, "README.md"), "# base\n", "utf8");
  await git("git add README.md");
  await git("git commit -m 'init'");
  return { base, repoDir };
}

function extraerRunId(salida: string): string {
  const runId = (salida.match(/RUN-\d{4}-\d{2}-\d{2}-\d+/) ?? [""])[0]!;
  expect(runId.length).toBeGreaterThan(0);
  return runId;
}

function argsDemo(repoDir: string): string[] {
  return [
    "--repo",
    repoDir,
    "--config",
    join(DEMO, "batuta-demo.yaml"),
    "--spec",
    join(DEMO, "spec.md"),
    "--plan",
    join(DEMO, "plan.json"),
    "--simulado",
    join(DEMO, "guion.json"),
  ];
}

describe("e2e con el binario real", () => {
  let bin = "";
  const limpiezas: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    bin = await asegurarBinario();
  }, 300000);

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

  async function limpiarRepo(repoDir: string, base: string): Promise<void> {
    const ejecutor = new EjecutorComandosReal();
    try {
      await ejecutor.ejecutar("git worktree prune", { cwd: repoDir });
    } catch {}
    await rm(base, { recursive: true, force: true });
  }

  it("CA-2 y CA-11: flujo completo con la demo y las cuatro puertas", async () => {
    for (const f of ["spec.md", "plan.json", "guion.json", "batuta-demo.yaml", "README.md"]) {
      await access(join(DEMO, f));
    }
    const { base, repoDir } = await crearRepo();
    limpiezas.push(() => limpiarRepo(repoDir, base));
    const demo = argsDemo(repoDir);

    const r0 = ejecutarBin(bin, ["run", ...demo], repoDir);
    expect(r0.codigo).toBe(10);
    const runId = extraerRunId(r0.stdout);
    for (const puerta of ["H0", "H1", "H2"]) {
      const r = ejecutarBin(bin, ["approve", runId, puerta, "--repo", repoDir, "--simulado", join(DEMO, "guion.json")], repoDir);
      expect(r.codigo).toBe(10);
    }
    const st = ejecutarBin(bin, ["status", runId, "--repo", repoDir, "--json"], repoDir);
    expect(st.codigo).toBe(0);
    expect(() => StatusJsonSchema.parse(JSON.parse(st.stdout))).not.toThrow();

    const fin = ejecutarBin(bin, ["approve", runId, "H3", "--repo", repoDir, "--simulado", join(DEMO, "guion.json")], repoDir);
    expect(fin.codigo).toBe(0);
    expect(fin.stdout).toMatch(/DONE/);

    const prog = JSON.parse(
      await readFile(join(repoDir, ".batuta", "runs", runId, "motor.json"), "utf8"),
    ) as { worktree: { ruta: string } };
    expect(await readFile(join(prog.worktree.ruta, "saludo.txt"), "utf8")).toBe("Hola desde Batuta\n");
    expect(await readFile(join(prog.worktree.ruta, "despedida.txt"), "utf8")).toBe("Adiós desde Batuta\n");

    const bye = ejecutarBin(bin, ["abort", runId, "--repo", repoDir, "--yes"], repoDir);
    expect(bye.codigo).toBe(0);
    const git = new ModuloGitReal(new EjecutorComandosReal());
    expect(await git.listarWorktrees(repoDir)).toHaveLength(1);
  }, 180000);

  it("CA-4: duda crítica con código 11 y answer que continúa", async () => {
    const { base, repoDir } = await crearRepo();
    limpiezas.push(() => limpiarRepo(repoDir, base));
    const guion = join(base, "guion-input.json");
    await writeFile(
      guion,
      JSON.stringify({
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
      }),
      "utf8",
    );
    const plan = join(base, "plan.json");
    await writeFile(
      plan,
      JSON.stringify({
        subtareas: [
          { id: "SUB-01", titulo: "U", archivos: ["a.txt"], criterios: ["c"], complejidad: "baja" },
        ],
      }),
      "utf8",
    );
    const spec = join(base, "spec.md");
    await writeFile(spec, "# s\n", "utf8");
    const configLibre = join(base, "batuta-libre.yaml");
    await writeFile(
      configLibre,
      [
        "proyecto: .",
        "gates:",
        "  - { nombre: ok, comando: \"node -e \\\"process.exit(0)\\\"\", timeout_seg: 60 }",
        "aprobaciones:",
        "  H0_inicio: false",
        "  H1_spec: false",
        "  H2_plan: false",
        "  H3_merge: false",
        "",
      ].join("\n"),
      "utf8",
    );
    const args = [
      "--repo",
      repoDir,
      "--config",
      configLibre,
      "--spec",
      spec,
      "--plan",
      plan,
      "--simulado",
      guion,
    ];
    const r0 = ejecutarBin(bin, ["run", ...args], repoDir);
    expect(r0.codigo).toBe(11);
    expect(r0.stdout).toMatch(/¿Sigo con X\?/);
    const runId = extraerRunId(r0.stdout);
    const r1 = ejecutarBin(bin, ["answer", runId, "Sí,", "adelante", "--repo", repoDir, "--simulado", guion], repoDir);
    expect(r1.codigo).toBe(0);
  }, 180000);

  it("CA-5: matar a mitad y resume termina igual, sin huérfanos", async () => {
    const guionLento = (ms: number): string =>
      JSON.stringify({ llamadas: [{ esperaMs: ms, archivos: { "a.txt": "final\n" } }] });
    const plan = JSON.stringify({
      subtareas: [
        { id: "SUB-01", titulo: "U", archivos: ["a.txt"], criterios: ["c"], complejidad: "baja" },
      ],
    });

    async function correrLimpio(): Promise<{ contenido: string; intentos: number }> {
      const { base, repoDir } = await crearRepo();
      limpiezas.push(() => limpiarRepo(repoDir, base));
      const guion = join(base, "guion.json");
      await writeFile(guion, guionLento(0), "utf8");
      const planPath = join(base, "plan.json");
      await writeFile(planPath, plan, "utf8");
      const spec = join(base, "spec.md");
      await writeFile(spec, "# s\n", "utf8");
      const args = [
        "--repo",
        repoDir,
        "--config",
        join(DEMO, "batuta-demo.yaml"),
        "--spec",
        spec,
        "--plan",
        planPath,
        "--simulado",
        guion,
      ];
      let r = ejecutarBin(bin, ["run", ...args], repoDir);
      const runId = extraerRunId(r.stdout);
      for (const puerta of ["H0", "H1", "H2", "H3"]) {
        r = ejecutarBin(bin, ["approve", runId, puerta, "--repo", repoDir, "--simulado", guion], repoDir);
      }
      expect(r.codigo).toBe(0);
      const prog = JSON.parse(
        await readFile(join(repoDir, ".batuta", "runs", runId, "motor.json"), "utf8"),
      ) as { worktree: { ruta: string }; subtareas: Array<{ intentos: number }> };
      const contenido = await readFile(join(prog.worktree.ruta, "a.txt"), "utf8");
      const bye = ejecutarBin(bin, ["abort", runId, "--repo", repoDir, "--yes"], repoDir);
      expect(bye.codigo).toBe(0);
      return { contenido, intentos: prog.subtareas[0]?.intentos ?? -1 };
    }

    const limpio = await correrLimpio();

    const { base, repoDir } = await crearRepo();
    limpiezas.push(() => limpiarRepo(repoDir, base));
    const guion = join(base, "guion.json");
    await writeFile(guion, guionLento(20000), "utf8");
    const planPath = join(base, "plan.json");
    await writeFile(planPath, plan, "utf8");
    const spec = join(base, "spec.md");
    await writeFile(spec, "# s\n", "utf8");
    const args = [
      "--repo",
      repoDir,
      "--config",
      join(DEMO, "batuta-demo.yaml"),
      "--spec",
      spec,
      "--plan",
      planPath,
      "--simulado",
      guion,
    ];
    let r = ejecutarBin(bin, ["run", ...args], repoDir);
    const runId = extraerRunId(r.stdout);
    for (const puerta of ["H0", "H1"]) {
      r = ejecutarBin(bin, ["approve", runId, puerta, "--repo", repoDir, "--simulado", guion], repoDir);
      expect(r.codigo).toBe(10);
    }

    const hijo: ChildProcess = spawn(process.execPath, [bin, "approve", runId, "H2", "--repo", repoDir, "--simulado", guion], {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = hijo.pid;
    if (pid === undefined) throw new Error("Sin pid del proceso hijo.");
    hijo.stdout?.on("data", () => undefined);
    hijo.stderr?.on("data", () => undefined);
    // Espera a que el proceso esté dentro de la llamada (durmiendo 20 s).
    await new Promise((resolver) => setTimeout(resolver, 6000));
    // Mata el árbol completo (en Windows con taskkill /T, en Linux por grupo).
    matarArbolProcesos(pid);
    const codigoMuerte: number | null = await new Promise((resolver) => {
      hijo.on("close", resolver);
    });
    expect(codigoMuerte).not.toBe(0);
    // Sin procesos huérfanos: el pid ya no existe.
    const limite = Date.now() + 15000;
    while (existeProceso(pid) && Date.now() < limite) {
      await new Promise((resolver) => setTimeout(resolver, 250));
    }
    expect(existeProceso(pid)).toBe(false);

    const re = ejecutarBin(bin, ["resume", runId, "--repo", repoDir, "--simulado", guion], repoDir);
    expect(re.codigo).toBe(10);
    const fin = ejecutarBin(bin, ["approve", runId, "H3", "--repo", repoDir, "--simulado", guion], repoDir);
    expect(fin.codigo).toBe(0);
    const prog = JSON.parse(
      await readFile(join(repoDir, ".batuta", "runs", runId, "motor.json"), "utf8"),
    ) as { worktree: { ruta: string }; subtareas: Array<{ intentos: number }> };
    expect(await readFile(join(prog.worktree.ruta, "a.txt"), "utf8")).toBe(limpio.contenido);
    expect(prog.subtareas[0]?.intentos).toBe(0);
    expect(limpio.intentos).toBe(0);

    const bye = ejecutarBin(bin, ["abort", runId, "--repo", repoDir, "--yes"], repoDir);
    expect(bye.codigo).toBe(0);
    const git = new ModuloGitReal(new EjecutorComandosReal());
    expect(await git.listarWorktrees(repoDir)).toHaveLength(1);
    const ramas = await new EjecutorComandosReal().ejecutar('git branch --list "batuta/*"', { cwd: repoDir });
    expect(ramas.salidaEstandar.trim()).toBe("");
  }, 300000);

  it("CA-6: abort sin --yes se niega y con --yes deja main intacta", async () => {
    const { base, repoDir } = await crearRepo();
    limpiezas.push(() => limpiarRepo(repoDir, base));
    const ejecutor = new EjecutorComandosReal();
    const head0 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    const demo = argsDemo(repoDir);
    const r0 = ejecutarBin(bin, ["run", ...demo], repoDir);
    expect(r0.codigo).toBe(10);
    const runId = extraerRunId(r0.stdout);

    const no = ejecutarBin(bin, ["abort", runId, "--repo", repoDir], repoDir);
    expect(no.codigo).toBe(2);

    const si = ejecutarBin(bin, ["abort", runId, "--repo", repoDir, "--yes"], repoDir);
    expect(si.codigo).toBe(0);
    const head1 = (await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })).salidaEstandar.trim();
    expect(head1).toBe(head0);
    const git = new ModuloGitReal(new EjecutorComandosReal());
    expect(await git.listarWorktrees(repoDir)).toHaveLength(1);
  }, 180000);

  it("CA-7: doctor en repo desechable pasa en verde", async () => {
    const { base, repoDir } = await crearRepo();
    limpiezas.push(() => limpiarRepo(repoDir, base));
    const r = ejecutarBin(
      bin,
      ["doctor", "--repo", repoDir, "--config", join(DEMO, "batuta-demo.yaml"), "--simulado", join(DEMO, "guion.json")],
      repoDir,
    );
    expect(r.codigo).toBe(0);
    expect(r.stdout).toMatch(/ok - /);
  }, 120000);
});
