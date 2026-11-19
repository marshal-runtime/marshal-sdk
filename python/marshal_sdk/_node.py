"""The Node side of marshal_sdk: Node itself, the marshal-sdk npm package, the marshal-claude bridge and a Chromium.

The Python package carries all of it, so a caller needs nothing but the dependency line:

- Node 24 comes from the ``nodejs-wheel-binaries`` wheel (a dependency).
- The marshal-sdk npm package, with the Brain packed inside, ships as ``_bundle/marshal-sdk.tgz``; Page Studio and any
  other extension come from the caller's marshal-sdk.json.
  Building the wheel installs it into ``_bundle/install`` (hatch_build.py); when that could not run (no registry at
  build time), the first query installs it into a per-user cache instead.
- The bridge is a small shell script next to that install that runs ``marshal-claude`` on this Node.

Environment overrides: MARSHAL_SDK_NODE (a node binary), MARSHAL_SDK_HOME (an installed @marshal/sdk folder),
MARSHAL_SDK_CACHE (the cache folder), MARSHAL_SDK_CHROME (read by marshal-sdk itself).
"""

from __future__ import annotations

import glob
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

NODE_ENV_VAR = "MARSHAL_SDK_NODE"
HOME_ENV_VAR = "MARSHAL_SDK_HOME"
CACHE_ENV_VAR = "MARSHAL_SDK_CACHE"
CHROME_ENV_VAR = "MARSHAL_SDK_CHROME"
BUNDLE_DIR = Path(__file__).resolve().parent / "_bundle"
TARBALL = BUNDLE_DIR / "marshal-sdk.tgz"
BUILT_INSTALL = BUNDLE_DIR / "install"
SDK_PACKAGE = Path("node_modules") / "@marshal" / "sdk"
CLI = Path("dist") / "src" / "cli.js"
BRIDGE = Path("dist") / "src" / "claude-bridge-cli.js"
# Native binaries of runtimes Page Studio never starts (Codex alone is ~330 MB per platform).
PRUNED = ("@openai/codex-*",)


class MarshalNotInstalledError(RuntimeError):
    """No Node or no marshal-sdk npm package could be found or installed."""


def node() -> str:
    """Node 24: $MARSHAL_SDK_NODE, the nodejs-wheel-binaries wheel's, else node on PATH."""
    given = os.environ.get(NODE_ENV_VAR)
    if given:
        return given
    try:
        import nodejs_wheel

        bundled = Path(nodejs_wheel.__file__).parent / "bin" / ("node.exe" if sys.platform == "win32" else "node")
        if bundled.is_file():
            return str(bundled)
    except ImportError:
        pass
    on_path = shutil.which("node")
    if on_path:
        return on_path
    raise MarshalNotInstalledError("No Node: install nodejs-wheel-binaries (a marshal-sdk dependency) or set MARSHAL_SDK_NODE.")


def npm_command(node_binary: str) -> list[str]:
    """npm on the given Node: the nodejs wheel's npm-cli.js, else npm on PATH."""
    cli = Path(node_binary).resolve().parent.parent / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if cli.is_file():
        return [node_binary, str(cli)]
    on_path = shutil.which("npm")
    if on_path:
        return [on_path]
    raise MarshalNotInstalledError(f"No npm next to {node_binary} and none on PATH.")


def install(tarball: Path, prefix: Path, node_binary: str) -> Path:
    """Installs the marshal-sdk tarball (and its registry dependencies) under prefix; returns the package folder."""
    prefix.mkdir(parents=True, exist_ok=True)
    (prefix / "package.json").write_text('{"name": "marshal-sdk-install", "private": true}\n', encoding="utf-8")
    env = {**os.environ, "PATH": f"{Path(node_binary).parent}{os.pathsep}{os.environ.get('PATH', '')}"}
    subprocess.run(
        [*npm_command(node_binary), "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error", str(tarball)],
        cwd=prefix, env=env, check=True, stdout=subprocess.DEVNULL,
    )
    for pattern in PRUNED:
        for found in glob.glob(str(prefix / "node_modules" / pattern)):
            shutil.rmtree(found, ignore_errors=True)
    # npm's .bin symlinks are not used (the CLI runs as `node cli.js`) and a wheel cannot hold symlinks.
    for found in glob.glob(str(prefix / "**" / ".bin"), recursive=True):
        shutil.rmtree(found, ignore_errors=True)
    return prefix / SDK_PACKAGE


def cache_dir() -> Path:
    given = os.environ.get(CACHE_ENV_VAR)
    if given:
        return Path(given)
    home = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    try:
        home.mkdir(parents=True, exist_ok=True)
        if os.access(home, os.W_OK):
            return home / "marshal-sdk"
    except OSError:
        pass
    return Path(tempfile.gettempdir()) / f"marshal-sdk-{os.getuid() if hasattr(os, 'getuid') else 'user'}"


def _tarball_digest() -> str:
    return hashlib.sha256(TARBALL.read_bytes()).hexdigest()[:16]


def sdk_home() -> Path:
    """The installed @marshal/sdk folder: $MARSHAL_SDK_HOME, the wheel's own install, else one made in the cache."""
    given = os.environ.get(HOME_ENV_VAR)
    if given:
        return Path(given)
    built = BUILT_INSTALL / SDK_PACKAGE
    if (built / CLI).is_file():
        return built
    if not TARBALL.is_file():
        raise MarshalNotInstalledError("This marshal_sdk carries no marshal-sdk tarball; set MARSHAL_SDK_HOME.")
    prefix = cache_dir() / _tarball_digest()
    package = prefix / SDK_PACKAGE
    if (package / CLI).is_file():
        return package
    import fcntl

    prefix.parent.mkdir(parents=True, exist_ok=True)
    with open(prefix.parent / f"{prefix.name}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not (package / CLI).is_file():
            staging = Path(tempfile.mkdtemp(prefix=f"{prefix.name}-", dir=prefix.parent))
            install(TARBALL, staging, node())
            shutil.rmtree(prefix, ignore_errors=True)
            staging.rename(prefix)
    return package


def cli_command() -> list[str]:
    """The marshal-sdk CLI on this package's Node."""
    return [node(), str(sdk_home() / CLI)]


def bridge() -> str:
    """An executable that runs marshal-claude on this package's Node (claude_agent_sdk's cli_path)."""
    script = sdk_home() / BRIDGE
    binary = node()
    digest = hashlib.sha256(f"{binary}\0{script}".encode()).hexdigest()[:12]
    wrapper = cache_dir() / "bin" / f"marshal-claude-{digest}"
    if not wrapper.is_file():
        wrapper.parent.mkdir(parents=True, exist_ok=True)
        temporary = wrapper.with_name(f"{wrapper.name}.{os.getpid()}")
        temporary.write_text(f'#!/bin/sh\nexec "{binary}" "{script}" "$@"\n', encoding="utf-8")
        temporary.chmod(0o755)
        temporary.replace(wrapper)
    return str(wrapper)


def chrome() -> str | None:
    """A Playwright Chromium already on this machine (Linux), for Page Studio's renders: the newest revision under
    $PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright. None elsewhere (marshal-sdk finds the Mac's Chrome itself)."""
    if os.environ.get(CHROME_ENV_VAR) or not sys.platform.startswith("linux"):
        return None
    roots = [os.environ.get("PLAYWRIGHT_BROWSERS_PATH"), str(Path.home() / ".cache" / "ms-playwright")]
    for root in filter(None, roots):
        found = sorted(glob.glob(os.path.join(root, "chromium-*", "chrome-linux*", "chrome")), key=_revision, reverse=True)
        if found:
            return found[0]
    return None


def _revision(path: str) -> int:
    name = Path(path).parent.parent.name
    digits = name.rsplit("-", 1)[-1]
    return int(digits) if digits.isdigit() else 0


def tool_env() -> dict[str, str]:
    """What the Node processes need in their environment: this Node first on PATH, and a Chromium when one is found."""
    binary = node()
    env = {"PATH": f"{Path(binary).parent}{os.pathsep}{os.environ.get('PATH', '')}", NODE_ENV_VAR: binary}
    found = chrome()
    if found:
        env[CHROME_ENV_VAR] = found
    return env
