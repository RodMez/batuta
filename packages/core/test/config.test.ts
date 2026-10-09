import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BatutaConfigSchema,
  loadBatutaConfig,
  parseBatutaConfig,
  parseBatutaConfigYaml,
} from "../src/index.js";

/**
 * Configuración del piloto (sección 18 del diseño). Se usa tal cual como
 * ejemplo de carga válida (CA-2).
 */
const PILOTO_YAML = [
  "proyecto: ruta/al/repo/cuotamoto",
  "preparacion:",
  "  - npm ci --ignore-scripts",
  "entorno_gates:",
  '  DATABASE_URL: "file:./data/test.db"',
  '  ADMIN_PASSWORD: "test-password-12345"',
  '  AUTH_SECRET: "ci-secret-minimo-32-caracteres-xxxxxx"',
  "gates:",
  '  - { nombre: lint,      comando: "npm run lint",          timeout_seg: 60 }',
  '  - { nombre: tipos,     comando: "npm run typecheck",     timeout_seg: 60 }',
  '  - { nombre: tests,     comando: "npm test",              timeout_seg: 120 }',
  '  - { nombre: cobertura, comando: "npm run test:coverage", timeout_seg: 120 }',
  '  - { nombre: build,     comando: "npm run build",         timeout_seg: 240 }',
  "rutas_prohibidas:",
  '  - ".env*"',
  '  - "Dockerfile"',
  '  - "docker-compose.yml"',
  '  - "docker-entrypoint.sh"',
  '  - "README_COOLIFY.md"',
  '  - "scripts/backup.mjs"',
  '  - "scripts/migrate.mjs"',
  '  - "drizzle/"',
  '  - ".github/workflows/"',
  '  - "package-lock.json"',
  '  - "data/"',
  "",
].join("\n");

function baseValida(): Record<string, unknown> {
  return {
    proyecto: "ruta/al/repo",
    gates: [{ nombre: "lint", comando: "npm run lint", timeout_seg: 60 }],
  };
}

describe("configuración (CA-1, CA-2, CA-3)", () => {
  it("expone el esquema de configuración", () => {
    expect(BatutaConfigSchema).toBeDefined();
  });

  it("la configuración del piloto se carga y produce los valores esperados", () => {
    const config = parseBatutaConfigYaml(PILOTO_YAML);
    expect(config.proyecto).toBe("ruta/al/repo/cuotamoto");
    expect(config.preparacion).toEqual(["npm ci --ignore-scripts"]);
    expect(config.entorno_gates).toEqual({
      DATABASE_URL: "file:./data/test.db",
      ADMIN_PASSWORD: "test-password-12345",
      AUTH_SECRET: "ci-secret-minimo-32-caracteres-xxxxxx",
    });
    expect(config.gates.map((g) => g.nombre)).toEqual([
      "lint",
      "tipos",
      "tests",
      "cobertura",
      "build",
    ]);
    expect(config.gates[2]).toMatchObject({
      comando: "npm test",
      timeout_seg: 120,
    });
    expect(config.rutas_prohibidas).toHaveLength(11);
    expect(config.rutas_prohibidas[0]).toBe(".env*");
    // Valores por defecto de la sección 7.
    expect(config.ejecutor).toBe("claude-code");
    expect(config.limites.intentos_por_subtarea).toBe(3);
    expect(config.aprobaciones.H1_spec).toBe(true);
    expect(config.modelos.scout).toBe("rapido");
    expect(config.version_esquema).toBe(1);
  });

  it("loadBatutaConfig lee el mismo YAML desde un archivo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "batuta-hito1-"));
    try {
      const ruta = join(dir, "batuta.yaml");
      await writeFile(ruta, PILOTO_YAML, "utf8");
      const config = await loadBatutaConfig(ruta);
      expect(config.proyecto).toBe("ruta/al/repo/cuotamoto");
      expect(config.gates).toHaveLength(5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("los alias por defecto no llevan precios inventados (CA-7)", () => {
    const config = parseBatutaConfigYaml(PILOTO_YAML);
    for (const alias of Object.values(config.alias_modelos)) {
      expect(alias.entrada).toBeUndefined();
      expect(alias.salida).toBeUndefined();
      expect(alias.ventana).toBeGreaterThan(0);
    }
  });

  it("los precios explícitos por alias siguen aceptándose", () => {
    const config = parseBatutaConfig({
      ...baseValida(),
      alias_modelos: {
        rapido: { modelo: "m-rapido", entrada: 1, salida: 2, ventana: 100_000 },
      },
      modelos: {
        scout: "rapido",
        resumenes: "rapido",
        architect: "rapido",
        "software-engineer": {
          baja: "rapido",
          media: "rapido",
          alta: "rapido",
        },
        debugger: "rapido",
        revisores: "rapido",
      },
    });
    expect(config.alias_modelos["rapido"]).toMatchObject({
      entrada: 1,
      salida: 2,
    });
  });

  it("falta un gate: falla indicando la ruta", () => {
    const { gates: _omit, ...sinGates } = baseValida();
    expect(_omit).toBeDefined();
    expect(() => parseBatutaConfig(sinGates)).toThrow(/gates/);
  });

  it("un timeout no positivo falla indicando la ruta", () => {
    expect(() =>
      parseBatutaConfig({
        ...baseValida(),
        gates: [{ nombre: "lint", comando: "npm run lint", timeout_seg: 0 }],
      }),
    ).toThrow(/timeout_seg/);
  });

  it("un rol que apunta a un alias no definido falla indicando la ruta", () => {
    expect(() =>
      parseBatutaConfig({
        ...baseValida(),
        modelos: {
          scout: "inexistente",
          resumenes: "rapido",
          architect: "fuerte",
          "software-engineer": {
            baja: "rapido",
            media: "medio",
            alta: "fuerte",
          },
          debugger: "fuerte",
          revisores: "revisor",
        },
      }),
    ).toThrow(/scout/);
  });

  it("nombres de gate repetidos fallan indicando la ruta", () => {
    expect(() =>
      parseBatutaConfig({
        ...baseValida(),
        gates: [
          { nombre: "lint", comando: "npm run lint", timeout_seg: 60 },
          { nombre: "lint", comando: "npm test", timeout_seg: 60 },
        ],
      }),
    ).toThrow(/nombre/);
  });

  it("un campo desconocido falla indicando la ruta", () => {
    expect(() =>
      parseBatutaConfig({ ...baseValida(), campo_extra: 1 }),
    ).toThrow(/campo_extra/);
  });
});
