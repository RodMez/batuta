import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ClaudeCodeRunner,
  EjecutorComandosReal,
  ofuscarSecretos,
  verificarPreflightClaudeCode,
} from "../dist/index.js";

async function main() {
  console.log("Verificando preflight de Claude Code...");
  const ejecutor = new EjecutorComandosReal();
  const preflight = await verificarPreflightClaudeCode(ejecutor);

  if (!preflight.instalado) {
    console.error("Error: Claude Code CLI no está instalado en el sistema.");
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
    await ejecutor.ejecutarArgs("git", ["add", "README.md"], { cwd: tmpRepo });
    await ejecutor.ejecutarArgs("git", ["commit", "-m", "commit inicial"], { cwd: tmpRepo });

    const runner = new ClaudeCodeRunner(ejecutor);
    const input = {
      task_id: "CAPTURE-01",
      agent_role: "architect",
      spec_path: "README.md",
      allowed_files: ["README.md"],
      budget_limit_usd: 0.05,
    };

    const context = {
      cwd: tmpRepo,
      rol: "architect",
      modeloEfectivo: "claude-3-5-haiku-latest",
      limites: { maxPasos: 2, timeoutMs: 30000 },
      permisos: { lectura: true, escritura: false, comandosPermitidos: [] },
      entorno: {},
      variablesModeloPermitidas: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
      prompt: "Analiza el archivo README.md y responde con el esquema JSON requerido.",
      runId: "capture",
    };

    console.log("Invocando Claude Code en repositorio desechable con tope de $0.05 USD...");
    const res = await runner.ejecutar(input, context);

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
