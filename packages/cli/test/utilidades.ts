import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EjecutorComandosReal } from "@batuta/core";

/** Repositorio Git temporal con commit inicial, listo para la CLI. */
export async function crearRepoDesechable(prefijo = "batuta-cli-"): Promise<{
  base: string;
  repoDir: string;
  limpiar: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), prefijo));
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
  return {
    base,
    repoDir,
    limpiar: async () => {
      try {
        await ejecutor.ejecutar("git worktree prune", { cwd: repoDir });
      } catch {}
      await rm(base, { recursive: true, force: true });
    },
  };
}

export const CONFIG_DEMO = `proyecto: .
gates:
  - { nombre: ok, comando: "node -e \\"process.exit(0)\\"", timeout_seg: 60 }
`;

export const PLAN_UNA = JSON.stringify({
  subtareas: [
    { id: "SUB-01", titulo: "Unica", archivos: ["a.txt"], criterios: ["c1"], complejidad: "baja" },
  ],
});

export function guionEscribe(archivos: Record<string, string>): string {
  return JSON.stringify({ llamadas: [{ archivos }] });
}
