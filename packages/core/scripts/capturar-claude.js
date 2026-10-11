import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClaudeCodeRunner,
  EjecutorComandosReal,
  crearContextoCaptura,
  crearInputCaptura,
  modeloCapturaDesdeEntorno,
  ofuscarSecretos,
  VARIABLES_MODELO_CAPTURA,
  verificarPreflightClaudeCode,
} from "../dist/index.js";

const MODELO_POR_DEFECTO = "claude-haiku-5-5";

async function main() {
  const modelo = modeloCapturaDesdeEntorno(process.env) ?? MODELO_POR_DEFECTO;
  console.log(`Verificando preflight de Claude Code (modelo: ${modelo})...`);
  const ejecutor = new EjecutorComandosReal();
  const preflight = await verificarPreflightClaudeCode(ejecutor);

  if (!preflight.ok) {
    console.error(
      `Error: Claude Code CLI no utilizable: ${preflight.mensaje ?? "sin detalles"}`,
    );
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_BASE_URL) {
    console.warn(
      "Aviso: Ni ANTHROPIC_API_KEY ni ANTHROPIC_BASE_URL están definidos en el entorno.",
    );
    console.warn(
      "Para capturar respuestas de la API real, configure las credenciales o proxy local antes de ejecutar.",
    );
  }

  const tmpRepo = await mkdtemp(join(tmpdir(), "batuta-claude-capture-"));
  const runnerLogDir = join(tmpRepo, ".batuta", "runs", "capture");
  await mkdir(runnerLogDir, { recursive: true });

  try {
    await ejecutor.ejecutarArgs("git", ["init", "-b", "main"], { cwd: tmpRepo });
    await ejecutor.ejecutarArgs("git", ["config", "user.name", "Batuta Capture"], { cwd: tmpRepo });
    await ejecutor.ejecutarArgs("git", ["config", "user.email", "capture@batuta.local"], { cwd: tmpRepo });
    await writeFile(join(tmpRepo, "README.md"), "# Repo Desechable para Captura\nPrueba de captura real.\n", "utf8");
    await ejecutor.ejecutarArgs("git", ["add", "--", "README.md"], { cwd: tmpRepo });
    await ejecutor.ejecutarArgs("git", ["commit", "-m", "commit inicial"], { cwd: tmpRepo });

    const config = {
      proyecto: tmpRepo,
      gates: [{ nombre: "noop", comando: "node -e \"process.exit(0)\"", timeout_seg: 30 }],
      variables_modelo: [...VARIABLES_MODELO_CAPTURA],
    };
    const runner = new ClaudeCodeRunner(ejecutor, config);
    const input = crearInputCaptura();
    const contexto = crearContextoCaptura(tmpRepo, modelo);

    console.log("Invocando Claude Code en repositorio desechable con tope de $0.05 USD...");
    const res = await runner.ejecutar(input, contexto);

    const destinoDir = join(import.meta.dirname, "..", "test", "fixtures", "claude-outputs", "reales");
    await mkdir(destinoDir, { recursive: true });

    const nombreArchivo = `captura-${Date.now()}.json`;
    const rutaDestino = join(destinoDir, nombreArchivo);

    const payloadGuardado = {
      _captura: "Salida real obtenida mediante npm run capturar-claude",
      timestamp: new Date().toISOString(),
      resultado: res,
    };

    const contenidoLimpio = ofuscarSecretos(JSON.stringify(payloadGuardado, null, 2));
    await writeFile(rutaDestino, contenidoLimpio, "utf8");

    console.log(`Captura guardada exitosamente (sin datos sensibles) en: ${rutaDestino}`);
  } finally {
    await rm(tmpRepo, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("Error durante la captura:", err);
  process.exit(1);
});
