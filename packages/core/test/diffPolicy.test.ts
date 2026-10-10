import { describe, expect, it } from "vitest";
import {
  evaluarDiff,
  normalizarRutaDiff,
  type CambioArchivo,
  type PoliticaDiff,
} from "../src/index.js";

describe("Política de diff (CA-8)", () => {
  const rutasProhibidasPiloto = [
    ".env*",
    "Dockerfile",
    "docker-compose.yml",
    "docker-entrypoint.sh",
    "README_COOLIFY.md",
    "scripts/backup.mjs",
    "scripts/migrate.mjs",
    "drizzle/",
    ".github/workflows/",
    "package-lock.json",
    "data/",
  ];

  const politicaPiloto: PoliticaDiff = {
    rutasProhibidas: rutasProhibidasPiloto,
    maxLineasDiff: 200,
    detectarSecretos: true,
  };

  it("deja pasar un cambio válido sin violaciones", () => {
    const cambiosValidos: CambioArchivo[] = [
      {
        ruta: "src/components/Button.tsx",
        lineasAnadidas: 15,
        lineasEliminadas: 5,
        lineasAnadidasTexto: [
          'export function Button() { return <button className="btn">Click</button>; }',
        ],
      },
      {
        ruta: "src/utils/calc.ts",
        lineasAnadidas: 10,
        lineasEliminadas: 2,
        lineasAnadidasTexto: ["export function sumar(a: number, b: number): number { return a + b; }"],
      },
    ];

    const violaciones = evaluarDiff(cambiosValidos, politicaPiloto);
    expect(violaciones).toHaveLength(0);
  });

  it("detecta rutas prohibidas del piloto en Linux y Windows (CA-8)", () => {
    const cambiosProhibidos: CambioArchivo[] = [
      { ruta: ".env", lineasAnadidas: 1, lineasEliminadas: 0 },
      { ruta: ".env.local", lineasAnadidas: 1, lineasEliminadas: 0 },
      { ruta: "Dockerfile", lineasAnadidas: 2, lineasEliminadas: 0 },
      { ruta: "package-lock.json", lineasAnadidas: 5, lineasEliminadas: 5 },
      { ruta: "drizzle/0001_add_users.sql", lineasAnadidas: 10, lineasEliminadas: 0 },
      { ruta: ".github/workflows/ci.yml", lineasAnadidas: 3, lineasEliminadas: 1 },
      { ruta: "data/database.sqlite", lineasAnadidas: 1, lineasEliminadas: 0 },
      { ruta: "scripts/backup.mjs", lineasAnadidas: 4, lineasEliminadas: 0 },
      // Rutas con barras invertidas de Windows
      { ruta: "drizzle\\schema.ts", lineasAnadidas: 8, lineasEliminadas: 0 },
      { ruta: ".github\\workflows\\deploy.yml", lineasAnadidas: 10, lineasEliminadas: 0 },
      { ruta: "scripts\\migrate.mjs", lineasAnadidas: 2, lineasEliminadas: 0 },
    ];

    const violaciones = evaluarDiff(cambiosProhibidos, politicaPiloto);
    expect(violaciones).toHaveLength(cambiosProhibidos.length);
    expect(violaciones.every((v) => v.tipo === "ruta_prohibida")).toBe(true);
  });

  it("detecta un archivo fuera de los permitidos cuando la lista está activa (CA-8)", () => {
    const politicaConPermitidos: PoliticaDiff = {
      archivosPermitidos: ["src/index.ts", "src/types.ts"],
    };

    const cambios: CambioArchivo[] = [
      { ruta: "src/index.ts", lineasAnadidas: 5, lineasEliminadas: 0 },
      { ruta: "src/extra.ts", lineasAnadidas: 2, lineasEliminadas: 0 },
      { ruta: "src\\types.ts", lineasAnadidas: 1, lineasEliminadas: 0 }, // Windows path permitido
    ];

    const violaciones = evaluarDiff(cambios, politicaConPermitidos);
    expect(violaciones).toHaveLength(1);
    expect(violaciones[0]?.tipo).toBe("archivo_no_permitido");
    expect(violaciones[0]?.archivo).toBe("src/extra.ts");
  });

  it("detecta un diff que supera el límite máximo de líneas (CA-8)", () => {
    const politicaLimite: PoliticaDiff = {
      maxLineasDiff: 50,
    };

    const cambios: CambioArchivo[] = [
      { ruta: "src/app.ts", lineasAnadidas: 30, lineasEliminadas: 15 },
      { ruta: "src/style.css", lineasAnadidas: 10, lineasEliminadas: 0 }, // Total = 55 > 50
    ];

    const violaciones = evaluarDiff(cambios, politicaLimite);
    expect(violaciones).toHaveLength(1);
    expect(violaciones[0]?.tipo).toBe("limite_lineas");
    expect(violaciones[0]?.mensaje).toContain("55 líneas");
  });

  it("detecta secretos de diferentes tipos (claves privadas, tokens conocidos y asignaciones) (CA-8)", () => {
    const mockGhToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const mockSlackToken = [
      "xoxb",
      "123456789012",
      "1234567890123",
      "abcdefghijklmnopqrst",
    ].join("-");
    const mockOpenAiKey = [
      "sk",
      "proj",
      "1234567890abcdefghijklmnopqrstuv",
    ].join("-");
    const mockAwsKey = ["AKIA", "1234567890ABCDEF"].join("");
    const mockGenericSecret = ["prod", "live", "sec", "9876543210987654"].join("_");

    const cambiosConSecretos: CambioArchivo[] = [
      {
        ruta: "src/auth.ts",
        lineasAnadidas: 4,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          "// Clave privada RSA",
          "const rsaKey = `-----BEGIN RSA PRIVATE KEY-----",
          "MIIEowIBAAKCAQEA0+...`;",
          `const ghToken = '${mockGhToken}';`,
        ],
      },
      {
        ruta: "src/slack.ts",
        lineasAnadidas: 1,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          `const slack = '${mockSlackToken}';`,
        ],
      },
      {
        ruta: "src/ai.ts",
        lineasAnadidas: 1,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          `const openAiKey = '${mockOpenAiKey}';`,
        ],
      },
      {
        ruta: "src/aws.ts",
        lineasAnadidas: 1,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          `const awsKey = '${mockAwsKey}';`,
        ],
      },
      {
        ruta: "src/config.ts",
        lineasAnadidas: 1,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          `const apiKey = "${mockGenericSecret}";`,
        ],
      },
    ];

    const violaciones = evaluarDiff(cambiosConSecretos, { detectarSecretos: true });
    expect(violaciones.length).toBeGreaterThanOrEqual(5);
    expect(violaciones.every((v) => v.tipo === "secreto_detectado")).toBe(true);
  });

  it("evita falsos positivos en valores de prueba, placeholders y asignaciones genéricas (CA-8)", () => {
    const cambiosConFixtures: CambioArchivo[] = [
      {
        ruta: "tests/fixtures.ts",
        lineasAnadidas: 3,
        lineasEliminadas: 0,
        lineasAnadidasTexto: [
          'const testSecret = "ci-secret-minimo-32-caracteres-xxxxxx";',
          'const adminPass = "test-password-12345";',
          'const dummyKey = "dummy_placeholder_api_key_for_testing";',
        ],
      },
    ];

    const violaciones = evaluarDiff(cambiosConFixtures, { detectarSecretos: true });
    expect(violaciones).toHaveLength(0);
  });

  it("normaliza rutas de Windows correctamente", () => {
    expect(normalizarRutaDiff("src\\components\\App.tsx")).toBe("src/components/App.tsx");
    expect(normalizarRutaDiff(".\\src\\index.ts")).toBe("src/index.ts");
    expect(normalizarRutaDiff("/src/style.css")).toBe("src/style.css");
  });
});
