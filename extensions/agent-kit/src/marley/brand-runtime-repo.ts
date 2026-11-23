// Extract of zygstinct apps/agent-server/src/brand-runtime-repo.ts at 7110e58c8: only syncRuntimeRepo, verifyRuntimeSource.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { ExecResult } from "./sandbox/ssh.js";
import { brandPaths, shellQuote } from "./sandbox/ssh.js";

const execFileAsync = promisify(execFile);

const SHA = /^[0-9a-f]{40}$/;

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

const IMPORT_STAGES = ["open-repo", "open-git", "lock", "stage-bundle", "bundle", "fetch", "symbolic-ref", "status", "rev-parse", "for-each-ref", "rev-list", "log", "update-ref", "reset", "merge", "cleanup"];

const IMPORT_REASONS = ["permission-denied", "not-directory", "symlink", "missing", "filesystem-error", "git-failed", "timeout", "invalid-head", "repo-owner-mismatch", "git-owner-mismatch", "lock-owner-mismatch", "target-not-main", "target-dirty", "bundle-too-large", "bundle-head-mismatch", "target-changed", "git-directory-changed", "target-refs-changed", "target-head-mismatch", "unexpected-failure"];

export async function verifyRuntimeSource(input: { brandId: string; repo?: string; run(command: string): Promise<Pick<ExecResult, "code" | "stdout">> }): Promise<void> {
  const repo = shellQuote(input.repo ?? brandPaths(input.brandId).repo);
  const state = await input.run(`git -C ${repo} symbolic-ref --short HEAD && git -C ${repo} status --porcelain --untracked-files=all`);
  if (state.code !== 0 || state.stdout.trim() !== "main") throw new Error("source repo must be clean and on main; provider unchanged");
}

// Like the brand-move import, stdin is the bundle and staging stays private. This variant never runs as root and never merges divergent histories.
export const RUNTIME_REPO_IMPORT = `import os,sys,stat,tempfile,subprocess,fcntl,json
operation='open-repo'
errors={'invalid head':'invalid-head','repo owner mismatch':'repo-owner-mismatch','git owner mismatch':'git-owner-mismatch','lock owner mismatch':'lock-owner-mismatch','target is not on main':'target-not-main','target repo is dirty':'target-dirty','bundle too large':'bundle-too-large','bundle head mismatch':'bundle-head-mismatch','target changed during import':'target-changed','git directory changed during import':'git-directory-changed','target refs changed during import':'target-refs-changed','target head differs from mirror':'target-head-mismatch'}
def failure(kind,value,traceback):
 reason=errors.get(str(value),'unexpected-failure') if isinstance(value,ValueError) else 'unexpected-failure'
 if isinstance(value,OSError): reason={13:'permission-denied',1:'permission-denied',20:'not-directory',40:'symlink',2:'missing'}.get(value.errno,'filesystem-error')
 if isinstance(value,subprocess.TimeoutExpired): reason='timeout'
 if isinstance(value,ValueError) and str(value).startswith('repo import git operation failed: '): reason='git-failed'
 sys.stderr.write('ZS_RUNTIME_IMPORT_ERROR '+json.dumps({'stage':operation,'reason':reason})+'\\n')
sys.excepthook=failure
repo,expected=sys.argv[1:]
if len(expected)!=40 or any(c not in '0123456789abcdef' for c in expected): raise ValueError('invalid head')
fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
for component in repo.strip('/').split('/'):
 child=os.open(component,getattr(os,'O_PATH',os.O_RDONLY)|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
 os.close(fd); fd=child
if os.fstat(fd).st_uid!=os.geteuid(): raise ValueError('repo owner mismatch')
os.fchdir(fd)
operation='open-git'
gitfd=os.open('.git',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
if os.fstat(gitfd).st_uid!=os.geteuid(): raise ValueError('git owner mismatch')
operation='lock'
lockfd=os.open('.runtime-switch.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600,dir_fd=gitfd)
if os.fstat(lockfd).st_uid!=os.geteuid(): raise ValueError('lock owner mismatch')
fcntl.flock(lockfd,fcntl.LOCK_EX)
env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'HOME':os.environ.get('HOME',''),'GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
def git(*args):
 global operation
 operation=args[0]
 result=subprocess.run(['git','-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',*args],env=env,capture_output=True,timeout=90)
 if result.returncode: raise ValueError('repo import git operation failed: '+args[0])
 return result.stdout.decode().strip()
if git('symbolic-ref','--short','HEAD')!='main': raise ValueError('target is not on main')
if git('status','--porcelain'): raise ValueError('target repo is dirty')
initial=git('rev-parse','HEAD')
def only_main(): return git('for-each-ref','--format=%(refname)')=='refs/heads/main'
pristine=git('rev-list','--count','HEAD')=='1' and git('log','-1','--format=%B%x00') in tuple(message+chr(10)+chr(0) for message in ('chore: initialize brand memory repo','chore: initialize brand memory')) and only_main()
operation='stage-bundle'
stage=tempfile.mkdtemp(prefix='.runtime-import-',dir='.git')
try:
 bundle=os.path.join(stage,'repo.bundle')
 with open(bundle,'xb') as target:
  remaining=67108864
  while True:
   data=sys.stdin.buffer.read(min(1048576,remaining+1))
   if not data: break
   remaining-=len(data)
   if remaining<0: raise ValueError('bundle too large')
   target.write(data)
 git('bundle','verify',bundle)
 git('fetch','--no-tags',bundle,'refs/heads/main')
 if git('rev-parse','FETCH_HEAD')!=expected: raise ValueError('bundle head mismatch')
 if git('rev-parse','HEAD')!=initial or git('status','--porcelain'): raise ValueError('target changed during import')
 if os.stat('.git',follow_symlinks=False).st_ino!=os.fstat(gitfd).st_ino: raise ValueError('git directory changed during import')
 if pristine:
  if not only_main(): raise ValueError('target refs changed during import')
  git('update-ref','refs/heads/main',expected,initial)
  git('reset','--hard',expected)
 else: git('merge','--ff-only','--no-edit',expected)
 actual=git('rev-parse','HEAD')
 if actual!=expected: raise ValueError('target head differs from mirror')
 print(json.dumps({'head':actual}))
finally:
 try: os.unlink(os.path.join(stage,'repo.bundle'))
 except FileNotFoundError: pass
 os.rmdir(stage)
`;

function importFailure(stderr: string, code: number | null): string {
  const marker = stderr.match(/^ZS_RUNTIME_IMPORT_ERROR (\{[^\r\n]{1,200}\})$/m)?.[1];
  if (marker) {
    try {
      const { stage, reason } = JSON.parse(marker) as { stage?: unknown; reason?: unknown };
      if (typeof stage === "string" && IMPORT_STAGES.includes(stage) && typeof reason === "string" && IMPORT_REASONS.includes(reason)) return `${stage}: ${reason}`;
    } catch {}
  }
  return code === 127 ? "remote-command-unavailable" : code === 255 ? "ssh-failed" : "unclassified-import-failure";
}

export async function syncRuntimeRepo(input: {
  brandId: string;
  mirrorDir: string;
  run(command: string, options: { stdin: Buffer; timeoutMs: number }): Promise<ExecResult>;
  repo?: string;
}): Promise<{ mirrorHead: string; targetHead: string }> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(input.brandId)) throw new Error("invalid brand id");
  const mirror = path.join(input.mirrorDir, `${input.brandId}.git`);
  const git = async (args: string[], maxBuffer = 1024 * 1024) => execFileAsync("git", ["--git-dir", mirror, "-c", "core.hooksPath=/dev/null", ...args], {
    encoding: "buffer", maxBuffer, timeout: 120_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
  });
  const mirrorHead = (await git(["rev-parse", "--verify", "refs/heads/main"])).stdout.toString().trim();
  if (!SHA.test(mirrorHead)) throw new Error("mirror has no main head");
  const bundle = (await git(["bundle", "create", "-", "refs/heads/main"], MAX_BUNDLE_BYTES)).stdout;
  const repo = input.repo ?? brandPaths(input.brandId).repo;
  const result = await input.run(`python3 -I -c ${shellQuote(RUNTIME_REPO_IMPORT)} ${shellQuote(repo)} ${mirrorHead}`, { stdin: bundle, timeoutMs: 240_000 });
  if (result.code !== 0) throw new Error(`target repo import refused (${importFailure(result.stderr, result.code)}); provider unchanged`);
  const targetHead = (JSON.parse(result.stdout.trim()) as { head?: unknown }).head;
  if (targetHead !== mirrorHead) throw new Error("target repo head differs from mirror");
  return { mirrorHead, targetHead: mirrorHead };
}
