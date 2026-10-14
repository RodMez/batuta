import { describe, expect, it } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  parseBatutaConfigYaml,
  AntigravityRunner,
  escribirContextoEnWorktree,
  construirPromptCortoAgy,
  sistemaArchivosNode,
  type AgentInput,
} from "../src/index.js";

describe("Validación de configuración de ejemplo para Antigravity", () => {
  it("el archivo docs/ejemplos/batuta.antigravity.yaml es válido según BatutaConfigSchema", async () => {
    const aqui = dirname(fileURLToPath(import.meta.url));
    const contenidoYaml = await readFile(
      resolve(aqui, "..", "..", "..", "docs", "ejemplos", "batuta.antigravity.yaml"),
      "utf8",
    );
    const config = parseBatutaConfigYaml(contenidoYaml);

    expect(config.runner?.tipo).toBe("antigravity");
    expect(config.runner?.bin_path).toBe("agy");
    expect(config.runner?.umbral_cuota).toBe(0.05);
    expect(config.alias_modelos["gemini-low"].modelo).toBe("gemini-3.8-flash-low");
    expect(config.alias_modelos["claude-sonnet"].modelo).toBe("claude-sonnet-4-6");
    expect(config.modelos.scout).toBe("gemini-low");
  });
});

// Prueba de integración real con agy: omitida por defecto salvo si se define RUN_REAL_AGY=1
describe.skipIf(!process.env.RUN_REAL_AGY)(
  "Integración real con agy (manual / desatendida condicional)",
  () => {
    it(
      "ejecuta una llamada real con gemini-3.8-flash-low y devuelve structured_output válido",
      async () => {
        const dirBase = await mkdtemp(join(tmpdir(), ".batuta-worktree-real-"));
        try {
          const resultadoContexto = await escribirContextoEnWorktree(
            sistemaArchivosNode,
            dirBase,
            {
              spec: "# Spec Real\nCrea un archivo llamado saludo.txt que contenga 'hola batuta'.",
              plan: {
                subtareas: [
                  {
                    id: "sub-1",
                    titulo: "Crear saludo.txt",
                    complejidad: "baja",
                    archivos: ["saludo.txt"],
                    criterios: ["saludo.txt contiene hola batuta"],
                  },
                ],
              },
              subtarea: {
                id: "sub-1",
                titulo: "Crear saludo.txt",
                complejidad: "baja",
                archivos: ["saludo.txt"],
                criterios: ["saludo.txt contiene hola batuta"],
              },
            },
          );

          const prompt = construirPromptCortoAgy(
            "software-engineer",
            {
              id: "sub-1",
              titulo: "Crear saludo.txt",
              complejidad: "baja",
              archivos: ["saludo.txt"],
              criterios: ["saludo.txt contiene hola batuta"],
            },
            {
              specRel: resultadoContexto.specRutaRel,
              planRel: resultadoContexto.planRutaRel,
              feedbackRel: resultadoContexto.feedbackRutaRel,
            },
          );

          const runner = new AntigravityRunner({
            validarRutaWorktree: false,
          });

          const input: AgentInput = {
            task_id: "tarea-real-1",
            agent_role: "software-engineer",
            spec_path: resultadoContexto.specRutaRel,
            allowed_files: ["saludo.txt"],
            budget_limit_usd: 1.0,
            max_steps: 5,
          };

          const resultado = await runner.ejecutar(input, {
            directorioTrabajo: dirBase,
            rol: "software-engineer",
            modelo: "gemini-3.8-flash-low",
            permisos: { soloLectura: false },
            prompt,
          });

          expect(resultado.exito).toBe(true);
          expect(resultado.output).not.toBeNull();
          expect(resultado.output?.status).toBe("SUCCESS");
          expect(resultado.uso.tokensEntrada).toBeGreaterThan(0);
        } finally {
          await rm(dirBase, { recursive: true, force: true });
        }
      },
      120_000,
    );
  },
);
