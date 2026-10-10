import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compararVersiones,
  evaluarDiff,
  ModuloGitReal,
  VERSION_MINIMA_GIT,
} from "../src/index.js";
import { EjecutorComandosReal } from "../src/commandRunner.js";

describe("compararVersiones", () => {
  it("compara correctamente versiones semver de Git", () => {
    expect(compararVersiones("2.28.0", VERSION_MINIMA_GIT)).toBe(true);
    expect(compararVersiones("2.51.0", VERSION_MINIMA_GIT)).toBe(true);
    expect(compararVersiones("2.27.9", VERSION_MINIMA_GIT)).toBe(false);
    expect(compararVersiones("1.9.0", VERSION_MINIMA_GIT)).toBe(false);
    expect(compararVersiones("3.0.0", VERSION_MINIMA_GIT)).toBe(true);
  });
});

describe("ModuloGitReal", () => {
  const directoriosLimpieza: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (directoriosLimpieza.length > 0) {
      const limpiar = directoriosLimpieza.pop();
      if (limpiar) {
        await limpiar();
      }
    }
  });

  async function crearRepoTemporal(nombre = "test"): Promise<{
    repoDir: string;
    git: ModuloGitReal;
  }> {
    const baseDir = await mkdtemp(join(tmpdir(), `batuta-git-${nombre}-`));
    const repoDir = join(baseDir, "repo");
    await mkdir(repoDir, { recursive: true });

    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git init -b main", { cwd: repoDir });
    await ejecutor.ejecutar("git config core.autocrlf false", { cwd: repoDir });
    await ejecutor.ejecutar("git config user.name 'Test Initial'", { cwd: repoDir });
    await ejecutor.ejecutar("git config user.email 'initial@example.com'", { cwd: repoDir });

    await writeFile(join(repoDir, "README.md"), "# Inicial\n", "utf8");
    await ejecutor.ejecutar("git add README.md", { cwd: repoDir });
    await ejecutor.ejecutar("git commit -m 'Commit inicial'", { cwd: repoDir });

    const git = new ModuloGitReal(ejecutor);

    directoriosLimpieza.push(async () => {
      try {
        await ejecutor.ejecutar("git worktree prune", { cwd: repoDir });
      } catch {}
      try {
        await rm(baseDir, { recursive: true, force: true });
      } catch {}
    });

    return { repoDir, git };
  }

  it("detecta no-repositorio, árbol sucio y referencia base inexistente con resultados claros (CA-1)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca1");

    // 1. Repositorio limpio y válido
    const previasOk = await git.comprobacionesPrevias(repoDir);
    expect(previasOk.esRepo).toBe(true);
    expect(previasOk.ramaActual).toBe("main");
    expect(previasOk.arbolLimpio).toBe(true);
    expect(previasOk.referenciaExiste).toBe(true);
    expect(previasOk.versionSuficiente).toBe(true);
    expect(previasOk.versionGit).not.toBeNull();

    // 2. Directorio que no es repositorio
    const dirNoRepo = await mkdtemp(join(tmpdir(), "batuta-no-repo-"));
    directoriosLimpieza.push(() => rm(dirNoRepo, { recursive: true, force: true }));

    const previasNoRepo = await git.comprobacionesPrevias(dirNoRepo);
    expect(previasNoRepo.esRepo).toBe(false);
    expect(previasNoRepo.arbolLimpio).toBe(false);
    expect(previasNoRepo.referenciaExiste).toBe(false);
    expect(previasNoRepo.detalle).toMatch(/no es un repositorio/i);

    // 3. Árbol de trabajo sucio (archivo nuevo sin confirmar)
    await writeFile(join(repoDir, "sucio.txt"), "modificacion", "utf8");
    const previasSucio = await git.comprobacionesPrevias(repoDir);
    expect(previasSucio.esRepo).toBe(true);
    expect(previasSucio.arbolLimpio).toBe(false);

    // 4. Referencia base inexistente
    const previasRefInexistente = await git.comprobacionesPrevias(
      repoDir,
      "commit-inexistente-123456",
    );
    expect(previasRefInexistente.referenciaExiste).toBe(false);
  });

  it("crea worktree desde referencia base dada con ruta, rama y commit base, y falla al repetir run_id (CA-2)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca2");

    // 1. Crear worktree por defecto (directorio hermano)
    const runId = "run-001";
    const info = await git.crearWorktree(repoDir, runId);

    expect(info.rama).toBe("batuta/run-001");
    expect(info.ruta).toContain("repo-worktrees");
    expect(info.ruta).toContain("run-001");
    expect(existsSync(info.ruta)).toBe(true);
    expect(existsSync(join(info.ruta, "README.md"))).toBe(true);

    // 2. Intentar crear duplicado con el mismo run_id debe fallar
    await expect(git.crearWorktree(repoDir, runId)).rejects.toThrow(
      /ya existe/i,
    );

    // 3. Crear otro worktree en directorio personalizado configurable
    const customDir = join(tmpdir(), `batuta-custom-wt-${Date.now()}`);
    directoriosLimpieza.push(() => rm(customDir, { recursive: true, force: true }));

    const infoCustom = await git.crearWorktree(repoDir, "run-002", {
      directorioWorktrees: customDir,
    });
    expect(infoCustom.rama).toBe("batuta/run-002");
    expect(infoCustom.ruta).toBe(join(customDir, "run-002"));
    expect(existsSync(infoCustom.ruta)).toBe(true);

    // Limpieza
    await git.eliminarWorktree(info.ruta);
    await git.eliminarWorktree(infoCustom.ruta);
  });

  it("confirmar subtarea usa identidad de Batuta sin tocar config del usuario y sin cambios no crea commit (CA-3)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca3");
    const info = await git.crearWorktree(repoDir, "run-subtarea");

    // 1. Sin cambios: no debe crear commit
    const resSinCambios = await git.confirmarSubtarea(
      info.ruta,
      "Intento sin cambios",
    );
    expect(resSinCambios.creado).toBe(false);
    expect(resSinCambios.hash).toBeNull();

    // 2. Con cambios: crear archivo nuevo y confirmar
    await writeFile(join(info.ruta, "tarea1.txt"), "resultado de subtarea 1\n", "utf8");
    const resConCambios = await git.confirmarSubtarea(
      info.ruta,
      "feat: subtarea 1 terminada",
    );
    expect(resConCambios.creado).toBe(true);
    expect(resConCambios.hash).toMatch(/^[a-f0-9]{40}$/);

    // 3. Verificar que el autor es Batuta y no modificó git config global ni local
    const ejecutor = new EjecutorComandosReal();
    const logAutor = await ejecutor.ejecutar(
      "git log -1 --format='%an <%ae>'",
      { cwd: info.ruta },
    );
    expect(logAutor.salidaEstandar.trim()).toBe("Batuta <batuta@localhost>");

    const configLocalUser = await ejecutor.ejecutar("git config --local user.name", {
      cwd: repoDir,
    });
    expect(configLocalUser.salidaEstandar.trim()).toBe("Test Initial");

    await git.eliminarWorktree(info.ruta);
  });

  it("listar cambios cubre modificados, nuevos, eliminados, renombrados, binarios y rutas con espacios o acentos y alimenta politica de diff (CA-4)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca4");

    // Preparar commit base en el repo
    await writeFile(join(repoDir, "existente.txt"), "linea1\nlinea2\n", "utf8");
    await writeFile(join(repoDir, "para_borrar.txt"), "borrame\n", "utf8");
    await writeFile(join(repoDir, "para_renombrar.txt"), "renombrame\n", "utf8");
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git add .", { cwd: repoDir });
    await ejecutor.ejecutar("git commit -m 'archivos base'", { cwd: repoDir });

    const info = await git.crearWorktree(repoDir, "run-diff");

    // Modificar archivo existente
    await writeFile(
      join(info.ruta, "existente.txt"),
      "linea1\nlinea_modificada\nlinea3_nueva\n",
      "utf8",
    );

    // Borrar archivo
    await rm(join(info.ruta, "para_borrar.txt"));

    // Renombrar archivo
    await ejecutor.ejecutar("git mv para_renombrar.txt renombrado.txt", {
      cwd: info.ruta,
    });

    // Archivo nuevo sin seguimiento con acentos y espacios
    await writeFile(
      join(info.ruta, "diseño y acentos.txt"),
      "primera línea añadida\nsegunda línea añadida\n",
      "utf8",
    );

    // Archivo binario nuevo sin seguimiento
    const bufferBinario = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]);
    writeFileSync(join(info.ruta, "datos.bin"), bufferBinario);

    // Obtener lista de cambios respecto al commit base
    const cambios = await git.listarCambios(info.ruta, {
      commitBase: info.commitBase,
    });

    // Verificaciones
    expect(cambios.length).toBeGreaterThanOrEqual(5);

    // 1. Modificado
    const modificado = cambios.find((c) => c.ruta === "existente.txt");
    expect(modificado).toBeDefined();
    expect(modificado?.lineasAnadidas).toBeGreaterThan(0);
    expect(modificado?.lineasEliminadas).toBeGreaterThan(0);
    expect(modificado?.lineasAnadidasTexto).toContain("linea_modificada");

    // 2. Eliminado
    const eliminado = cambios.find((c) => c.ruta === "para_borrar.txt");
    expect(eliminado).toBeDefined();
    expect(eliminado?.lineasEliminadas).toBe(1);

    // 3. Renombrado
    const renombrado = cambios.find((c) => c.ruta === "renombrado.txt");
    expect(renombrado).toBeDefined();

    // 4. Nuevo con espacios y acentos
    const conAcentos = cambios.find((c) => c.ruta === "diseño y acentos.txt");
    expect(conAcentos).toBeDefined();
    expect(conAcentos?.lineasAnadidas).toBe(2);
    expect(conAcentos?.lineasAnadidasTexto).toEqual([
      "primera línea añadida",
      "segunda línea añadida",
    ]);

    // 5. Binario
    const binario = cambios.find((c) => c.ruta === "datos.bin");
    expect(binario).toBeDefined();
    expect(binario?.lineasAnadidas).toBe(0);
    expect(binario?.lineasEliminadas).toBe(0);

    // 6. Prueba e2e con la política de diff
    const violaciones = evaluarDiff(cambios, {
      maxLineasDiff: 100,
      rutasProhibidas: [".env", "secretos/"],
    });
    expect(violaciones).toHaveLength(0);

    // Violación con ruta prohibida
    await writeFile(join(info.ruta, ".env"), "API_KEY=123\n", "utf8");
    const cambiosConSecreto = await git.listarCambios(info.ruta, {
      commitBase: info.commitBase,
    });
    const violacionesSecreto = evaluarDiff(cambiosConSecreto, {
      rutasProhibidas: [".env"],
    });
    expect(violacionesSecreto.length).toBeGreaterThan(0);
    expect(violacionesSecreto[0]?.tipo).toBe("ruta_prohibida");

    await git.eliminarWorktree(info.ruta);
  });

  it("volver a un commit elimina modificaciones y archivos nuevos pero conserva archivos ignorados (CA-5)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca5");

    // Configurar .gitignore en el repo
    await writeFile(join(repoDir, ".gitignore"), "node_modules/\ndata/\n", "utf8");
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar("git add .gitignore", { cwd: repoDir });
    await ejecutor.ejecutar("git commit -m 'add gitignore'", { cwd: repoDir });

    const info = await git.crearWorktree(repoDir, "run-restore");

    // Commit 1 en worktree
    await writeFile(join(info.ruta, "fichero.txt"), "version 1\n", "utf8");
    const resC1 = await git.confirmarSubtarea(info.ruta, "commit 1");
    const commit1 = resC1.hash!;

    // Modificar fichero, agregar archivo nuevo y crear archivos ignorados
    await writeFile(join(info.ruta, "fichero.txt"), "version 2 modificada\n", "utf8");
    await writeFile(join(info.ruta, "untracked.txt"), "archivo nuevo\n", "utf8");

    // Archivos ignorados
    await mkdir(join(info.ruta, "node_modules"), { recursive: true });
    await writeFile(join(info.ruta, "node_modules", "paquete.js"), "console.log(1);", "utf8");
    await mkdir(join(info.ruta, "data"), { recursive: true });
    await writeFile(join(info.ruta, "data", "cache.db"), "datos en cache", "utf8");

    // Volver a commit 1
    await git.volverACommit(info.ruta, commit1);

    // Verificaciones:
    // 1. fichero.txt volvió a version 1
    const contenidoFichero = await ejecutor.ejecutar("git log -1 --format=%s", {
      cwd: info.ruta,
    });
    expect(contenidoFichero.salidaEstandar.trim()).toBe("commit 1");

    // 2. Archivo untracked sin confirmar fue eliminado
    expect(existsSync(join(info.ruta, "untracked.txt"))).toBe(false);

    // 3. Archivos ignorados se CONSERVAN intactos
    expect(existsSync(join(info.ruta, "node_modules", "paquete.js"))).toBe(true);
    expect(existsSync(join(info.ruta, "data", "cache.db"))).toBe(true);

    await git.eliminarWorktree(info.ruta);
  });

  it("volver a commit o eliminar sobre el repo principal o ruta ajena a Batuta se rechaza (CA-6)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca6");

    // 1. Rechazar volverACommit sobre el repositorio principal
    await expect(git.volverACommit(repoDir, "HEAD")).rejects.toThrow(
      /repositorio principal/i,
    );

    // 2. Rechazar eliminarWorktree sobre el repositorio principal
    await expect(git.eliminarWorktree(repoDir)).rejects.toThrow(
      /repositorio principal/i,
    );

    // 3. Crear un worktree manual no perteneciente a Batuta (rama 'feature/manual')
    const manualDir = join(tmpdir(), `manual-wt-${Date.now()}`);
    directoriosLimpieza.push(() => rm(manualDir, { recursive: true, force: true }));
    const ejecutor = new EjecutorComandosReal();
    await ejecutor.ejecutar(`git worktree add -b feature/manual "${manualDir}" HEAD`, {
      cwd: repoDir,
    });

    // Rechazar volverACommit sobre worktree ajeno
    await expect(git.volverACommit(manualDir, "HEAD")).rejects.toThrow(
      /no es una rama de Batuta/i,
    );

    // Rechazar eliminarWorktree sobre worktree ajeno
    await expect(git.eliminarWorktree(manualDir)).rejects.toThrow(
      /no pertenece a Batuta/i,
    );

    await ejecutor.ejecutar(`git worktree remove --force "${manualDir}"`, {
      cwd: repoDir,
    });
    await ejecutor.ejecutar("git branch -D feature/manual", { cwd: repoDir });
  });

  it("tras aborto la rama principal queda idéntica, sin ramas ni worktrees sobrantes y eliminar es idempotente (CA-7)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca7");
    const ejecutor = new EjecutorComandosReal();

    const headInicial = (
      await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })
    ).salidaEstandar.trim();

    // Crear y operar en worktree
    const info = await git.crearWorktree(repoDir, "run-abort");
    await writeFile(join(info.ruta, "trabajo.txt"), "codigo de agente\n", "utf8");
    await git.confirmarSubtarea(info.ruta, "progreso");

    // Abortar: eliminar worktree y su rama
    await git.eliminarWorktree(info.ruta);

    // Verificar idempotencia: una segunda llamada sucesiva no falla
    await expect(git.eliminarWorktree(info.ruta)).resolves.not.toThrow();

    // Verificaciones en el repositorio principal:
    // 1. Mismo HEAD
    const headFinal = (
      await ejecutor.ejecutar("git rev-parse HEAD", { cwd: repoDir })
    ).salidaEstandar.trim();
    expect(headFinal).toBe(headInicial);

    // 2. Rama principal limpia
    const statusPrincipal = await git.comprobacionesPrevias(repoDir);
    expect(statusPrincipal.arbolLimpio).toBe(true);

    // 3. La rama batuta/run-abort fue eliminada
    const resRama = await ejecutor.ejecutar(
      "git rev-parse --verify --quiet refs/heads/batuta/run-abort",
      { cwd: repoDir },
    );
    expect(resRama.codigoSalida).not.toBe(0);

    // 4. El directorio del worktree no existe
    expect(existsSync(info.ruta)).toBe(false);

    // 5. git worktree list solo contiene el repo principal
    const worktrees = await git.listarWorktrees(repoDir);
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]?.esBatuta).toBe(false);
  });

  it("lista worktrees de Batuta y detecta huérfanos (CA-8)", { timeout: 60000 }, async () => {
    const { repoDir, git } = await crearRepoTemporal("ca8");
    const ejecutor = new EjecutorComandosReal();

    // Crear dos worktrees
    const wt1 = await git.crearWorktree(repoDir, "run-activo");
    const wt2 = await git.crearWorktree(repoDir, "run-huerfano");

    // Crear una rama huérfana sin worktree asociado
    await ejecutor.ejecutar("git branch batuta/run-sin-worktree HEAD", {
      cwd: repoDir,
    });

    // Listar worktrees
    const todos = await git.listarWorktrees(repoDir);
    expect(todos.length).toBe(3); // main + wt1 + wt2

    const batutaWts = todos.filter((w) => w.esBatuta);
    expect(batutaWts).toHaveLength(2);
    expect(batutaWts.map((w) => w.runId).sort()).toEqual(["run-activo", "run-huerfano"]);

    // Detectar huérfanos con solo 'run-activo' en la lista de activos
    const huerfanos = await git.detectarHuerfanos(repoDir, ["run-activo"]);

    // wt2 debe figurar como worktree huérfano
    expect(huerfanos.worktreesHuerfanos.map((w) => w.runId)).toContain("run-huerfano");
    expect(huerfanos.worktreesHuerfanos.map((w) => w.runId)).not.toContain("run-activo");

    // Las ramas huérfanas deben incluir 'batuta/run-huerfano' y 'batuta/run-sin-worktree'
    expect(huerfanos.ramasHuerfanas).toContain("batuta/run-huerfano");
    expect(huerfanos.ramasHuerfanas).toContain("batuta/run-sin-worktree");
    expect(huerfanos.ramasHuerfanas).not.toContain("batuta/run-activo");

    // Limpieza
    await git.eliminarWorktree(wt1.ruta);
    await git.eliminarWorktree(wt2.ruta);
    await ejecutor.ejecutar("git branch -D batuta/run-sin-worktree", {
      cwd: repoDir,
    });
  });

  describe("pruebas de seguridad contra inyección de argumentos (Ajuste Hito 4)", () => {
    it("mensaje con comillas, saltos de línea y barras invertidas se guarda tal cual en el commit", { timeout: 60000 }, async () => {
      const { repoDir, git } = await crearRepoTemporal("msg-chars");
      const info = await git.crearWorktree(repoDir, "run-msg");
      const ejecutor = new EjecutorComandosReal();

      const mensajeComplejo =
        'subtarea con "comillas dobles", \'simples\', \\ barras invertidas y\nsaltos\nde\nlinea';

      await writeFile(join(info.ruta, "fichero.txt"), "prueba contenido", "utf8");
      const res = await git.confirmarSubtarea(info.ruta, mensajeComplejo);
      expect(res.creado).toBe(true);

      const resLog = await ejecutor.ejecutarArgs("git", ["log", "-1", "--format=%B"], {
        cwd: info.ruta,
      });
      // El mensaje debe conservarse exactamente (normalizando saltos de línea para independencia del SO)
      expect(resLog.salidaEstandar.trim().replace(/\r\n/g, "\n")).toBe(
        mensajeComplejo.trim().replace(/\r\n/g, "\n"),
      );

      await git.eliminarWorktree(info.ruta);
    });

    it("un hook de pre-commit bloqueante sigue bloqueando aunque el mensaje intente inyectar --no-verify", { timeout: 60000 }, async () => {
      const { repoDir, git } = await crearRepoTemporal("precommit-hook");
      const info = await git.crearWorktree(repoDir, "run-hook");

      // Instalar un pre-commit hook bloqueante en el repositorio principal
      // En Git los worktrees comparten los hooks de .git/hooks del repo común
      const hooksDir = join(repoDir, ".git", "hooks");
      await mkdir(hooksDir, { recursive: true });
      const hookPath = join(hooksDir, "pre-commit");
      await writeFile(hookPath, "#!/bin/sh\necho 'Hook pre-commit bloqueando commit' >&2\nexit 1\n", "utf8");
      await chmod(hookPath, 0o755);

      await writeFile(join(info.ruta, "archivo.txt"), "codigo", "utf8");

      // Intento de inyección: un mensaje que contiene --no-verify para burlar el hook
      const mensajeInyeccion = 'subtarea" --no-verify -m "extra';

      // Debe fallar porque --no-verify se pasa como argumento de -m y no como opción de git
      await expect(
        git.confirmarSubtarea(info.ruta, mensajeInyeccion),
      ).rejects.toThrow();

      // Desactivar el hook para permitir limpieza limpia
      await rm(hookPath, { force: true });
      await git.eliminarWorktree(info.ruta);
    });

    it("referencia base hostil que empieza por '-' o contiene comillas se rechaza o se trata como dato", { timeout: 60000 }, async () => {
      const { repoDir, git } = await crearRepoTemporal("ref-hostil");

      // 1. En comprobaciones previas
      const previaDash = await git.comprobacionesPrevias(repoDir, "-v");
      expect(previaDash.referenciaExiste).toBe(false);

      const previaHelp = await git.comprobacionesPrevias(repoDir, "--help");
      expect(previaHelp.referenciaExiste).toBe(false);

      const previaInyeccion = await git.comprobacionesPrevias(
        repoDir,
        'HEAD" && echo inyectado',
      );
      expect(previaInyeccion.referenciaExiste).toBe(false);

      // 2. En crearWorktree se rechaza con error
      await expect(
        git.crearWorktree(repoDir, "wt-hostil1", { refBase: "-v" }),
      ).rejects.toThrow(/no es válida|no existe/i);

      await expect(
        git.crearWorktree(repoDir, "wt-hostil2", { refBase: "--no-verify" }),
      ).rejects.toThrow(/no es válida|no existe/i);

      await expect(
        git.crearWorktree(repoDir, "wt-hostil3", { refBase: 'HEAD" && echo' }),
      ).rejects.toThrow(/no existe/i);
    });

    it("identidad de autor con comillas no altera el comando y se registra exactamente", { timeout: 60000 }, async () => {
      const { repoDir, git } = await crearRepoTemporal("identidad-quotes");
      const info = await git.crearWorktree(repoDir, "run-identidad");
      const ejecutor = new EjecutorComandosReal();

      await writeFile(join(info.ruta, "autor.txt"), "contenido", "utf8");
      const nombreHostil = 'Autor "Con Comillas" O\'Connor';
      const emailHostil = 'autor"test"@example.com';

      await git.confirmarSubtarea(info.ruta, "commit de prueba", {
        nombre: nombreHostil,
        email: emailHostil,
      });

      const resNombre = await ejecutor.ejecutarArgs(
        "git",
        ["log", "-1", "--format=%an"],
        { cwd: info.ruta },
      );
      expect(resNombre.salidaEstandar.trim()).toBe(nombreHostil);

      const resEmail = await ejecutor.ejecutarArgs(
        "git",
        ["log", "-1", "--format=%ae"],
        { cwd: info.ruta },
      );
      expect(resEmail.salidaEstandar.trim()).toBe(emailHostil);

      await git.eliminarWorktree(info.ruta);
    });

    it("rutas con espacios se manejan correctamente en confirmación y listado de cambios", { timeout: 60000 }, async () => {
      const { repoDir, git } = await crearRepoTemporal("rutas-espacios");
      const info = await git.crearWorktree(repoDir, "run-espacios");

      const dirEspacios = join(info.ruta, "carpeta con espacios");
      await mkdir(dirEspacios, { recursive: true });
      await writeFile(
        join(dirEspacios, "archivo con espacios.txt"),
        "linea 1\nlinea 2\n",
        "utf8",
      );

      const resCommit = await git.confirmarSubtarea(
        info.ruta,
        "commit con espacios en ruta",
      );
      expect(resCommit.creado).toBe(true);

      const cambios = await git.listarCambios(info.ruta, {
        commitBase: info.commitBase,
      });
      const archivo = cambios.find(
        (c) => c.ruta === "carpeta con espacios/archivo con espacios.txt",
      );
      expect(archivo).toBeDefined();
      expect(archivo?.lineasAnadidas).toBe(2);

      await git.eliminarWorktree(info.ruta);
    });
  });
});
