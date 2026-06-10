import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { unlink } from 'fs/promises'
import { join } from 'path'

// Checkpoint & rollback del workspace: captura snapshots del estado de un repo
// git SIN tocar el HEAD, índice, ramas ni working tree del usuario. Los
// snapshots viven en refs ocultas bajo refs/bridge/checkpoints/, así que no
// aparecen en `git branch` ni en el log normal y sobreviven reinicios.
//   captura:  GIT_INDEX_FILE temporal → write-tree → commit-tree → update-ref
//   restaura: git restore --source=<sha> (solo working tree)

const REF_PREFIX = 'refs/bridge/checkpoints'

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      // timeout: un repo gigante o un lock externo no debe colgar el turno del agente
      { cwd, env: { ...process.env, ...extraEnv }, maxBuffer: 16 * 1024 * 1024, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message))
        else resolve(stdout.trim())
      }
    )
  })
}

async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel'])
  } catch {
    return null
  }
}

export interface Checkpoint {
  id: string
  sha: string
  label: string
  ts: number
  auto: boolean
}

let snapSeq = 0

async function capture(cwd: string, label: string, auto: boolean): Promise<Checkpoint | null> {
  const root = await repoRoot(cwd)
  if (!root) return null

  // índice temporal con nombre único: no perturbamos el staging del usuario
  // ni chocamos con capturas concurrentes (varias celdas en el mismo repo).
  // --absolute-git-dir y no join(root, '.git'): en worktrees el git dir vive aparte.
  const gitDir = await git(root, ['rev-parse', '--absolute-git-dir']).catch(() => join(root, '.git'))
  const tmpIndex = join(gitDir, `bridge-snap-${process.pid}-${snapSeq++}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    // partir del índice real para que write-tree refleje el working tree completo
    await git(root, ['read-tree', 'HEAD'], env).catch(() => git(root, ['read-tree', '--empty'], env))
    await git(root, ['add', '-A'], env)
    const tree = await git(root, ['write-tree'], env)

    // las capturas automáticas no acumulan duplicados si nada cambió
    if (auto) {
      const last = (await list(root))[0]
      if (last) {
        const lastTree = await git(root, ['rev-parse', `${last.sha}^{tree}`]).catch(() => null)
        if (lastTree === tree) return last
      }
    }

    let head: string | null = null
    try {
      head = await git(root, ['rev-parse', 'HEAD'])
    } catch {
      head = null // repo sin commits aún
    }
    const commitArgs = ['commit-tree', tree, '-m', `[bridge] ${label}`]
    if (head) commitArgs.push('-p', head)
    const sha = await git(root, commitArgs)

    const id = `${Date.now()}-${sha.slice(0, 7)}`
    await git(root, ['update-ref', `${REF_PREFIX}/${id}`, sha])
    return { id, sha, label, ts: Date.now(), auto }
  } catch (e) {
    // no bloquea el turno del agente, pero que quede rastro del porqué
    console.error(`[checkpoints] captura falló en ${root}:`, e instanceof Error ? e.message : e)
    return null
  } finally {
    await unlink(tmpIndex).catch(() => {})
  }
}

async function list(cwd: string): Promise<Checkpoint[]> {
  const root = await repoRoot(cwd)
  if (!root) return []
  try {
    const out = await git(root, [
      'for-each-ref',
      '--sort=-creatordate',
      '--format=%(refname:lstrip=3)%09%(objectname)%09%(subject)',
      REF_PREFIX
    ])
    if (!out) return []
    return out
      .split('\n')
      .filter((line) => line.includes('\t'))
      .map((line) => {
      const [id, sha, subject] = line.split('\t')
      const tsPart = Number(id.split('-')[0])
      const label = (subject ?? '').replace(/^\[bridge\] /, '')
      return {
        id,
        sha,
        label: label.replace(/^\[auto\] /, ''),
        ts: Number.isFinite(tsPart) ? tsPart : 0,
        auto: label.startsWith('[auto] ')
      }
    })
  } catch {
    return []
  }
}

export function registerCheckpointHandlers(): void {
  ipcMain.handle('ckpt:capture', (_e, { cwd, label }: { cwd: string; label: string }) =>
    capture(cwd, label, false)
  )

  ipcMain.handle('ckpt:list', (_e, cwd: string) => list(cwd))

  // Restaura el working tree al snapshot. Primero guarda un checkpoint
  // automático del estado actual (rollback del rollback). NO borra archivos
  // creados después del checkpoint (sería destructivo); solo revierte contenido.
  ipcMain.handle('ckpt:restore', async (_e, { cwd, sha }: { cwd: string; sha: string }) => {
    const root = await repoRoot(cwd)
    if (!root) return { ok: false, error: 'no es un repositorio git' }
    try {
      await capture(root, `[auto] antes de restaurar`, true)
      await git(root, ['restore', '--source', sha, '--', '.'])
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('ckpt:delete', async (_e, { cwd, id }: { cwd: string; id: string }) => {
    const root = await repoRoot(cwd)
    if (!root) return
    await git(root, ['update-ref', '-d', `${REF_PREFIX}/${id}`]).catch(() => {})
    // los commits huérfanos de refs borradas se limpian cuando git lo amerite
    git(root, ['gc', '--auto', '--quiet']).catch(() => {})
  })
}

// Checkpoint automático antes de un turno de agente que puede modificar archivos.
export async function autoCheckpoint(cwd: string, label: string): Promise<void> {
  await capture(cwd, `[auto] ${label}`, true)
}
