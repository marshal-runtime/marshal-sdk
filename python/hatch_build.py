"""Building the wheel installs the marshal-sdk npm package it carries, so the installed package runs with no npm step.

marshal_sdk/_bundle/marshal-sdk.tgz (image/pack.mjs: marshal-sdk with its runtime packs and the Brain) is
installed with the Node of the nodejs-wheel-binaries build requirement into marshal_sdk/_bundle/install. That needs
the npm registry for the packs' third-party dependencies and makes the wheel platform-specific. When the install
cannot run (no registry), the wheel is built without it and the first query installs the tarball into a per-user
cache instead (marshal_sdk/_node.py). MARSHAL_SDK_SKIP_NODE_INSTALL=1 skips it on purpose.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

SKIP_ENV_VAR = "MARSHAL_SDK_SKIP_NODE_INSTALL"


def _load_node_module(root: Path):
    spec = importlib.util.spec_from_file_location("_marshal_sdk_node", root / "marshal_sdk" / "_node.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class NodeBundleHook(BuildHookInterface):
    PLUGIN_NAME = "custom"

    def initialize(self, version: str, build_data: dict) -> None:
        if self.target_name != "wheel" or version == "editable" or os.environ.get(SKIP_ENV_VAR) == "1":
            return
        root = Path(self.root)
        tarball = root / "marshal_sdk" / "_bundle" / "marshal-sdk.tgz"
        if not tarball.is_file():
            return
        node_module = _load_node_module(root)
        self._staging = Path(tempfile.mkdtemp(prefix="marshal-sdk-node-"))
        try:
            node_module.install(tarball, self._staging, node_module.node())
        except Exception as error:  # the wheel still works: the first query installs the tarball itself
            print(f"marshal-sdk: the bundled npm install did not run ({error}); it will run on first use", file=sys.stderr)
            return
        build_data["force_include"][str(self._staging)] = "marshal_sdk/_bundle/install"
        build_data["pure_python"] = False
        build_data["infer_tag"] = True

    def finalize(self, version: str, build_data: dict, artifact_path: str) -> None:
        staging = getattr(self, "_staging", None)
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
