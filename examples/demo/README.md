# Demo de Batuta (hito 7)

Recorre el flujo completo con agentes simulados: no gasta nada.

## Requisitos

- Node 22 o superior y Git.
- El proyecto compilado: desde la raíz del repo, `npm ci` y `npm run build`.
- Un repositorio desechable (no uses tu repo de trabajo):

```bash
# Windows (PowerShell) o Linux (bash)
node -e "require('fs').mkdirSync('/tmp/batuta-demo/repo', {recursive: true})"
git -C /tmp/batuta-demo/repo init -b main
git -C /tmp/batuta-demo/repo config user.name "Demo"
git -C /tmp/batuta-demo/repo config user.email "demo@example.com"
git -C /tmp/batuta-demo/repo commit --allow-empty -m init
```

Ajusta las rutas a tu sistema (`%TEMP%\batuta-demo\repo` en Windows).

## Recorrido

Desde la raíz de Batuta (o con el binario en el `PATH`):

```bash
node packages/cli/dist/index.js doctor --repo /tmp/batuta-demo/repo --config examples/demo/batuta-demo.yaml --simulado examples/demo/guion.json
node packages/cli/dist/index.js run --repo /tmp/batuta-demo/repo --config examples/demo/batuta-demo.yaml --spec examples/demo/spec.md --plan examples/demo/plan.json --simulado examples/demo/guion.json
```

Cada comando ejecuta hasta la siguiente pausa e indica el siguiente paso.
Responde a cada puerta con su identificador (lo muestra `status`):

```bash
node packages/cli/dist/index.js approve <run_id> H0
node packages/cli/dist/index.js approve <run_id> H1
node packages/cli/dist/index.js approve <run_id> H2
node packages/cli/dist/index.js approve <run_id> H3
```

Al final, `status` muestra `DONE` y `summary.md` está en
`/tmp/batuta-demo/repo/.batuta/runs/<run_id>/`. Para limpiar el worktree y la
rama de la ejecución:

```bash
node packages/cli/dist/index.js abort <run_id> --repo /tmp/batuta-demo/repo --yes
```

## Códigos de salida

0 terminada, 10 pausa por aprobación, 11 pausa por una respuesta, 1 fallida
y 2 error de uso o de configuración.
