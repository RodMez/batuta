# Batuta

Batuta es un sistema orquestador de agentes de IA diseñado para dirigir agentes como un director a su orquesta: el flujo y los límites los controla código determinista, mientras los modelos ejecutan tareas cognitivas acotadas y verificadas con comandos automáticos.

Este repositorio es un monorepo TypeScript estructurado con **npm workspaces**.

---

## Estructura del Proyecto

```
batuta/
├── packages/
│   ├── core/      # Núcleo: lógica del motor, estado, eventos, interfaces y gates
│   └── cli/       # CLI delgada construida sobre el núcleo
├── docs/
│   ├── briefs/    # Briefs de especificación por hito
│   ├── decisiones/# Registro de decisiones de arquitectura (ADRs)
│   └── diseno.md  # Documento general de diseño y arquitectura
├── .github/
│   └── workflows/ # CI automatizado para Linux (Ubuntu) y Windows
└── AGENTS.md      # Reglas para agentes de codificación en el proyecto
```

---

## Requisitos de Entorno

- **Node.js**: `>= 22.0.0`
- **npm**: `>= 10.0.0`
- **Git**: Configurado con finales de línea LF (`* text=auto eol=lf`)

---

## Instalación y Verificación

### 1. Instalación limpia
```bash
npm ci
```

### 2. Pipeline unificado de verificación
Ejecuta secuencialmente linting, tipado estático, suite de pruebas y compilación:
```bash
npm run verify
```

### 3. Comandos individuales
- **Lint**: `npm run lint` (ESLint con TypeScript estricto, sin `any` explícito)
- **Tipos**: `npm run typecheck` (`tsc --build --noEmit`)
- **Pruebas**: `npm test` (Vitest)
- **Compilación**: `npm run build` (`tsc --build` a carpetas `dist/`)

---

## Ejecución de la CLI

Una vez compilado el proyecto con `npm run build`:
```bash
node packages/cli/dist/index.js --version
```
Muestra la versión actual de Batuta (`0.1.0`).

---

## Captura de salidas reales de Claude Code (manual, fuera de `verify`)

El script `scripts/capturar-claude.js` invoca una vez al `architect` (solo
lectura) en un repositorio desechable con tope de $0.05 USD y guarda la salida
ofuscada en `packages/core/test/fixtures/claude-outputs/reales/`. No forma
parte de `npm run verify` ni gasta tokens en las pruebas (usan fixtures
sintéticos y un `claude` falso).

El modelo se lee de `BATUTA_MODELO` (por defecto: `claude-haiku-5-5`).

Sin proxy (API directa de Anthropic):
```bash
set BATUTA_MODELO=claude-haiku-5-5
set ANTHROPIC_API_KEY=...
npm run capturar-claude
```

Con proxy local (por ejemplo Jan en `http://127.0.0.1:1337`): el nombre debe
ser el que el proxy entienda en ese slot, y se reenvían `ANTHROPIC_API_KEY` y
`ANTHROPIC_BASE_URL` al subproceso en entorno limpio:
```bash
set BATUTA_MODELO=mi-modelo-del-proxy
set ANTHROPIC_API_KEY=...
set ANTHROPIC_BASE_URL=http://127.0.0.1:1337
npm run capturar-claude
```
