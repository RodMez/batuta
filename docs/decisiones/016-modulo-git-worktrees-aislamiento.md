# ADR 016: Módulo de Git y aislamiento de ejecuciones mediante worktrees

## Contexto
El hito 4 proporciona a Batuta el aislamiento de cada ejecución en su propio worktree de Git (`batuta/<run_id>`) y la capacidad de confirmar subtareas, listar cambios para alimentar la política de diff, restaurar el estado a un commit previo y eliminar el entorno sin dejar rastro en la rama principal.

## Opciones consideradas
1. **Librerías externas de Git (`simple-git`, `isomorphic-git`, `nodegit`)**:
   - Agregan dependencias pesadas, incompatibilidades con extensiones nativas o duplicación de lógica interna de Git.
2. **Invocación directa de Git mediante `EjecutorComandos`**:
   - Reutiliza el ejecutor de procesos del hito 3, garantizando control sobre variables de entorno, timeout y portabilidad en Windows y Linux sin dependencias externas adicionales.

## Decisión
Se implementa `ModuloGit` y `ModuloGitReal` en `@batuta/core` invocando el ejecutable `git` mediante `EjecutorComandos` con las siguientes decisiones de diseño:

1. **Versión mínima de Git**:
   - Se fija en Git 2.20.0 (`VERSION_MINIMA_GIT = "2.20.0"`), garantizando compatibilidad con `git worktree` moderno, `--porcelain` y opciones `-z`.

2. **Ubicación por defecto de worktrees (`directorio_worktrees`)**:
   - Por defecto, los worktrees se crean en un directorio hermano fuera del árbol del repositorio (`../<repo>-worktrees/<run_id>`), configurable mediante `directorio_worktrees` en `batuta.yaml`.
   - **Razón**: Evita que herramientas del proyecto (ESLint, TypeScript, Vitest, Jest, bundlers, indexadores de IDE) recorran copias duplicadas del código en subcarpetas del repositorio principal.

3. **Formatos legibles por máquinas terminados en nulo (`-z`) o `porcelain`**:
   - Se utilizan `git status -z --porcelain=v1`, `git diff -z --numstat`, `git diff -U0` y `git worktree list --porcelain`.
   - **Razón**: Evita la pérdida o distorsión de rutas con caracteres no ASCII, acentos, espacios o comillas octales de Git (`core.quotePath`).

4. **Identidad de subtareas sin modificar configuración del usuario**:
   - Se inyecta `-c user.name="Batuta"` y `-c user.email="batuta@local"` en la línea de comando de `git commit`. No se altera la configuración global ni local del usuario (`~/.gitconfig` o `.git/config`). Si no hay cambios staged, no se genera commit vacío.

5. **Guardas de seguridad en operaciones destructivas**:
   - `volverACommit` y `eliminarWorktree` validan rigurosamente que el directorio no sea el repositorio principal (comparando `--git-common-dir` con `--git-dir`) y que la rama activa empiece con `batuta/`. Si no se cumple, la operación es rechazada con un error explicativo.

6. **Conservación de archivos ignorados al restaurar**:
   - `volverACommit` utiliza `git reset --hard <commit>` seguido de `git clean -fd`. Esto descarta modificaciones versionadas y archivos nuevos sin seguimiento, pero preserva intactos archivos ignorados por `.gitignore` (como `node_modules/` o cachés locales).

7. **Eliminación idempotente y tolerancia a bloqueos en Windows**:
   - `eliminarWorktree` ejecuta `git worktree remove --force` y `git branch -D`. Si en Windows el borrado falla por descriptores abiertos temporalmente, se aplica reintento con retardo y contingencia mediante eliminación forzada en disco más `git worktree prune`. Una segunda llamada sobre un worktree ya borrado no falla.

8. **Detección de huérfanos**:
   - Se analizan los worktrees reportados por `git worktree list --porcelain` y las ramas que comienzan con `batuta/`. Un worktree o rama se marca como huérfano si la ejecución asociada no está activa o si el directorio en disco ha desaparecido (`prunable`).

## Consecuencias
- **Positivas**: Aislamiento hermético de cada ejecución; cero interferencia con la rama principal y configuración del desarrollador; compatibilidad robusta en Windows y Linux; pruebas limpias sin efectos residuales.
- **Negativas**: Requiere que el entorno del sistema disponga del ejecutable `git >= 2.20.0` instalado en el `PATH` (validado preventivamente en `comprobacionesPrevias`).
