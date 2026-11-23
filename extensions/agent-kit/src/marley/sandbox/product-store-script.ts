// Extract of zygstinct apps/agent-server/src/sandbox/product-store-script.ts at 7110e58c8: only RECOVER_PRODUCT_MANIFEST.
/**
 * Python shared by the two maintenance scripts that touch `memory/products/.zs-generated.json`: the sync (brand-vm.ts) and the recovery that
 * runs before the root chat setup (ssh.ts). Both run as the maintenance identity.
 *
 * `valid` is the ownership map rule of the reader in `zs-product-store.mjs`: version 1 (a number, not `true`), an object of at most 200
 * entries, every name `[a-z0-9-]{1,80}.md` and every hash 64 lower-case hex digits. One bad entry makes the whole map invalid, so nothing is
 * salvaged from it. `sound` is the reader's file rule: a regular file with one link, owned by this identity, mode exactly 0640.
 *
 * Exclusion. `take_lock` opens (or creates) `<brand home>/.zs-products.lock` (the repo's parent, never a path inside the repo) as a
 * maintenance-owned regular, single-link file, forces mode 0600 and takes `flock(LOCK_EX)`. Both scripts take it right after they open the
 * products folder and hold it, through their descriptor, until the process exits: across the ownership-map read, every note change and
 * every manifest publication. The lock is outside the products folder because the root chat setup re-owns every file in that folder
 * (group = brand group, mode 0640), which would let a chat identity open the lock and hold it. In the home (0710, not writable by the
 * group) the 0600 file is unreadable to chat identities and cannot be replaced by them. Waiting is bounded (5 s, then exit 13) so a stuck
 * holder fails the run, and the next chat or the five-minute retry tries again.
 *
 * Cutover. A script of an older server takes no lock, and a lock cannot serialize a process that does not take it. So after it holds the
 * lock the script waits (5 s, then exit 13 without touching anything) until no other process of this identity is running whose command
 * line names `.zs-generated.json` but not the lock: the scripts travel as `python3 -c <script>`, so every new script's command line
 * carries the lock name and every older one's does not. A lock-less writer that is already running therefore finishes before a new script
 * reads or writes, and the recovery checks again right before its rename. What this cannot rule out is an older server starting a new
 * lock-less writer in the instant between that last check and the rename; that stays until the older servers are drained, and a deployment
 * should drain them before relying on the lock (the stamp check and exit 12 remain as the second line). Where /proc is unavailable the scan
 * finds nothing.
 */
export const PRODUCT_STORE_PRELUDE = `import os,sys,json,re,hashlib,stat,time,fcntl
NAME=re.compile(r'[a-z0-9-]{1,80}\\.md')
HEX=re.compile(r'[0-9a-f]{64}')
MANIFEST='.zs-generated.json'
MANIFEST_LIMIT=131072
MAX_FILES=200
LOCK='.zs-products.lock'
LOCK_WAIT=5
LEGACY_WAIT=5
digest=lambda b: hashlib.sha256(b).hexdigest()
me=os.geteuid()
sound=lambda i: i is not None and stat.S_ISREG(i.st_mode) and i.st_nlink==1 and i.st_uid==me and stat.S_IMODE(i.st_mode)==0o640
def valid(m):
 if not isinstance(m,dict) or type(m.get('v')) is not int or m['v']!=1: return False
 files=m.get('files')
 return isinstance(files,dict) and len(files)<=MAX_FILES and all(NAME.fullmatch(k) and isinstance(v,str) and HEX.fullmatch(v) for k,v in files.items())
class Changed(Exception): pass
def lockless():
 found=[]
 try: names=os.listdir('/proc')
 except OSError: return found
 for name in names:
  if not name.isdigit() or int(name)==os.getpid(): continue
  try:
   if os.stat('/proc/'+name).st_uid!=me: continue
   with open('/proc/'+name+'/cmdline','rb') as stream: line=stream.read(262144)
  except OSError: continue
  if MANIFEST.encode() in line and LOCK.encode() not in line: found.append(int(name))
 return found
def take_lock(repo):
 home=os.open(os.path.dirname(repo.rstrip('/')),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 lock=os.open(LOCK,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600,dir_fd=home)
 info=os.fstat(lock)
 if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=me: sys.exit(14)
 os.fchmod(lock,0o600)
 os.close(home)
 limit=time.time()+LOCK_WAIT
 while True:
  try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); break
  except BlockingIOError:
   if time.time()>limit: sys.exit(13)
   time.sleep(0.02)
 limit=time.time()+LEGACY_WAIT
 while lockless():
  if time.time()>limit: sys.exit(13)
  time.sleep(0.05)
 return lock
def stamp(fd,name):
 try: i=os.stat(name,dir_fd=fd,follow_symlinks=False)
 except FileNotFoundError: return None
 return (i.st_dev,i.st_ino,i.st_mode,i.st_nlink,i.st_uid,i.st_size,i.st_mtime_ns,i.st_ctime_ns)
def put(fd,name,data,unchanged=None):
 tmp='.replace.'+os.urandom(8).hex()
 out=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o640,dir_fd=fd)
 try:
  with os.fdopen(out,'wb') as stream:
   os.fchmod(stream.fileno(),0o640)
   stream.write(data)
   stream.flush()
   mine=os.fstat(stream.fileno())
  seen=os.stat(tmp,dir_fd=fd,follow_symlinks=False)
  if (seen.st_dev,seen.st_ino)!=(mine.st_dev,mine.st_ino) or not sound(seen) or seen.st_size!=len(data): raise OSError(1,'temporary file changed before the rename')
  if unchanged is not None and not unchanged(): raise Changed()
  os.rename(tmp,name,src_dir_fd=fd,dst_dir_fd=fd)
 except BaseException:
  try: os.unlink(tmp,dir_fd=fd)
  except OSError: pass
  raise
def look(fd,name,limit):
 try: f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 except FileNotFoundError: return None
 except OSError: return (None,None)
 info=os.fstat(f)
 if not stat.S_ISREG(info.st_mode):
  os.close(f); return (info,None)
 with os.fdopen(f,'rb') as stream: return (info,stream.read(limit))
def publish(fd,files,unchanged=None): put(fd,MANIFEST,json.dumps({'v':1,'files':files},sort_keys=True).encode('utf-8'),unchanged)
def read_map(fd):
 seen=look(fd,MANIFEST,MANIFEST_LIMIT+1)
 if seen is None: return (None,None,False)
 info,body=seen
 if sound(info) and info.st_size<=MANIFEST_LIMIT and body is not None:
  try: manifest=json.loads(body.decode('utf-8'))
  except ValueError: manifest=None
  if valid(manifest): return (manifest['files'],info,True)
 return (None,info,True)
def open_store(repo):
 fd=os.open(repo,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 for name in ['memory','products']:
  try: child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  except FileNotFoundError: os.close(fd); return None
  os.close(fd); fd=child
 return fd
`;

/**
 * Run as the maintenance identity before the root chat setup, which refuses an unsafe ownership manifest. When the manifest is missing or
 * already usable it does nothing. When it is present but not usable (wrong owner, mode, links, type, size or map) it publishes a trusted
 * empty map in its place. It never reads, adopts, rewrites or deletes a note, and it leaves the folder's owner to the root setup.
 * A folder that group or others can write is closed first (fchmod 2750, the mode the root setup gives it): until then a chat identity
 * of the brand group holding a descriptor of the folder could swap its own file for the temporary one before the rename. Every write
 * goes through put(), which creates the temporary file exclusively with no-follow, descriptor-relative calls and checks its identity
 * (same inode, regular, one link, this owner, mode 0640, expected size) right before the rename.
 *
 * The recovery decides only from the map it reads after it holds the lock (the stamp is taken and the map read inside the lock), never
 * from one read earlier, so a recovery that waited for the lock finds the newer map of the writer that ran meanwhile and leaves it.
 * It judged the manifest unusable from one reading, so it publishes only if the manifest is still exactly what it read: the stamp of the
 * manifest entry (device, inode, mode, links, owner, size, mtime, ctime) taken before the reading is compared again right before the
 * rename. A writer that published a valid manifest in between (another chat's recovery run, the product writer, a second server process)
 * changes the inode, so the recovery drops its empty map, removes its temporary file and exits 12 without writing. Prints one word:
 * absent, none, ok, replaced, changed; exits 9 when the folder belongs to someone else, 10 when a directory sits at the manifest name,
 * 11 when the folder cannot be closed and 12 when the manifest changed before the rename.
 */
export const RECOVER_PRODUCT_MANIFEST = `${PRODUCT_STORE_PRELUDE}try:
 fd=open_store(sys.argv[1])
 if fd is None: print('absent'); sys.exit(0)
 held=take_lock(sys.argv[1])
 folder=os.fstat(fd)
 if folder.st_uid!=me: sys.exit(9)
 if folder.st_mode&0o022:
  os.fchmod(fd,0o2750)
  if os.fstat(fd).st_mode&0o022: sys.exit(11)
 before=stamp(fd,MANIFEST)
 files,info,present=read_map(fd)
 if not present: print('none'); sys.exit(0)
 if files is not None: print('ok'); sys.exit(0)
 if info is not None and stat.S_ISDIR(info.st_mode): sys.exit(10)
 publish(fd,{},lambda: stamp(fd,MANIFEST)==before and not lockless())
 print('replaced')
except Changed: print('changed'); sys.exit(12)
except OSError: sys.exit(4)
`;
